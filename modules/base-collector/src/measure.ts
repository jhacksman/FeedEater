import type { BaseCollectorSettings } from "../settings.js";
import { classify, hexToNumber } from "./decode.js";
import { isRecord } from "./ports.js";
import { filterDigest, hookSuites, isLiveLogSubject } from "./subjects.js";
import type { CollectorStatus, DecodedInitialize, LogRecord, PersisterHeartbeat, RawLog } from "./types.js";

/** Observation key: identity plus state, so a removal and a re-add are separate expected events. */
const key = (id: string, removed: boolean) => `${id}|${removed ? "removed" : "active"}`;

type DirectObs = { tNs: bigint; blockNumber: number; kind: string; poolId: string | null; count: number };
type BusObs = { tNs: bigint; count: number };

export type MeasurementReport = {
  filterDigest: string;
  filterDigestVerified: boolean;
  window: { fromBlock: number; toBlock: number };
  expected: number;
  deliveredLive: number;
  liveDeliveryPct: number;
  missedLive: number;
  missedLiveRecoveredOnBackfill: number;
  missedEntirely: number;
  duplicateLivePublishes: number;
  backfillOnLiveSubjects: number;
  lateLiveAfterBackfill: number;
  extraLive: number;
  addedLatencyMs: { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null; negative: number };
  persistence: { statusSamples: number; missingSamples: number; lastCollectorStatus: CollectorStatus | null; lastHeartbeat: PersisterHeartbeat | null };
  dat011: { liveDelivery100: boolean; zeroDuplicateLive: boolean; zeroBackfillContamination: boolean; p99AddedLe10ms: boolean; pass: boolean };
};

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] ?? null;
}

/**
 * Compares a direct node subscription with the collector's NATS output on one clock
 * (`process.hrtime.bigint()` in a single process). Pure bookkeeping; the runner feeds it.
 */
export class Measurement {
  private readonly direct = new Map<string, DirectObs>();
  private readonly live = new Map<string, BusObs>();
  private readonly backfill = new Map<string, BusObs>();
  private readonly pools = new Set<string>();
  private readonly hooks: Map<string, string | null>;
  private readonly factories: Map<string, string>;
  private contamination = 0;
  private lateLive = 0;
  private statusSamples = 0;
  private missingSamples = 0;
  private lastStatus: CollectorStatus | null = null;
  private lastHeartbeat: PersisterHeartbeat | null = null;
  readonly digest: string;

  constructor(private readonly cfg: BaseCollectorSettings, initialPools: Iterable<string> = []) {
    this.hooks = hookSuites(cfg);
    this.factories = new Map(cfg.suites.map((s) => [s.factory, s.name]));
    this.digest = filterDigest(cfg);
    for (const p of [...initialPools, ...cfg.extraPoolIds]) this.pools.add(p.toLowerCase());
  }

  recordDirect(log: RawLog, tNs: bigint): void {
    const c = classify(log, this.cfg.poolManager, this.factories);
    if (c === null) return;
    let poolId: string | null = null;
    if (c.kind === "initialize" && c.decoded !== null && "hooks" in c.decoded) {
      const d = c.decoded as DecodedInitialize;
      if (this.hooks.has(d.hooks) && log.removed !== true) this.pools.add(d.poolId);
    }
    if (c.kind === "swap") poolId = log.topics[1]?.toLowerCase() ?? null;
    const id = `${log.blockHash.toLowerCase()}:${hexToNumber(log.logIndex)}`;
    const k = key(id, log.removed === true);
    const prev = this.direct.get(k);
    if (prev !== undefined) prev.count += 1;
    else this.direct.set(k, { tNs, blockNumber: hexToNumber(log.blockNumber), kind: c.kind, poolId, count: 1 });
  }

