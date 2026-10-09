import { describe, expect, it } from "vitest";

import { Measurement } from "../measure.js";
import { MemoryStore } from "../memoryStore.js";
import { Persister } from "../persister.js";
import { RECOVER, STATUS, encodeJson, filterDigest, sealDigest } from "../subjects.js";
import type { SealRecord } from "../types.js";
import { FakeBus, cfg, initLog, poolId, quiet, rig, settle, swapLog } from "./fixtures.js";

describe("measurement counts ordered transitions (synthetic timestamps; not a latency result)", () => {
  const s = cfg();
  const status = { type: "status", headBlock: 10, filterDigest: filterDigest(s), persistence: { state: "ok" } };
  const l = initLog({ block: 10, logIndex: 0, pool: poolId(1) });
  const id = `${l.blockHash}:0`;
  const bus = (removed: boolean) => ({ type: "log", id, removed, path: "live", realtime: true, recovery: null, kind: "initialize" });
  const direct = (m: Measurement) => [false, true, false].forEach((r, k) => m.recordDirect({ ...l, removed: r }, BigInt(k) * 1_000_000n));

  it("fails when the re-add after a removal is not delivered", () => {
    const m = new Measurement(s);
    direct(m);
    m.recordBus(STATUS, status, 0n);
    m.recordBus("feedeater.base_collector.initialize", bus(false), 500_000n);
    m.recordBus("feedeater.base_collector.removed.initialize", bus(true), 1_500_000n);
    const rep = m.report(10, 10);
    expect(rep).toMatchObject({ expected: 3, deliveredLive: 2, missedLive: 1, missedEntirely: 1, duplicateLivePublishes: 0 });
    expect(rep.dat011).toMatchObject({ liveDelivery100: false, pass: false });
  });

  it("passes A->R->A only when all three transitions arrive, and counts a same-state repeat as a duplicate", () => {
    const m = new Measurement(s);
    direct(m);
    m.recordDirect(l, 3_000_000n);
    m.recordBus(STATUS, status, 0n);
    m.recordBus("feedeater.base_collector.initialize", bus(false), 500_000n);
    m.recordBus("feedeater.base_collector.removed.initialize", bus(true), 1_500_000n);
    m.recordBus("feedeater.base_collector.initialize", bus(false), 2_500_000n);
    const ok = m.report(10, 10);
    expect(ok).toMatchObject({ expected: 3, deliveredLive: 3, duplicateLivePublishes: 0, directRepeats: 1 });
    expect(ok.dat011.pass).toBe(true);
    m.recordBus("feedeater.base_collector.initialize", bus(false), 3_500_000n);
    const dup = m.report(10, 10);
    expect(dup).toMatchObject({ deliveredLive: 3, duplicateLivePublishes: 1 });
    expect(dup.dat011.pass).toBe(false);
  });
});

