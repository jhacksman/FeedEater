import type { BaseCollectorSettings } from "../settings.js";
import { classify, hexToNumber } from "./decode.js";
import { isRecord } from "./ports.js";
import { filterDigest, hookSuites, isLiveLogSubject } from "./subjects.js";
import type { CollectorStatus, DecodedInitialize, LogRecord, PersisterHeartbeat, RawLog } from "./types.js";

/** Observation key: identity plus state, so a removal and a re-add are separate expected events. */

type KindCounts = { expected: number; delivered: number; recoveredOnBackfill: number; missedEntirely: number; latencyN: number; p99: number | null };
type Obs = { removed: boolean; tNs: bigint };
type DirectSeq = { blockNumber: number; kind: string; poolId: string | null; seq: Obs[] };
type LiveSeq = { seq: Obs[]; duplicates: number };

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
  /** Same-state repeats seen on the direct node subscription (not expected transitions). */
  directRepeats: number;
  extraLive: number;
  /** Matched counts per event type; `latencyN`/`p99` are the latency samples of that type. */
  byKind: Record<string, KindCounts>;
  /**
   * What this window does and does not cover. `sourceValidationWindow` is false for a window with no
   * target Swaps, no tracked pools, unobserved/missing persistence, incomplete collector coverage or
   * an unverified filter digest. Reconnect and persister outage are observed here, not inferred.
   */
  scope: {
    targetSwapsExpected: number;
    trackedPoolsMeasured: number;
    collectorTrackedPools: number | null;
    collectorUntrackedSwaps: number | null;
    collectorCoverageComplete: boolean | null;
    persistence: "ok_every_sample" | "missing_observed" | "not_observed";
    heartbeatSamples: number;
    reconnectObserved: boolean;
    notCovered: string[];
    sourceValidationWindow: boolean;
  };
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
/**
 * Compares a direct node subscription with the collector's NATS output on one clock
 * (`process.hrtime.bigint()` in a single process). Pure bookkeeping; the runner feeds it.
 *
 * Per identity (`blockHash:logIndex`) each side is an ordered list of state transitions
 * (active/removed); a repeat of the current state is a duplicate. The k-th direct transition is
 * delivered only if the k-th live transition has the same state.
 */