  recordBus(subject: string, payload: unknown, tNs: bigint): void {
    if (!isRecord(payload)) return;
    if (payload.type === "status") {
      const st = payload as unknown as CollectorStatus;
      this.statusSamples += 1;
      if (st.persistence.state === "missing") this.missingSamples += 1;
      this.lastStatus = st;
      return;
    }
    if (payload.type === "persister") {
      this.lastHeartbeat = payload as unknown as PersisterHeartbeat;
      return;
    }
    if (payload.type !== "log") return;
    const rec = payload as unknown as LogRecord;
    const k = key(rec.id, rec.removed);
    if (isLiveLogSubject(subject)) {
      if (rec.path !== "live" || rec.realtime !== true || rec.recovery !== null) this.contamination += 1;
      if (this.backfill.has(k) && !this.live.has(k)) this.lateLive += 1;
      const prev = this.live.get(k);
      if (prev !== undefined) prev.count += 1;
      else this.live.set(k, { tNs, count: 1 });
    } else {
      const d: unknown = rec.decoded;
      if (rec.kind === "swap" && isRecord(d) && typeof d.poolId === "string") this.pools.add(d.poolId);
      const prev = this.backfill.get(k);
      if (prev !== undefined) prev.count += 1;
      else this.backfill.set(k, { tNs, count: 1 });
    }
  }

  report(fromBlock: number, toBlock: number): MeasurementReport {
    const inWindow = (b: number) => b >= fromBlock && b <= toBlock;
    const latencies: number[] = [];
    let expected = 0;
    let delivered = 0;
    let recovered = 0;
    let missedEntirely = 0;
    let negative = 0;
    const expectedKeys = new Set<string>();
    for (const [k, d] of this.direct) {
      if (!inWindow(d.blockNumber)) continue;
      if (d.kind === "swap" && (d.poolId === null || !this.pools.has(d.poolId))) continue;
      expected += 1;
      expectedKeys.add(k);
      const l = this.live.get(k);
      if (l !== undefined) {
        delivered += 1;
        const ms = Number(l.tNs - d.tNs) / 1e6;
        if (ms < 0) negative += 1;
        latencies.push(ms);
      } else if (this.backfill.has(k)) recovered += 1;
      else missedEntirely += 1;
    }
    let duplicates = 0;
    let extra = 0;
    for (const [k, l] of this.live) {
      const d = this.direct.get(k);
      if (d === undefined) {
        extra += 1;
        continue;
      }
      if (inWindow(d.blockNumber)) duplicates += Math.max(0, l.count - d.count);
    }
    latencies.sort((a, b) => a - b);
    const p99 = quantile(latencies, 0.99);
    const pct = expected === 0 ? 0 : (100 * delivered) / expected;
    const digestOk = this.lastStatus?.filterDigest === this.digest;
    const dat = {
      liveDelivery100: expected > 0 && delivered === expected,
      zeroDuplicateLive: duplicates === 0,
      zeroBackfillContamination: this.contamination === 0 && this.lateLive === 0,
      p99AddedLe10ms: p99 !== null && p99 <= 10,
    };
    return {
      filterDigest: this.digest,
      filterDigestVerified: digestOk,
      window: { fromBlock, toBlock },
      expected,
      deliveredLive: delivered,
      liveDeliveryPct: pct,
      missedLive: expected - delivered,
      missedLiveRecoveredOnBackfill: recovered,
      missedEntirely,
      duplicateLivePublishes: duplicates,
      backfillOnLiveSubjects: this.contamination,
      lateLiveAfterBackfill: this.lateLive,
      extraLive: extra,
      addedLatencyMs: {
        n: latencies.length,
        p50: quantile(latencies, 0.5),
        p95: quantile(latencies, 0.95),
        p99,
        max: latencies[latencies.length - 1] ?? null,
        negative,
      },
      persistence: {
        statusSamples: this.statusSamples,
        missingSamples: this.missingSamples,
        lastCollectorStatus: this.lastStatus,
        lastHeartbeat: this.lastHeartbeat,
      },
      dat011: { ...dat, pass: digestOk && dat.liveDelivery100 && dat.zeroDuplicateLive && dat.zeroBackfillContamination && dat.p99AddedLe10ms },
    };
  }
}