describe("fresh persister start boundary", () => {
  const seal = (b: number): SealRecord => ({
    v: 1, type: "seal", epoch: 1, seq: b, path: b === 12 ? "live" : "backfill", recovery: b === 12 ? null : "persister",
    blockNumber: b, blockHash: `0x${b}`, count: 0, digest: sealDigest([]),
  });
  const mk = (over: Partial<ReturnType<typeof cfg>> = {}) => {
    const store = new MemoryStore();
    const bus = new FakeBus();
    const p = new Persister({ ...cfg(), persistRecoverOverlapBlocks: 4, persistMissingSealGraceBlocks: 1, ...over }, store, bus, { log: quiet });
    return { p, store, bus };
  };

  it("does not acknowledge anything before a start boundary exists", async () => {
    const { p, store } = mk();
    await p.start();
    p.enqueue(seal(12));
    await p.flush();
    expect(p.contiguousBlock).toBeNull();
    expect(store.contiguous).toBeNull();
    expect(p.heartbeat()).toMatchObject({ contiguousBlock: null, startBoundary: null });
    await p.stop();
  });

  it("collector began at block 10, blocks 10/11 missed: seal 12 stays a gap and recovers on backfill", async () => {
    const { p, store, bus } = mk();
    await p.start();
    p.enqueue(seal(12));
    await p.flush();
    bus.publish(STATUS, encodeJson({ v: 1, type: "status", trackedSinceBlock: 10 }));
    await settle();
    expect(store.contiguous).toBe(9);
    expect(p.contiguousBlock).toBe(9);
    expect(p.heartbeat()).toMatchObject({ startBoundary: 10, gapBlocks: [10, 11] });
    expect(bus.published.find((x) => x.subject === RECOVER)!.payload).toMatchObject({ reason: "start" });
    const gap = p.requestRecovery("gap");
    expect(gap).not.toBeNull();
    expect(gap!.fromBlock).toBeLessThanOrEqual(10);
    p.enqueue(seal(10));
    p.enqueue(seal(11));
    await p.flush();
    expect(p.contiguousBlock).toBe(12);
    expect(store.contiguous).toBe(12);
    await p.stop();
  });

  it("an explicit persistStartBlock is persisted at start", async () => {
    const { p, store } = mk({ persistStartBlock: 10 });
    await p.start();
    expect(store.contiguous).toBe(9);
    expect(p.heartbeat()).toMatchObject({ startBoundary: 10 });
    await p.stop();
  });
});

describe("undelivered publication", () => {
  it("is not committed: a later live redelivery is published, not dropped as a duplicate", async () => {
    const r = rig({ confirmBlocks: 2 });
    r.rpc.head = 100;
    await r.c.start();
    await settle();
    const l = initLog({ block: 101, logIndex: 0, pool: poolId(1) });
    r.bus.failLogs = 1;
    r.ws.log(l);
    expect(r.bus.logs()).toHaveLength(0);
    r.ws.log(l);
    expect(r.bus.logs()).toMatchObject([{ subject: "feedeater.base_collector.initialize", payload: { realtime: true, recovery: null } }]);
    await r.c.stop();
  });

  it("holds seals/verified below it, reports incomplete coverage, and recovers on backfill", async () => {
    const r = rig({ confirmBlocks: 2 });
    r.rpc.head = 100;
    await r.c.start();
    await settle();
    const l = initLog({ block: 101, logIndex: 0, pool: poolId(1) });
    r.rpc.chain = [l];
    r.bus.failLogs = 1_000;
    r.ws.log(l);
    r.ws.head(110);
    await settle();
    const seals101 = () => r.bus.published.filter((x) => x.payload.type === "seal" && x.payload.blockNumber === 101);
    expect(r.c.verified).toBe(100);
    expect(seals101()).toHaveLength(0);
    expect(r.c.status().coverage).toMatchObject({ complete: false, undeliveredBlocks: [101] });
    expect(r.c.status().counters.publishErrors).toBeGreaterThanOrEqual(2);
    r.bus.failLogs = 0;
    r.ws.head(111);
    await settle();
    expect(r.bus.logs()).toMatchObject([{ subject: "feedeater.base_collector.backfill.initialize", payload: { realtime: false, recovery: "publish_retry" } }]);
    expect(r.c.status().coverage).toMatchObject({ undeliveredBlocks: [] });
    expect(seals101()).toHaveLength(1);
    expect(r.c.verified).toBe(109);
    await r.c.stop();
  });
});

