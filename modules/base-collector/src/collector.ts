import type { BaseCollectorSettings } from "../settings.js";
import type { Checkpoint, CheckpointStore } from "./checkpoint.js";
import { classify, hexToNumber } from "./decode.js";
import { IdentityLedger } from "./ledger.js";
import { isRecord, stderrLogger, systemClock, type Bus, type Clock, type HttpRpc, type Logger, type WsFactory, type WsLike } from "./ports.js";
import {
  PERSISTER,
  RECOVER,
  SEAL_BACKFILL,
  SEAL_LIVE,
  STATUS,
  buildFilters,
  decodeJson,
  encodeJson,
  filterDigest,
  hookSuites,
  logSubject,
  sealDigest,
  type LogFilter,
} from "./subjects.js";
import { PoolTracker } from "./tracker.js";
import type {
  CollectorStatus,
  Decoded,
  DecodedInitialize,
  DeliveryPath,
  LogRecord,
  PersisterHeartbeat,
  RawLog,
  RecoverRequest,
  Recovery,
  SealRecord,
} from "./types.js";

export type CollectorDeps = {
  bus: Bus;
  rpc: HttpRpc;
  ws: WsFactory;
  checkpoints: CheckpointStore;
  clock?: Clock;
  log?: Logger;
};

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

const COUNTERS = [
  "liveRecords",
  "liveRemovals",
  "backfillRecords",
  "backfillRemovals",
  "duplicatesLive",
  "duplicatesBackfill",
  "staleLive",
  "outOfFilter",
  "undecodable",
  "malformed",
  "publishErrors",
  "seals",
  "sealHashConflicts",
  "connects",
  "disconnects",
  "rateAlerts",
  "recoverRequests",
  "recoverErrors",
  "checkpointErrors",
] as const;
type Counter = (typeof COUNTERS)[number];

function isInitialize(d: Decoded | null): d is DecodedInitialize {
  return d !== null && "hooks" in d;
}

function asRawLog(x: unknown): RawLog | null {
  if (!isRecord(x)) return null;
  const s = (k: string) => typeof x[k] === "string";
  if (!s("address") || !s("data") || !s("blockNumber") || !s("blockHash") || !s("transactionHash") || !s("transactionIndex") || !s("logIndex")) return null;
  if (!Array.isArray(x.topics) || !x.topics.every((t) => typeof t === "string")) return null;
  return x as unknown as RawLog;
}

function hex(n: number): string {
  return `0x${n.toString(16)}`;
}

/**
 * Persistent raw-first collector.
 *
 * Live path: one WebSocket with two `eth_subscribe("logs")` filters (PoolManager Initialize/Swap,
 * o1 factories) and `newHeads`. Each log is classified, deduplicated by identity state and
 * published synchronously inside the message handler; nothing is awaited before publication.
 *
 * Realtime recovery: on every (re)connect, after the subscriptions are confirmed, the collector
 * reads the node head H0 and replays `eth_getLogs` from `verifiedBlock + 1 - overlapBlocks` to H0
 * onto `.backfill` subjects. Identities already published are skipped, identities the node no
 * longer returns are published as removals, and only then does the checkpoint advance again.
 *
 * Persistence recovery: the persister owns its own contiguous acknowledged block and asks for a
 * republish of a range over `ctl.recover`; that path also uses `.backfill` subjects and seals.
 */
export class Collector {
  readonly counters: Record<Counter, number>;
  readonly digest: string;
  readonly filters: LogFilter[];

  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly ledger = new IdentityLedger();
  private readonly tracker: PoolTracker;
  private readonly factories: Map<string, string>;
  private readonly hooks: Map<string, string | null>;

  private epoch = 0;
  private seq = 0;
  private gen = 0;
  private socket: WsLike | null = null;
  private nextWsId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subs = new Map<string, "logs" | "heads">();
  private connected = false;
  private reconciled = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  private headBlock: number | null = null;
  private readonly headHashes = new Map<number, string>();
  private verifiedBlock: number | null = null;
  private trackedSinceBlock: number | null = null;
  private pendingSwaps: Array<{ log: RawLog; receivedAtMs: number }> = [];
  private untrackedSwaps = 0;
  private pendingSwapsDropped = 0;
  private backfillTruncatedBlocks = 0;

