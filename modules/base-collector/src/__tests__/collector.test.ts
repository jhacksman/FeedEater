import { afterEach, describe, expect, it } from "vitest";

import { MemoryCheckpointStore } from "../checkpoint.js";
import { O1_SUITES } from "../constants.js";
import { RECOVER, encodeJson } from "../subjects.js";
import { factoryLog, initLog, o1Hook, otherHook, poolId, rig, settle, swapLog, type Rig } from "./fixtures.js";

let current: Rig | null = null;
afterEach(async () => {
  await current?.c.stop();
  current = null;
});

async function connected(r: Rig, head = 100): Promise<Rig> {
  current = r;
  r.rpc.head = head;
  await r.c.start();
  await settle();
  expect(r.c.isReconciled).toBe(true);
  return r;
}

const P1 = poolId(1);
const P2 = poolId(2);

describe("live path", () => {
  it("publishes inside the synchronous message handler, before any await or RPC", async () => {
    const r = await connected(rig());
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    const before = r.bus.logs().length;
    const rpcCalls = r.rpc.calls.length;
    const ret = r.ws.handlers!.onMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: r.ws.logsSubs[0], result: swapLog({ block: 101, logIndex: 1, pool: P1 }) } }),
    );
    expect(ret).toBeUndefined();
    expect(r.bus.logs().length).toBe(before + 1);
    expect(r.rpc.calls.length).toBe(rpcCalls);
    const rec = r.bus.logs().at(-1)!;
    expect(rec.subject).toBe("feedeater.base_collector.swap");
    expect(rec.payload).toMatchObject({ path: "live", realtime: true, recovery: null, removed: false, logIndex: 1, blockNumber: 101 });
    expect(rec.payload.id).toBe(`${(rec.payload.blockHash as string)}:1`);
  });

  it("publishes a repeated live delivery once", async () => {
    const r = await connected(rig());
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    expect(r.bus.logs()).toHaveLength(1);
    expect(r.c.counters.duplicatesLive).toBe(1);
  });

  it("removal then re-add of one identity are two transitions", async () => {
    const r = await connected(rig());
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    r.ws.log(swapLog({ block: 102, logIndex: 3, pool: P1 }));
    r.ws.log(swapLog({ block: 102, logIndex: 3, pool: P1, removed: true }));
    r.ws.log(swapLog({ block: 102, logIndex: 3, pool: P1, removed: true }));
    r.ws.log(swapLog({ block: 102, logIndex: 3, pool: P1 }));
    expect(r.bus.subjects().slice(1)).toEqual([
      "feedeater.base_collector.swap",
      "feedeater.base_collector.removed.swap",
      "feedeater.base_collector.swap",
    ]);
    const seqs = r.bus.logs().map((p) => p.payload.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("removal first observed, then the re-add, are both published", async () => {
    const r = await connected(rig());
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    r.ws.log(swapLog({ block: 102, logIndex: 3, pool: P1, removed: true }));
    r.ws.log(swapLog({ block: 102, logIndex: 3, pool: P1 }));
    expect(r.bus.subjects().slice(1)).toEqual(["feedeater.base_collector.removed.swap", "feedeater.base_collector.swap"]);
  });

  it("tracks an o1 Initialize before a Swap later in the same block; ignores other hooks", async () => {
    const r = await connected(rig());
    r.ws.log(initLog({ block: 101, logIndex: 4, pool: P1 }));
    r.ws.log(swapLog({ block: 101, logIndex: 5, pool: P1 }));
    r.ws.log(initLog({ block: 101, logIndex: 6, pool: P2, hooks: otherHook }));
    r.ws.log(swapLog({ block: 101, logIndex: 7, pool: P2 }));
    expect(r.bus.subjects()).toEqual(["feedeater.base_collector.initialize", "feedeater.base_collector.swap", "feedeater.base_collector.initialize"]);
    expect(r.bus.logs()[0]!.payload.suite).toBe(O1_SUITES[5]!.name);
    expect(r.c.status().coverage.untrackedSwaps).toBe(1);
  });

  it("covers all six o1 suites: factory logs and hook tracking", async () => {
    const r = await connected(rig());
    expect(r.settings.suites).toHaveLength(6);
    O1_SUITES.forEach((s, i) => {
      r.ws.log(factoryLog({ block: 110, logIndex: i * 3, factory: s.factory }));
      r.ws.log(initLog({ block: 110, logIndex: i * 3 + 1, pool: poolId(10 + i), hooks: s.hook }));
      r.ws.log(swapLog({ block: 110, logIndex: i * 3 + 2, pool: poolId(10 + i) }));
    });
    const recs = r.bus.logs().map((p) => p.payload);
    expect(recs.filter((x) => x.kind === "factory").map((x) => x.suite)).toEqual(O1_SUITES.map((s) => s.name));
    expect(recs.filter((x) => x.kind === "swap").map((x) => x.suite)).toEqual(O1_SUITES.map((s) => s.name));
  });

  it("exposes coverage lost to the max-tracked-pools bound", async () => {
    const r = await connected(rig({ maxTrackedPools: 1 }));
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    r.ws.log(initLog({ block: 102, logIndex: 0, pool: P2 }));
    r.ws.log(swapLog({ block: 103, logIndex: 0, pool: P1 }));
    const st = r.c.status();
    expect(st.coverage).toMatchObject({ complete: false, droppedPools: 1, swapsForDroppedPools: 1 });
    expect(st.coverage.recentDropped[0]).toMatchObject({ poolId: P1, reason: "max_tracked" });
    expect(r.bus.logs().filter((p) => p.payload.kind === "swap")).toHaveLength(0);
  });

  it("exposes idle eviction", async () => {
    const r = await connected(rig({ poolIdleBlocks: 5 }));
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    r.ws.head(120);
    expect(r.c.status().coverage).toMatchObject({ complete: false, droppedPools: 1 });
    expect(r.c.status().coverage.recentDropped[0]!.reason).toBe("idle");
  });
});

describe("seals and checkpoint", () => {
  it("seals each block confirmBlocks deep and checkpoints the contiguous sealed block", async () => {
    const r = await connected(rig({ confirmBlocks: 2, checkpointIntervalMs: 100 }));
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    r.ws.log(swapLog({ block: 101, logIndex: 1, pool: P1 }));
    r.ws.head(101);
    await settle();
    r.clock.t += 1000;
    r.ws.head(103);
    const seals = r.bus.published.filter((p) => p.payload.type === "seal").map((p) => p.payload);
    expect(seals.map((s) => s.blockNumber)).toEqual([100, 101]);
    expect(seals[1]).toMatchObject({ count: 2, path: "live" });
    expect(r.c.verified).toBe(101);
    await settle();
    expect(r.cps.value!.verifiedBlock).toBe(101);
  });

  it("refuses a checkpoint written for a different filter and keeps epochs monotone", async () => {
    const cps = new MemoryCheckpointStore({ version: 1, filterDigest: "other", epoch: 1, verifiedBlock: 5, trackedSinceBlock: 1, pools: [] });
    await expect(rig({}, cps).c.start()).rejects.toThrow(/filter digest/);
    const r = rig();
    const future = r.clock.t + 10_000;
    r.cps.value = { version: 1, filterDigest: r.c.digest, epoch: future, verifiedBlock: null, trackedSinceBlock: null, pools: [] };
    await connected(r);
    expect(r.cps.value.epoch).toBe(future + 1);
  });
});

describe("realtime recovery (reconnect)", () => {
  it("replays from below the checkpoint onto .backfill and never skips an earlier missing log", async () => {
    const r = rig({ overlapBlocks: 16, confirmBlocks: 2 });
    r.cps.value = {
      version: 1,
      filterDigest: r.c.digest,
      epoch: 1,
      verifiedBlock: 200,
      trackedSinceBlock: 1,
      pools: [{ poolId: P1, hooks: o1Hook, suite: null, initBlock: 50, lastBlock: 50 }],
    };
    r.rpc.chain = [swapLog({ block: 190, logIndex: 0, pool: P1 }), swapLog({ block: 230, logIndex: 0, pool: P1 })];
    await connected(r, 240);
    const recs = r.bus.logs();
    expect(recs.map((p) => [p.subject, p.payload.blockNumber, p.payload.realtime, p.payload.recovery])).toEqual([
      ["feedeater.base_collector.backfill.swap", 190, false, "reconnect"],
      ["feedeater.base_collector.backfill.swap", 230, false, "reconnect"],
    ]);
    const getLogs = r.rpc.calls.filter((c) => c.method === "eth_getLogs").map((c) => (c.params[0] as { fromBlock: string }).fromBlock);
    expect(getLogs[0]).toBe("0xb9"); // 185 = 200 + 1 - 16
    // A live re-delivery of an identity that was already backfilled is never published as live.
    r.ws.log(swapLog({ block: 230, logIndex: 0, pool: P1 }));
    expect(r.bus.logs()).toHaveLength(2);
  });

  it("orders Initialize before Swap of the same block in backfill regardless of node order", async () => {
    const r = rig();
    r.rpc.reverse = true;
    r.rpc.chain = [initLog({ block: 100, logIndex: 2, pool: P1 }), swapLog({ block: 100, logIndex: 3, pool: P1 })];
    await connected(r, 100);
    expect(r.bus.subjects()).toEqual(["feedeater.base_collector.backfill.initialize", "feedeater.base_collector.backfill.swap"]);
  });

  it("buffers live swaps of not-yet-tracked pools during reconcile and releases them as backfill", async () => {
    const r = rig({ startBlock: 99 });
    current = r;
    let open!: () => void;
    r.rpc.gate = new Promise((res) => (open = res));
    r.rpc.head = 100;
    r.rpc.chain = [initLog({ block: 99, logIndex: 0, pool: P1 })];
    await r.c.start();
    await settle();
    r.ws.log(swapLog({ block: 101, logIndex: 0, pool: P1 }));
    expect(r.bus.logs()).toHaveLength(0);
    r.rpc.gate = null;
    open();
    await settle();
    expect(r.bus.logs().map((p) => [p.subject, p.payload.recovery])).toEqual([
      ["feedeater.base_collector.backfill.initialize", "reconnect"],
      ["feedeater.base_collector.backfill.swap", "pending_swap"],
    ]);
  });

  it("publishes a removal on .backfill for a live identity the node no longer returns", async () => {
    const r = await connected(rig({ confirmBlocks: 2 }));
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    r.ws.log(swapLog({ block: 102, logIndex: 1, pool: P1, fork: "a" }));
    r.ws.head(104);
    r.rpc.chain = [initLog({ block: 101, logIndex: 0, pool: P1 }), swapLog({ block: 102, logIndex: 1, pool: P1, fork: "b" })];
    r.rpc.head = 110;
    r.ws.drop();
    await new Promise((res) => setTimeout(res, 5));
    await settle();
    expect(r.c.isReconciled).toBe(true);
    const tail = r.bus.logs().slice(2).map((p) => [p.subject, p.payload.removed, (p.payload.blockHash as string).slice(-3)]);
    expect(tail).toContainEqual(["feedeater.base_collector.backfill.swap", false, "b66"]);
    expect(tail).toContainEqual(["feedeater.base_collector.backfill.removed.swap", true, "a66"]);
    expect(r.bus.logs().filter((p) => !p.subject.includes(".backfill.")).every((p) => p.payload.path === "live")).toBe(true);
  });
});

describe("persistence recovery and status", () => {
  it("serves a persister recover request on .backfill with seals", async () => {
    const r = await connected(rig({ confirmBlocks: 2 }));
    r.ws.log(initLog({ block: 101, logIndex: 0, pool: P1 }));
    r.ws.head(105);
    r.rpc.chain = [initLog({ block: 101, logIndex: 0, pool: P1 })];
    const n = r.bus.published.length;
    r.bus.publish(RECOVER, encodeJson({ v: 1, type: "recover", requestId: "x", fromBlock: 100, toBlock: null, reason: "start" }));
    await settle();
    const out = r.bus.published.slice(n + 1);
    expect(out[0]).toMatchObject({ subject: "feedeater.base_collector.backfill.initialize", payload: { recovery: "persister", realtime: false } });
    expect(out.filter((p) => p.subject === "feedeater.base_collector.backfill.seal").map((p) => [p.payload.blockNumber, p.payload.count])).toEqual([
      [100, 0],
      [101, 1],
      [102, 0],
      [103, 0],
    ]);
  });

  it("reports persistence missing without heartbeats and ok with one", async () => {
    const r = await connected(rig({ persisterTimeoutMs: 1000 }));
    expect(r.c.status().persistence.state).toBe("unknown");
    r.clock.t += 2000;
    expect(r.c.status().persistence.state).toBe("missing");
    r.bus.publish("feedeater.base_collector.ctl.persister", encodeJson({ v: 1, type: "persister", contiguousBlock: 7, gapCount: 2 }));
    expect(r.c.status().persistence).toMatchObject({ state: "ok", contiguousBlock: 7, gaps: 2 });
  });
});