describe("measurement scope (synthetic timestamps; not a latency result)", () => {
  const s = cfg();
  const P = poolId(1);
  const id = (l: ReturnType<typeof initLog>) => `${l.blockHash}:${Number.parseInt(l.logIndex, 16)}`;
  const live = (l: ReturnType<typeof initLog>, kind: string) => ({ type: "log", id: id(l), removed: false, path: "live", realtime: true, recovery: null, kind });
  const status = (over: Record<string, unknown> = {}) => ({
    type: "status", epoch: 1, headBlock: 10, connected: true, filterDigest: filterDigest(s), trackedPools: 1, counters: { connects: 1 },
    coverage: { complete: true, untrackedSwaps: 0 }, persistence: { state: "ok" }, ...over,
  });
  const hb = { type: "persister", contiguousBlock: 10, gapBlocks: [] };

  it("an Initialize-only window without a persister passes dat011 but is not a source-validation window", () => {
    const m = new Measurement(s);
    const l = initLog({ block: 10, logIndex: 0, pool: P, hooks: "0x0000000000000000000000000000000000000001" });
    m.recordDirect(l, 0n);
    m.recordBus(STATUS, status({ trackedPools: 0, coverage: { complete: true, untrackedSwaps: 989 }, persistence: { state: "missing" } }), 0n);
    m.recordBus("feedeater.base_collector.initialize", live(l, "initialize"), 1_000_000n);
    const rep = m.report(10, 10);
    expect(rep.dat011.pass).toBe(true);
    expect(rep.byKind.initialize).toMatchObject({ expected: 1, delivered: 1, latencyN: 1 });
    expect(rep.byKind.swap).toMatchObject({ expected: 0, latencyN: 0, p99: null });
    expect(rep.scope).toMatchObject({
      targetSwapsExpected: 0, trackedPoolsMeasured: 0, collectorTrackedPools: 0, collectorUntrackedSwaps: 989,
      persistence: "missing_observed", reconnectObserved: false, sourceValidationWindow: false,
    });
    expect(rep.scope.notCovered).toEqual(["no_target_swaps", "no_tracked_pools", "persistence_missing"]);
  });

  it("counts per type, observes reconnect and persistence, and marks a covered window", () => {
    const m = new Measurement(s);
    const i = initLog({ block: 10, logIndex: 0, pool: P });
    const w = swapLog({ block: 10, logIndex: 1, pool: P });
    m.recordDirect(i, 0n);
    m.recordDirect(w, 0n);
    m.recordBus(STATUS, status(), 0n);
    m.recordBus("feedeater.base_collector.ctl.persister", hb, 0n);
    m.recordBus("feedeater.base_collector.initialize", live(i, "initialize"), 1_000_000n);
    m.recordBus("feedeater.base_collector.swap", live(w, "swap"), 2_000_000n);
    m.recordBus(STATUS, status(), 3_000_000n);
    const ok = m.report(10, 10);
    expect(ok.byKind.swap).toMatchObject({ expected: 1, delivered: 1, latencyN: 1, p99: 2 });
    expect(ok.scope).toMatchObject({ targetSwapsExpected: 1, trackedPoolsMeasured: 1, persistence: "ok_every_sample", heartbeatSamples: 1, reconnectObserved: false, notCovered: [], sourceValidationWindow: true });
    m.recordBus(STATUS, status({ counters: { connects: 2 } }), 4_000_000n);
    expect(m.report(10, 10).scope.reconnectObserved).toBe(true);
  });
});