export class Measurement {
  private readonly direct = new Map<string, DirectSeq>();
  private readonly live = new Map<string, LiveSeq>();
  private readonly backfill = new Map<string, boolean[]>();
  private readonly pools = new Set<string>();
  private readonly hooks: Map<string, string | null>;
  private readonly factories: Map<string, string>;
  private contamination = 0;
  private lateLive = 0;
  private directRepeats = 0;
  private statusSamples = 0;
  private heartbeatSamples = 0;
  private reconnectObserved = false;
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
    const removed = log.removed === true;
    let d = this.direct.get(id);
    if (d === undefined) {
      d = { blockNumber: hexToNumber(log.blockNumber), kind: c.kind, poolId, seq: [] };
      this.direct.set(id, d);
    }
    if (d.seq[d.seq.length - 1]?.removed === removed) this.directRepeats += 1;
    else d.seq.push({ removed, tNs });
  }

  recordBus(subject: string, payload: unknown, tNs: bigint): void {
    if (!isRecord(payload)) return;
    if (payload.type === "status") {
      const st = payload as unknown as CollectorStatus;
      this.statusSamples += 1;
      if (st.persistence.state === "missing") this.missingSamples += 1;
      const prev = this.lastStatus;
      if (prev !== null && (st.epoch !== prev.epoch || (st.counters?.connects ?? 0) > (prev.counters?.connects ?? 0))) this.reconnectObserved = true;
      if (st.connected === false) this.reconnectObserved = true;
      this.lastStatus = st;
      return;
    }
    if (payload.type === "persister") {
      this.lastHeartbeat = payload as unknown as PersisterHeartbeat;
      this.heartbeatSamples += 1;
      return;
    }
    if (payload.type !== "log") return;
    const rec = payload as unknown as LogRecord;
    if (isLiveLogSubject(subject)) {
      if (rec.path !== "live" || rec.realtime !== true || rec.recovery !== null) this.contamination += 1;
      let l = this.live.get(rec.id);
      if (l === undefined) {
        l = { seq: [], duplicates: 0 };
        this.live.set(rec.id, l);
      }
      if (l.seq[l.seq.length - 1]?.removed === rec.removed) {
        l.duplicates += 1;
        return;
      }
      const bf = this.backfill.get(rec.id) ?? [];
      if (bf.filter((x) => x === rec.removed).length > l.seq.filter((x) => x.removed === rec.removed).length) this.lateLive += 1;
      l.seq.push({ removed: rec.removed, tNs });
    } else {
      const d: unknown = rec.decoded;
      if (rec.kind === "swap" && isRecord(d) && typeof d.poolId === "string") this.pools.add(d.poolId);
      const bf = this.backfill.get(rec.id) ?? [];
      if (bf[bf.length - 1] !== rec.removed) bf.push(rec.removed);
      this.backfill.set(rec.id, bf);
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
    const byKind: Record<string, KindCounts & { lat: number[] }> = {};
    for (const k of ["initialize", "swap", "factory"]) byKind[k] = { expected: 0, delivered: 0, recoveredOnBackfill: 0, missedEntirely: 0, latencyN: 0, p99: null, lat: [] };
    for (const [id, d] of this.direct) {
      if (!inWindow(d.blockNumber)) continue;
      if (d.kind === "swap" && (d.poolId === null || !this.pools.has(d.poolId))) continue;
      const l = this.live.get(id)?.seq ?? [];
      const bf = this.backfill.get(id) ?? [];
      const kc = byKind[d.kind]!;
      d.seq.forEach((t, k) => {
        expected += 1;
        kc.expected += 1;
        const got = l[k];
        if (got !== undefined && got.removed === t.removed) {
          delivered += 1;
          kc.delivered += 1;
          const ms = Number(got.tNs - t.tNs) / 1e6;
          if (ms < 0) negative += 1;
          latencies.push(ms);
          kc.lat.push(ms);
          return;
        }
        const nth = d.seq.slice(0, k + 1).filter((x) => x.removed === t.removed).length;
        if (bf.filter((x) => x === t.removed).length >= nth) {
          recovered += 1;
          kc.recoveredOnBackfill += 1;
        } else {
          missedEntirely += 1;
          kc.missedEntirely += 1;
        }
      });
    }
    let duplicates = 0;
    let extra = 0;
    for (const [id, l] of this.live) {
      const d = this.direct.get(id);
      if (d === undefined) {
        extra += l.seq.length;
        duplicates += l.duplicates;
        continue;
      }
      if (!inWindow(d.blockNumber)) continue;
      duplicates += l.duplicates;
      extra += Math.max(0, l.seq.length - d.seq.length);
    }
    latencies.sort((a, b) => a - b);
    const kinds: Record<string, KindCounts> = {};
    for (const [k, { lat, ...c }] of Object.entries(byKind)) {
      lat.sort((a, b) => a - b);
      kinds[k] = { ...c, latencyN: lat.length, p99: quantile(lat, 0.99) };
    }
    const p99 = quantile(latencies, 0.99);
    const pct = expected === 0 ? 0 : (100 * delivered) / expected;
    const digestOk = this.lastStatus?.filterDigest === this.digest;
    const dat = {
      liveDelivery100: expected > 0 && delivered === expected && extra === 0,
      zeroDuplicateLive: duplicates === 0,
      zeroBackfillContamination: this.contamination === 0 && this.lateLive === 0,
      p99AddedLe10ms: p99 !== null && p99 <= 10,
    };
    const st = this.lastStatus;
    const persistence =
      this.missingSamples > 0 ? "missing_observed" : this.heartbeatSamples > 0 && this.statusSamples > 0 ? "ok_every_sample" : "not_observed";
    const notCovered: string[] = [];
    if (kinds.swap!.expected === 0) notCovered.push("no_target_swaps");
    if (this.pools.size === 0) notCovered.push("no_tracked_pools");
    if (persistence !== "ok_every_sample") notCovered.push(persistence === "missing_observed" ? "persistence_missing" : "persistence_not_observed");
    if (st?.coverage?.complete !== true) notCovered.push("collector_coverage_incomplete");
    if (!digestOk) notCovered.push("filter_digest_unverified");
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
      directRepeats: this.directRepeats,
      extraLive: extra,
      byKind: kinds,
      scope: {
        targetSwapsExpected: kinds.swap!.expected,
        trackedPoolsMeasured: this.pools.size,
        collectorTrackedPools: st?.trackedPools ?? null,
        collectorUntrackedSwaps: st?.coverage?.untrackedSwaps ?? null,
        collectorCoverageComplete: st?.coverage?.complete ?? null,
        persistence,
        heartbeatSamples: this.heartbeatSamples,
        reconnectObserved: this.reconnectObserved,
        notCovered,
        sourceValidationWindow: notCovered.length === 0,
      },
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
