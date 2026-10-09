import { randomUUID } from "node:crypto";

import { isRecord, stderrLogger, systemClock, type Bus, type Clock, type Logger } from "./ports.js";
import { ALL, PERSISTER, RECOVER, decodeJson, encodeJson } from "./subjects.js";
import type { LogRecord, PersisterHeartbeat, RecoverRequest, SealRecord } from "./types.js";

/** `(epoch, seq)` orders every observation one collector lineage publishes. */
export function newer(a: { epoch: number; seq: number }, b: { epoch: number; seq: number }): boolean {
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.seq > b.seq);
}

export interface PersistStore {
  /** Create schema if needed; return the persisted contiguous acknowledged block. */
  init(): Promise<number | null>;
  /**
   * Upsert identity state. A row's state changes only to a strictly newer (epoch, seq)
   * observation, so removed -> re-added and re-added -> removed both apply, and replays don't
   * regress state. Every distinct observation is appended to the transition history.
   */
  writeLogs(records: readonly LogRecord[]): Promise<void>;
  /**
   * Mark stored active rows of the block that are not on the sealed block hash as removed
   * (seal-ordered), then report whether the stored active identities equal the seal.
   */
  applySeal(seal: SealRecord): Promise<boolean>;
  saveContiguous(block: number): Promise<void>;
}

export type PersisterConfig = {
  persistBatchSize: number;
  persistFlushMs: number;
  persistMaxQueue: number;
  persistHeartbeatMs: number;
  persistRecoverIntervalMs: number;
  persistRecoverOverlapBlocks: number;
  persistMissingSealGraceBlocks: number;
};

type Item = LogRecord | SealRecord;

/**
 * Batched persister. Acknowledgement contract: block b is acknowledged once a seal for b matched
 * the stored active identities; `contiguousBlock` advances only through consecutive acknowledged
 * blocks, never to the max block seen. On start and while gaps exist it requests a bounded
 * republish starting below the first unacknowledged block (`persistRecoverOverlapBlocks`).
 */