describe("measurement scope uses only in-window samples and keeps any bad observation", () => {
  const s = cfg();
  const P = poolId(1);
  const ms = (n: number) => BigInt(n) * 1_000_000n;
  const good = { type: "status", epoch: 1, headBlock: 10, connected: true, filterDigest: filterDigest(s), trackedPools: 1, counters: { connects: 1 }, coverage: { complete: true, untrackedSwaps: 0 }, persistence: { state: "ok" } };
  const hb = { type: "persister", contiguousBlock: 10, gapBlocks: [] };
  const run = (statuses: Array<[number, Record<string, unknown>]>, heartbeatsAt: number[] = [20]) => {
    const m = new Measurement(s);
    const i = initLog({ block: 10, logIndex: 0, pool: P });
    const w = swapLog({ block: 10, logIndex: 1, pool: P });
    const live = (l: ReturnType<typeof initLog>, kind: string) => ({ type: "log", id: `${l.blockHash}:${Number.parseInt(l.logIndex, 16)}`, removed: false, path: "live", realtime: true, recovery: null, kind });
    m.recordDirect(i, ms(10));
    m.recordDirect(w, ms(10));
    m.recordBus("feedeater.base_collector.initialize", live(i, "initialize"), ms(11));
    m.recordBus("feedeater.base_collector.swap", live(w, "swap"), ms(11));
    for (const t of heartbeatsAt) m.recordBus("feedeater.base_collector.ctl.persister", hb, ms(t));
    for (const [t, over] of statuses.sort((a, b) => a[0] - b[0])) m.recordBus(STATUS, { ...good, ...over }, ms(t));
    return m.report(10, 10);
  };

  it("control: all in-window statuses ok with a heartbeat is a covered window", () => {
    const rep = run([[15, {}], [30, {}]]);
    expect(rep.scope).toMatchObject({ persistence: "ok_every_sample", statusSamples: 2, heartbeatSamples: 1, notCovered: [], sourceValidationWindow: true });
    expect(rep.dat011.pass).toBe(true);
  });

  it("persistence unknown plus a heartbeat is not ok", () => {
    const rep = run([[15, { persistence: { state: "unknown" } }]]);
    expect(rep.scope).toMatchObject({ persistence: "unknown_observed", persistenceStates: { ok: 0, missing: 0, unknown: 1 }, heartbeatSamples: 1, sourceValidationWindow: false });
    expect(rep.scope.notCovered).toEqual(["persistence_unknown"]);
  });

  it("unknown -> ok keeps persistence_unknown", () => {
    const rep = run([[15, { persistence: { state: "unknown" } }], [30, {}]]);
    expect(rep.scope).toMatchObject({ persistence: "unknown_observed", persistenceStates: { ok: 1, unknown: 1 }, sourceValidationWindow: false });
  });

  it("incomplete -> complete keeps collector_coverage_incomplete", () => {
    const rep = run([[15, { coverage: { complete: false, untrackedSwaps: 0 } }], [30, {}]]);
    expect(rep.scope).toMatchObject({ collectorCoverageComplete: false, notCovered: ["collector_coverage_incomplete"], sourceValidationWindow: false });
  });

  it("filter mismatch -> correct keeps filter_digest_mismatch and fails dat011", () => {
    const rep = run([[15, { filterDigest: "0xother" }], [30, {}]]);
    expect(rep.filterDigestVerified).toBe(false);
    expect(rep.dat011.pass).toBe(false);
    expect(rep.scope).toMatchObject({ filterDigestMismatchObserved: true, notCovered: ["filter_digest_mismatch"], sourceValidationWindow: false });
  });

  it("disconnect -> connected keeps collector_disconnected and collector_reconnected", () => {
    const rep = run([[15, { connected: false }], [30, { counters: { connects: 2 } }]]);
    expect(rep.scope).toMatchObject({ disconnectObserved: true, reconnectObserved: true, notCovered: ["collector_disconnected", "collector_reconnected"], sourceValidationWindow: false });
  });

  it("warmup/teardown samples do not enter the window scope", () => {
    const rep = run(
      [
        [1, { headBlock: 9, persistence: { state: "unknown" }, coverage: { complete: false }, connected: false, filterDigest: "0xother" }],
        [15, {}],
        [40, { headBlock: 11, persistence: { state: "missing" }, coverage: { complete: false } }],
      ],
      [1, 20, 41],
    );
    expect(rep.scope).toMatchObject({ statusSamples: 1, heartbeatSamples: 1, notCovered: [], sourceValidationWindow: true });
  });

  it("a heartbeat only outside the window leaves persistence not observed", () => {
    const rep = run([[15, {}]], [1]);
    expect(rep.scope).toMatchObject({ persistence: "not_observed", heartbeatSamples: 0, notCovered: ["persistence_not_observed"], sourceValidationWindow: false });
  });

  it("no in-window status: collector_status_not_observed and digest unverified", () => {
    const rep = run([[1, { headBlock: 9 }]]);
    expect(rep.scope.notCovered).toEqual(["persistence_not_observed", "collector_status_not_observed", "filter_digest_unverified"]);
    expect(rep.dat011.pass).toBe(false);
  });
});

