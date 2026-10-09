import { describe, expect, it } from "vitest";

import { Measurement } from "../measure.js";
import { MemoryStore } from "../memoryStore.js";
import { Persister } from "../persister.js";
import { RECOVER, STATUS, encodeJson, filterDigest, sealDigest } from "../subjects.js";
import type { SealRecord } from "../types.js";
import { FakeBus, cfg, initLog, poolId, quiet, rig, settle } from "./fixtures.js";

describe("measurement counts ordered transitions (synthetic timestamps; not a latency result)", () => {
  const s = cfg();
  const status = { type: "status", filterDigest: filterDigest(s), persistence: { state: "ok" } };
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