export class Persister {
  private queue: Item[] = [];
  private contiguous: number | null = null;
  private readonly acked = new Set<number>();
  private readonly unmatched = new Map<number, SealRecord>();
  private maxSealBlock: number | null = null;
  private droppedOverflow = 0;
  private readonly lostBlocks = new Set<number>();
  private lastFlushOkMs: number | null = null;
  private lastError: string | null = null;
  private flushing = false;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(
    private readonly cfg: PersisterConfig,
    private readonly store: PersistStore,
    private readonly bus: Bus,
    deps: { clock?: Clock; log?: Logger } = {},
  ) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? stderrLogger;
  }

  get contiguousBlock(): number | null {
    return this.contiguous;
  }

  get queued(): number {
    return this.queue.length;
  }

  async start(): Promise<void> {
    this.contiguous = await this.store.init();
    this.bus.subscribe(ALL, (data) => this.onMessage(data));
    this.timers.push(setInterval(() => void this.flush(), this.cfg.persistFlushMs));
    this.timers.push(setInterval(() => this.publishHeartbeat(), this.cfg.persistHeartbeatMs));
    this.timers.push(setInterval(() => this.requestRecovery("gap"), this.cfg.persistRecoverIntervalMs));
    this.requestRecovery("start");
    this.publishHeartbeat();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.flush();
  }

  onMessage(data: Uint8Array): void {
    let x: unknown;
    try {
      x = decodeJson(data);
    } catch {
      return;
    }
    if (!isRecord(x) || (x.type !== "log" && x.type !== "seal")) return;
    this.enqueue(x as unknown as Item);
  }

  enqueue(item: Item): void {
    if (this.queue.length >= this.cfg.persistMaxQueue) {
      const dropped = this.queue.shift();
      this.droppedOverflow += 1;
      if (dropped !== undefined) this.lostBlocks.add(dropped.blockNumber);
    }
    this.queue.push(item);
    if (this.queue.length >= this.cfg.persistBatchSize) void this.flush();
  }

  /** Write queued items in arrival order; on failure keep them queued and retry next flush. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, this.cfg.persistBatchSize);
        try {
          await this.writeBatch(batch);
        } catch (e) {
          this.lastError = e instanceof Error ? e.message : String(e);
          this.log("error", "persist batch failed; retained for retry", { error: this.lastError, queued: this.queue.length });
          return;
        }
        this.queue.splice(0, batch.length);
        this.lastFlushOkMs = this.clock.nowMs();
        this.lastError = null;
      }
    } finally {
      this.flushing = false;
    }
  }

  private async writeBatch(batch: readonly Item[]): Promise<void> {
    let logs: LogRecord[] = [];
    const touched = new Set<number>();
    for (const item of batch) {
      if (item.type === "log") {
        logs.push(item);
        touched.add(item.blockNumber);
        continue;
      }
      if (logs.length > 0) await this.store.writeLogs(logs);
      logs = [];
      await this.handleSeal(item);
    }
    if (logs.length > 0) await this.store.writeLogs(logs);
    // A late log for a block whose seal did not match: check again.
    for (const b of touched) {
      const seal = this.unmatched.get(b);
      if (seal !== undefined) await this.handleSeal(seal);
    }
    await this.advance();
  }

  private async handleSeal(seal: SealRecord): Promise<void> {
    if (this.maxSealBlock === null || seal.blockNumber > this.maxSealBlock) this.maxSealBlock = seal.blockNumber;
    if (this.contiguous === null) this.contiguous = seal.blockNumber - 1;
    const ok = await this.store.applySeal(seal);
    if (ok) {
      this.unmatched.delete(seal.blockNumber);
      this.lostBlocks.delete(seal.blockNumber);
      if (seal.blockNumber > this.contiguous) this.acked.add(seal.blockNumber);
    } else {
      const prev = this.unmatched.get(seal.blockNumber);
      if (prev === undefined || newer(seal, prev)) this.unmatched.set(seal.blockNumber, seal);
      this.acked.delete(seal.blockNumber);
    }
  }

  private async advance(): Promise<void> {
    if (this.contiguous === null) return;
    const before = this.contiguous;
    while (this.acked.has(this.contiguous + 1)) {
      this.acked.delete(this.contiguous + 1);
      this.contiguous += 1;
    }
    if (this.contiguous !== before) await this.store.saveContiguous(this.contiguous);
  }

  /** Unacknowledged blocks between the contiguous block and the newest seal (minus grace). */
  gapBlocks(limit = 20): { blocks: number[]; count: number } {
    if (this.contiguous === null || this.maxSealBlock === null) return { blocks: [], count: this.lostBlocks.size };
    const upper = this.maxSealBlock - this.cfg.persistMissingSealGraceBlocks;
    const blocks: number[] = [];
    let count = 0;
    for (let b = this.contiguous + 1; b <= upper; b++) {
      if (this.acked.has(b)) continue;
      count += 1;
      if (blocks.length < limit) blocks.push(b);
    }
    return { blocks, count };
  }

  requestRecovery(reason: "start" | "gap"): RecoverRequest | null {
    if (this.contiguous === null) return null;
    const gaps = this.gapBlocks(1);
    if (reason === "gap" && gaps.count === 0) return null;
    const first = reason === "gap" ? (gaps.blocks[0] ?? this.contiguous + 1) : this.contiguous + 1;
    const req: RecoverRequest = {
      v: 1,
      type: "recover",
      requestId: randomUUID(),
      fromBlock: Math.max(0, first - this.cfg.persistRecoverOverlapBlocks),
      toBlock: null,
      reason,
    };
    this.bus.publish(RECOVER, encodeJson(req));
    this.log("info", "recover requested", { ...req });
    return req;
  }

  heartbeat(): PersisterHeartbeat {
    const gaps = this.gapBlocks();
    return {
      v: 1,
      type: "persister",
      atMs: this.clock.nowMs(),
      contiguousBlock: this.contiguous,
      queued: this.queue.length,
      droppedOverflow: this.droppedOverflow,
      lastFlushOkMs: this.lastFlushOkMs,
      lastError: this.lastError,
      gapBlocks: gaps.blocks,
      gapCount: gaps.count,
    };
  }

  private publishHeartbeat(): void {
    try {
      this.bus.publish(PERSISTER, encodeJson(this.heartbeat()));
    } catch (e) {
      this.log("error", "heartbeat publish failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
