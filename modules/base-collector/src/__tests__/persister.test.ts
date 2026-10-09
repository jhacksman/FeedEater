import { describe, expect, it } from "vitest";

import { MemoryStore } from "../memoryStore.js";
import { Persister } from "../persister.js";
import { latestPerId } from "../pgStore.js";
import { RECOVER, sealDigest } from "../subjects.js";
import type { LogRecord, SealRecord } from "../types.js";
import { FakeBus, cfg, initLog, poolId, quiet, rig, settle, swapLog } from "./fixtures.js";

const id = (b: number, i: number) => `0x${b}:${i}`;
let seq = 0;
function rec(b: number, i: number, removed = false, s = ++seq, path: "live" | "backfill" = "live"): LogRecord {
  return {
    v: 1, type: "log", id: id(b, i), kind: "swap", path, realtime: path === "live", recovery: path === "live" ? null : "reconnect",
    removed, epoch: 1, seq: s, blockNumber: b, blockHash: `0x${b}`, txHash: "0x", txIndex: 0, logIndex: i, address: "0x",
    topics: [], data: "0x", decoded: null, suite: null, receivedAtMs: 0,
  };
}
function seal(b: number, ids: string[], hash: string | null = `0x${b}`): SealRecord {
  return { v: 1, type: "seal", epoch: 1, seq: ++seq, path: "live", recovery: null, blockNumber: b, blockHash: hash, count: ids.length, digest: sealDigest(ids) };
}
function persister(store = new MemoryStore(), bus = new FakeBus()) {
  const s = cfg();
  return { p: new Persister({ ...s, persistRecoverOverlapBlocks: 4, persistMissingSealGraceBlocks: 1 }, store, bus, { log: quiet }), store, bus };
}

describe("identity state in storage", () => {
  it("applies active -> removed -> re-added by (epoch, seq); stale replays never regress", async () => {
    const { p, store } = persister();
    const a = rec(10, 1);
    const r = rec(10, 1, true);
    const back = rec(10, 1);
    for (const x of [a, r, back]) p.enqueue(x);
    p.enqueue(r); // replay of an older observation
    await p.flush();
    expect(store.logs.get(id(10, 1))).toMatchObject({ removed: false, transitions: 3, seq: back.seq });
    expect(store.history.map((h) => h.removed)).toEqual([false, true, false]);
  });

  it("applies removed -> re-added -> removed", async () => {
    const { p, store } = persister();
    for (const x of [rec(11, 1, true), rec(11, 1), rec(11, 1, true)]) p.enqueue(x);
    await p.flush();
    expect(store.logs.get(id(11, 1))).toMatchObject({ removed: true, transitions: 3 });
  });

  it("keeps only the newest observation per identity for one upsert statement", () => {
    const x = rec(12, 1, false, 5);
    const y = rec(12, 1, true, 9);
    expect(latestPerId([y, x])).toEqual([y]);
  });

  it("orphans stored rows that are not on the sealed block hash", async () => {
    const { p, store } = persister();
    p.enqueue(rec(13, 1));
    p.enqueue({ ...rec(13, 2), id: "0xother:2", blockHash: "0xother" });
    p.enqueue(seal(13, [id(13, 1)]));
    await p.flush();
    expect(store.logs.get("0xother:2")).toMatchObject({ removed: true, stateSource: "seal" });
    expect(p.contiguousBlock).toBe(13);
  });
});

describe("acknowledgement contract", () => {
  it("advances only through contiguous matched seals, never to the max block seen", async () => {
    const { p, store, bus } = persister();
    store.contiguous = 100;
    await p.start();
    expect(bus.published.find((x) => x.subject === RECOVER)!.payload).toMatchObject({ fromBlock: 97, reason: "start" });
    // Persister missed block 101's log (core NATS, no replay); 102 and 103 arrive.
    p.enqueue(seal(101, [id(101, 0)]));
    p.enqueue(rec(102, 0));
    p.enqueue(seal(102, [id(102, 0)]));
    p.enqueue(seal(103, []));
    await p.flush();
    expect(p.contiguousBlock).toBe(100);
    expect(p.heartbeat()).toMatchObject({ contiguousBlock: 100, gapCount: 1, gapBlocks: [101] });
    expect(p.requestRecovery("gap")).toMatchObject({ fromBlock: 97 });
    // The recovered log and its backfill seal close the gap.
    p.enqueue(rec(101, 0, false, ++seq, "backfill"));
    await p.flush();
    expect(p.contiguousBlock).toBe(103);
    expect(store.contiguous).toBe(103);
    await p.stop();
  });

  it("retains the queue through a database outage and reports it", async () => {
    const { p, store } = persister();
    store.failWrites = true;
    p.enqueue(rec(200, 0));
    p.enqueue(seal(200, [id(200, 0)]));
    await p.flush();
    expect(p.heartbeat()).toMatchObject({ queued: 2, lastError: "database unavailable" });
    store.failWrites = false;
    await p.flush();
    expect(p.heartbeat()).toMatchObject({ queued: 0, lastError: null, contiguousBlock: 200 });
  });

  it("marks blocks lost to queue overflow", () => {
    const store = new MemoryStore();
    const p = new Persister({ ...cfg(), persistMaxQueue: 1, persistBatchSize: 10 }, store, new FakeBus(), { log: quiet });
    p.enqueue(rec(300, 0));
    p.enqueue(rec(301, 0));
    expect(p.heartbeat()).toMatchObject({ droppedOverflow: 1 });
  });
});

describe("collector + persister over a fake core-NATS bus", () => {
  it("recovers logs published while the persister was offline", async () => {
    const r = rig({ confirmBlocks: 2 });
    r.rpc.head = 100;
    await r.c.start();
    await settle();
    const store = new MemoryStore();
    const first = new Persister({ ...r.settings, persistFlushMs: 10_000 }, store, r.bus, { log: quiet });
    await first.start();
    const P1 = poolId(1);
    const chain = [initLog({ block: 101, logIndex: 0, pool: P1 }), swapLog({ block: 102, logIndex: 0, pool: P1 }), swapLog({ block: 104, logIndex: 0, pool: P1 })];
    r.rpc.chain = chain;
    r.ws.log(chain[0]!);
    r.ws.head(103);
    await first.flush();
    expect(first.contiguousBlock).toBe(101);
    await first.stop();
    r.bus.unsubscribeAll();
    // Persister offline: these are lost on core NATS.
    r.ws.log(chain[1]!);
    r.ws.log(chain[2]!);
    r.ws.head(107);
    // Persister restarts from its stored contiguous block and asks for a republish.
    const second = new Persister({ ...r.settings, persistFlushMs: 10_000 }, store, r.bus, { log: quiet });
    r.bus.subscribe("feedeater.base_collector.ctl.recover", (d) => (r.c as unknown as { onRecover(d: Uint8Array): void }).onRecover(d));
    await second.start();
    await settle();
    await second.flush();
    expect(second.contiguousBlock).toBe(105);
    expect([...store.logs.values()].filter((x) => !x.removed)).toHaveLength(3);
    expect(store.logs.get(`${chain[1]!.blockHash}:0`)).toMatchObject({ firstPath: "backfill", firstRealtime: false });
    await second.stop();
    await r.c.stop();
  });
});