  private startedAtMs = 0;
  private heartbeat: { atMs: number; hb: PersisterHeartbeat } | null = null;
  private persistenceState: CollectorStatus["persistence"]["state"] = "unknown";
  private readonly recoverQueue: RecoverRequest[] = [];
  private recovering = false;
  private lastCheckpointMs = 0;
  private saving: Promise<void> | null = null;
  private rateSec = 0;
  private rateCount = 0;

  constructor(
    private readonly cfg: BaseCollectorSettings,
    private readonly deps: CollectorDeps,
  ) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? stderrLogger;
    this.counters = Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<Counter, number>;
    this.filters = buildFilters(cfg);
    this.digest = filterDigest(cfg);
    this.hooks = hookSuites(cfg);
    this.factories = new Map(cfg.suites.map((s) => [s.factory, s.name]));
    this.tracker = new PoolTracker(this.hooks, new Set(cfg.extraPoolIds), cfg.maxTrackedPools, cfg.poolIdleBlocks);
  }

  get verified(): number | null {
    return this.verifiedBlock;
  }

  get isReconciled(): boolean {
    return this.reconciled;
  }

  async start(): Promise<void> {
    const cp = await this.deps.checkpoints.load();
    if (cp !== null && cp.filterDigest !== this.digest) {
      throw new Error(
        `checkpoint filter digest ${cp.filterDigest} differs from configured ${this.digest}; the checkpoint does not cover the new filter (move it aside to start a new coverage period)`,
      );
    }
    this.epoch = Math.max(this.clock.nowMs(), (cp?.epoch ?? 0) + 1);
    if (cp !== null) {
      this.verifiedBlock = cp.verifiedBlock;
      this.trackedSinceBlock = cp.trackedSinceBlock;
      this.tracker.restore(cp.pools);
    }
    await this.deps.checkpoints.save(this.checkpoint());
    this.startedAtMs = this.clock.nowMs();
    this.deps.bus.subscribe(RECOVER, (d) => this.onRecover(d));
    this.deps.bus.subscribe(PERSISTER, (d) => this.onHeartbeat(d));
    this.statusTimer = setInterval(() => this.publishStatus(), this.cfg.statusIntervalMs);
    this.log("info", "base-collector starting", { epoch: this.epoch, verifiedBlock: this.verifiedBlock, filterDigest: this.digest });
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.gen += 1;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.statusTimer !== null) clearInterval(this.statusTimer);
    this.socket?.close();
    this.socket = null;
    this.rejectPending("stopped");
    if (this.saving !== null) await this.saving;
    await this.deps.checkpoints.save(this.checkpoint());
  }

  // ---- WebSocket lifecycle -------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    const gen = ++this.gen;
    this.connected = false;
    this.reconciled = false;
    this.subs.clear();
    this.socket = this.deps.ws(this.cfg.wsUrl, {
      onOpen: () => {
        if (gen === this.gen) void this.onOpen(gen);
      },
      onMessage: (text) => {
        if (gen === this.gen) this.handleMessage(text);
      },
      onClose: (reason) => {
        if (gen === this.gen) this.onDisconnect(reason);
      },
    });
  }

  private async onOpen(gen: number): Promise<void> {
    try {
      for (const f of this.filters) {
        const id = await this.wsCall("eth_subscribe", ["logs", f]);
        if (gen !== this.gen) return;
        this.subs.set(String(id), "logs");
      }
      const heads = await this.wsCall("eth_subscribe", ["newHeads"]);
      if (gen !== this.gen) return;
      this.subs.set(String(heads), "heads");
      this.connected = true;
      this.reconnectAttempt = 0;
      this.counters.connects += 1;
      await this.reconcile(gen);
      if (gen === this.gen) void this.drainRecover();
    } catch (e) {
      if (gen !== this.gen) return;
      this.log("error", "connect/reconcile failed", { error: e instanceof Error ? e.message : String(e) });
      this.onDisconnect("setup failed");
    }
  }

  private onDisconnect(reason: string): void {
    this.gen += 1;
    this.connected = false;
    this.reconciled = false;
    this.counters.disconnects += 1;
    this.socket?.close();
    this.socket = null;
    this.rejectPending(reason);
    this.publishStatus();
    if (this.stopped) return;
    const delay = Math.min(this.cfg.reconnectMaxMs, this.cfg.reconnectBaseMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.log("warn", "websocket disconnected", { reason, reconnectInMs: delay, verifiedBlock: this.verifiedBlock });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private wsCall(method: string, params: unknown[]): Promise<unknown> {
    const sock = this.socket;
    if (sock === null) return Promise.reject(new Error("not connected"));
    const id = this.nextWsId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.cfg.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sock.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private rejectPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  // ---- Hot path ------------------------------------------------------------------------------

  /** Synchronous WebSocket message handler. Publication happens before this returns. */
  handleMessage(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.counters.malformed += 1;
      return;
    }
    if (!isRecord(msg)) return;
    if (msg.method === "eth_subscription" && isRecord(msg.params)) {
      const kind = this.subs.get(String(msg.params.subscription));
      if (kind === "logs") {
        const log = asRawLog(msg.params.result);
        if (log === null) this.counters.malformed += 1;
        else this.ingest(log, "live", null);
      } else if (kind === "heads" && isRecord(msg.params.result)) {
        this.onHead(msg.params.result);
      }
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (isRecord(msg.error)) p.reject(new Error(String(msg.error.message)));
      else p.resolve(msg.result);
    }
  }

  /**
   * Classify, apply the identity state transition and publish. Returns the published record, or
   * null when filtered or a duplicate. `force` republishes the current state (persister recovery).
   */
  ingest(log: RawLog, path: DeliveryPath, recovery: Recovery, opts: { force?: boolean; receivedAtMs?: number } = {}): LogRecord | null {
    const receivedAtMs = opts.receivedAtMs ?? this.clock.nowMs();
    const c = classify(log, this.cfg.poolManager, this.factories);
    if (c === null) {
      this.counters.outOfFilter += 1;
      return null;
    }
    const blockNumber = hexToNumber(log.blockNumber);
    const logIndex = hexToNumber(log.logIndex);
    const blockHash = log.blockHash.toLowerCase();
    const removed = log.removed === true;
    let suite = c.suite;
    if (c.decoded === null) this.counters.undecodable += 1;
    if (c.kind === "initialize" && isInitialize(c.decoded)) {
      suite = this.hooks.get(c.decoded.hooks) ?? null;
      if (!removed) this.tracker.add(c.decoded.poolId, c.decoded.hooks, blockNumber);
    }
    if (c.kind === "swap") {
      const poolId = log.topics[1]?.toLowerCase();
      if (poolId === undefined || !this.tracker.has(poolId)) {
        if (poolId !== undefined && path === "live" && !this.reconciled) this.bufferSwap(log, receivedAtMs);
        else if (poolId === undefined || !this.tracker.noteUntracked(poolId)) this.untrackedSwaps += 1;
        return null;
      }
      this.tracker.touch(poolId, blockNumber);
      suite = this.tracker.suiteOf(poolId);
    }
    let p = path;
    let r = recovery;
    if (p === "live" && this.verifiedBlock !== null && blockNumber < this.verifiedBlock - this.cfg.retainBlocks) {
      // Below the dedupe window: never publish as live.
      p = "backfill";
      r = "stale";
      this.counters.staleLive += 1;
    }
    const id = `${blockHash}:${logIndex}`;
    if (this.ledger.transition(id, blockNumber, blockHash, !removed) === "duplicate" && opts.force !== true) {
      if (p === "live") this.counters.duplicatesLive += 1;
      else this.counters.duplicatesBackfill += 1;
      return null;
    }
    const rec: LogRecord = {
      v: 1,
      type: "log",
      id,
      kind: c.kind,
      path: p,
      realtime: p === "live",
      recovery: p === "live" ? null : r,
      removed,
      epoch: this.epoch,
      seq: ++this.seq,
      blockNumber,
      blockHash,
      txHash: log.transactionHash.toLowerCase(),
      txIndex: hexToNumber(log.transactionIndex),
      logIndex,
      address: log.address.toLowerCase(),
      topics: log.topics,
      data: log.data,
      decoded: c.decoded,
      suite,
      receivedAtMs,
    };
    this.publish(logSubject(rec.kind, p, removed), rec);
    this.ledger.remember(rec);
    if (p === "live") this.counters[removed ? "liveRemovals" : "liveRecords"] += 1;
    else this.counters[removed ? "backfillRemovals" : "backfillRecords"] += 1;
    return rec;
  }

  private publish(subject: string, payload: unknown): void {
    try {
      this.deps.bus.publish(subject, encodeJson(payload));
    } catch (e) {
      this.counters.publishErrors += 1;
      this.log("error", "publish failed", { subject, error: e instanceof Error ? e.message : String(e) });
    }
    const sec = Math.floor(this.clock.nowMs() / 1000);
    if (sec !== this.rateSec) {
      this.rateSec = sec;
      this.rateCount = 0;
    }
    this.rateCount += 1;
    if (this.rateCount === this.cfg.rateAlertPerSec + 1) {
      this.counters.rateAlerts += 1;
      this.log("warn", "publish rate above rateAlertPerSec", { rateAlertPerSec: this.cfg.rateAlertPerSec });
    }
  }

  private bufferSwap(log: RawLog, receivedAtMs: number): void {
    if (this.pendingSwaps.length >= this.cfg.maxPendingSwaps) {
      this.pendingSwapsDropped += 1;
      return;
    }
    this.pendingSwaps.push({ log, receivedAtMs });
  }

  // ---- Heads, seals and checkpoint -----------------------------------------------------------

  private onHead(h: Record<string, unknown>): void {
    if (typeof h.number !== "string" || typeof h.hash !== "string") {
      this.counters.malformed += 1;
      return;
    }
    const n = hexToNumber(h.number);
    this.headHashes.set(n, h.hash.toLowerCase());
    if (this.headBlock === null || n > this.headBlock) this.headBlock = n;
    if (this.reconciled) this.advanceVerified();
  }

  private advanceVerified(): void {
    if (this.headBlock === null || this.verifiedBlock === null) return;
    const target = this.headBlock - this.cfg.confirmBlocks;
    let v: number = this.verifiedBlock;
    while (v < target) {
      v += 1;
      this.sealFromLedger(v);
      this.verifiedBlock = v;
    }
    const floor = v - this.cfg.retainBlocks;
    this.ledger.pruneBelow(floor);
    for (const b of [...this.headHashes.keys()]) if (b < floor) this.headHashes.delete(b);
    this.tracker.evictIdle(this.headBlock);
    this.maybeCheckpoint();
  }

  private sealFromLedger(b: number): void {
    const active = this.ledger.active(b);
    const hashes = new Set(active.map((a) => a.blockHash));
    let hash = this.headHashes.get(b) ?? null;
    if (hash === null && hashes.size === 1) hash = [...hashes][0] ?? null;
    if (hashes.size > 1 || (hash !== null && hashes.size === 1 && !hashes.has(hash))) this.counters.sealHashConflicts += 1;
    const ids = (hash === null ? active : active.filter((a) => a.blockHash === hash)).map((a) => a.id);
    this.publishSeal(b, hash, ids, "live", null);
  }

  private publishSeal(blockNumber: number, blockHash: string | null, ids: string[], path: DeliveryPath, recovery: Recovery): void {
    const seal: SealRecord = {
      v: 1,
      type: "seal",
      epoch: this.epoch,
      seq: ++this.seq,
      path,
      recovery,
      blockNumber,
      blockHash,
      count: ids.length,
      digest: sealDigest(ids),
    };
    this.publish(path === "live" ? SEAL_LIVE : SEAL_BACKFILL, seal);
    this.counters.seals += 1;
  }

  private checkpoint(): Checkpoint {
    return {
      version: 1,
      filterDigest: this.digest,
      epoch: this.epoch,
      verifiedBlock: this.verifiedBlock,
      trackedSinceBlock: this.trackedSinceBlock,
      pools: this.tracker.snapshot(),
    };
  }

  private maybeCheckpoint(): void {
    const now = this.clock.nowMs();
    if (this.saving !== null || now - this.lastCheckpointMs < this.cfg.checkpointIntervalMs) return;
    this.lastCheckpointMs = now;
    this.saving = this.deps.checkpoints
      .save(this.checkpoint())
      .catch((e: unknown) => {
        this.counters.checkpointErrors += 1;
        this.log("error", "checkpoint save failed", { error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        this.saving = null;
      });
  }

  // ---- Recovery ------------------------------------------------------------------------------

  /** Realtime recovery after the subscriptions are live. Exposed for tests. */
  async reconcile(gen: number = this.gen): Promise<void> {
    const h0 = hexToNumber(String(await this.deps.rpc.call("eth_blockNumber", [])));
    if (gen !== this.gen) return;
    if (this.headBlock === null || h0 > this.headBlock) this.headBlock = h0;
    let from: number;
    if (this.verifiedBlock === null) {
      from = this.cfg.startBlock ?? h0;
      this.trackedSinceBlock ??= from;
    } else {
      from = Math.max(this.verifiedBlock + 1 - this.cfg.overlapBlocks, this.trackedSinceBlock ?? 0);
    }
    from = Math.min(from, h0);
    const span = h0 - from + 1;
    if (span > this.cfg.maxBackfillBlocks) {
      const skipped = span - this.cfg.maxBackfillBlocks;
      this.backfillTruncatedBlocks += skipped;
      this.log("warn", "reconnect backfill truncated; coverage incomplete", { from, to: h0, skippedBlocks: skipped });
      from = h0 - this.cfg.maxBackfillBlocks + 1;
    }
    const ok = await this.backfill(from, h0, "reconnect", "reconcile", gen);
    if (!ok || gen !== this.gen) return;
    this.reconciled = true;
    const buffered = this.pendingSwaps;
    this.pendingSwaps = [];
    for (const b of buffered) this.ingest(b.log, "backfill", "pending_swap", { receivedAtMs: b.receivedAtMs });
    this.verifiedBlock = from - 1;
    this.advanceVerified();
    this.log("info", "reconciled", { from, to: h0, verifiedBlock: this.verifiedBlock });
    this.publishStatus();
  }

  private async getLogs(from: number, to: number): Promise<RawLog[]> {
    const out: RawLog[] = [];
    for (const f of this.filters) {
      const res = await this.deps.rpc.call("eth_getLogs", [{ ...f, fromBlock: hex(from), toBlock: hex(to) }]);
      if (!Array.isArray(res)) throw new Error("eth_getLogs returned a non-array");
      for (const x of res) {
        const log = asRawLog(x);
        if (log === null) throw new Error("eth_getLogs returned a malformed log");
        out.push(log);
      }
    }
    // Initialize before later Swaps of the same block: order by (blockNumber, logIndex).
    return out.sort((a, b) => hexToNumber(a.blockNumber) - hexToNumber(b.blockNumber) || hexToNumber(a.logIndex) - hexToNumber(b.logIndex));
  }

  private async backfill(from: number, to: number, recovery: Recovery, mode: "reconcile" | "republish", gen?: number): Promise<boolean> {
    for (let start = from; start <= to; start += this.cfg.backfillChunkBlocks) {
      const end = Math.min(to, start + this.cfg.backfillChunkBlocks - 1);
      const logs = await this.getLogs(start, end);
      if (gen !== undefined && gen !== this.gen) return false;
      const canonical = new Set<string>();
      const published = new Map<number, { hash: string; ids: string[] }>();
      for (const log of logs) {
        canonical.add(`${log.blockHash.toLowerCase()}:${hexToNumber(log.logIndex)}`);
        const rec = this.ingest(log, "backfill", recovery, { force: mode === "republish" });
        const known = rec ?? this.ledger.record(`${log.blockHash.toLowerCase()}:${hexToNumber(log.logIndex)}`);
        if (known === null || known.removed) continue;
        const slot = published.get(known.blockNumber) ?? { hash: known.blockHash, ids: [] };
        slot.ids.push(known.id);
        published.set(known.blockNumber, slot);
      }
      if (mode === "reconcile") {
        const safeEnd = Math.min(end, to - this.cfg.confirmBlocks);
        for (let b = start; b <= safeEnd; b++) {
          for (const a of this.ledger.active(b)) if (!canonical.has(a.id)) this.publishRemoval(a.id, recovery);
        }
      } else {
        for (let b = start; b <= end; b++) {
          const slot = published.get(b);
          this.publishSeal(b, slot?.hash ?? this.headHashes.get(b) ?? null, slot?.ids ?? [], "backfill", recovery);
        }
      }
    }
    return true;
  }

  private publishRemoval(id: string, recovery: Recovery): void {
    const prev = this.ledger.record(id);
    if (prev === null) return;
    if (this.ledger.transition(id, prev.blockNumber, prev.blockHash, false) === "duplicate") return;
    const rec: LogRecord = {
      ...prev,
      path: "backfill",
      realtime: false,
      recovery,
      removed: true,
      epoch: this.epoch,
      seq: ++this.seq,
      receivedAtMs: this.clock.nowMs(),
    };
    this.publish(logSubject(rec.kind, "backfill", true), rec);
    this.ledger.remember(rec);
    this.counters.backfillRemovals += 1;
  }

  private onRecover(data: Uint8Array): void {
    let req: unknown;
    try {
      req = decodeJson(data);
    } catch {
      this.counters.malformed += 1;
      return;
    }
    if (!isRecord(req) || req.type !== "recover" || typeof req.fromBlock !== "number" || !Number.isSafeInteger(req.fromBlock)) {
      this.counters.malformed += 1;
      return;
    }
    this.counters.recoverRequests += 1;
    this.recoverQueue.push(req as unknown as RecoverRequest);
    void this.drainRecover();
  }

  /** Serve persister recover requests one at a time, each bounded by maxRecoverBlocks. */
  async drainRecover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      while (this.recoverQueue.length > 0 && this.reconciled && this.verifiedBlock !== null) {
        const req = this.recoverQueue.shift();
        if (req === undefined) break;
        const from = Math.max(req.fromBlock, this.trackedSinceBlock ?? req.fromBlock);
        const limit = Math.min(req.toBlock ?? this.verifiedBlock, this.verifiedBlock);
        const to = Math.min(limit, from + this.cfg.maxRecoverBlocks - 1);
        if (from > to) continue;
        try {
          await this.backfill(from, to, "persister", "republish");
          this.log("info", "persister recovery served", { requestId: req.requestId, from, to });
        } catch (e) {
          this.counters.recoverErrors += 1;
          this.log("error", "persister recovery failed", { requestId: req.requestId, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  private onHeartbeat(data: Uint8Array): void {
    try {
      const hb = decodeJson(data);
      if (isRecord(hb) && hb.type === "persister") this.heartbeat = { atMs: this.clock.nowMs(), hb: hb as unknown as PersisterHeartbeat };
    } catch {
      this.counters.malformed += 1;
    }
  }

  // ---- Status --------------------------------------------------------------------------------

  status(): CollectorStatus {
    const now = this.clock.nowMs();
    let state: CollectorStatus["persistence"]["state"];
    if (this.heartbeat !== null && now - this.heartbeat.atMs <= this.cfg.persisterTimeoutMs) state = "ok";
    else if (this.heartbeat === null && now - this.startedAtMs < this.cfg.persisterTimeoutMs) state = "unknown";
    else state = "missing";
    if (state !== this.persistenceState) {
      this.log(state === "missing" ? "warn" : "info", `persistence ${state}`, { lastHeartbeatMs: this.heartbeat?.atMs ?? null });
      this.persistenceState = state;
    }
    const dropped = this.tracker.droppedTotal;
    return {
      v: 1,
      type: "status",
      epoch: this.epoch,
      atMs: now,
      connected: this.connected,
      reconciled: this.reconciled,
      filterDigest: this.digest,
      headBlock: this.headBlock,
      verifiedBlock: this.verifiedBlock,
      trackedSinceBlock: this.trackedSinceBlock,
      trackedPools: this.tracker.size,
      coverage: {
        complete: dropped === 0 && this.tracker.swapsForDropped === 0 && this.pendingSwapsDropped === 0 && this.backfillTruncatedBlocks === 0,
        droppedPools: dropped,
        recentDropped: this.tracker.recentDropped,
        swapsForDroppedPools: this.tracker.swapsForDropped,
        untrackedSwaps: this.untrackedSwaps,
        pendingSwapsDropped: this.pendingSwapsDropped,
        backfillTruncatedBlocks: this.backfillTruncatedBlocks,
      },
      counters: { ...this.counters },
      persistence: {
        state,
        lastHeartbeatMs: this.heartbeat?.atMs ?? null,
        contiguousBlock: this.heartbeat?.hb.contiguousBlock ?? null,
        gaps: this.heartbeat?.hb.gapCount ?? 0,
      },
    };
  }

  publishStatus(): void {
    this.publish(STATUS, this.status());
  }
}
