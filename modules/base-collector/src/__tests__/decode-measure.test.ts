import { id as keccakId } from "ethers";
import { describe, expect, it } from "vitest";

import { TOPIC_INITIALIZE, TOPIC_SWAP } from "../constants.js";
import { decodeInitialize, decodeSwap } from "../decode.js";
import { Measurement } from "../measure.js";

/** Declared observation window covering every synthetic sample. */
const W = { startNs: 0n, endNs: 1n << 62n };
import { filterDigest } from "../subjects.js";
import { cfg, initLog, o1Hook, poolId, swapLog } from "./fixtures.js";

describe("decode", () => {
  it("uses the v4 event signatures", () => {
    expect(TOPIC_INITIALIZE).toBe(keccakId("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));
    expect(TOPIC_SWAP).toBe(keccakId("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
  });

  it("decodes ABI-encoded Initialize and Swap including signed fields", () => {
    const i = initLog({ block: 1, logIndex: 0, pool: poolId(1) });
    expect(decodeInitialize(i.topics, i.data)).toMatchObject({ hooks: o1Hook, fee: 10000, tickSpacing: 200, tick: -887200, poolId: poolId(1) });
    const s = swapLog({ block: 1, logIndex: 1, pool: poolId(1) });
    expect(decodeSwap(s.topics, s.data)).toMatchObject({ amount0: "-500000000000000000", amount1: "123456789", tick: -100, fee: 10000 });
    expect(decodeSwap(s.topics, "0x00")).toBeNull();
  });
});

describe("measurement bookkeeping (synthetic timestamps; not a latency result)", () => {
  const s = cfg();
  const status = { type: "status", headBlock: 10, filterDigest: filterDigest(s), persistence: { state: "ok" } };
  const live = (l: ReturnType<typeof swapLog>, extra: Record<string, unknown> = {}) => ({
    type: "log", id: `${l.blockHash}:${Number.parseInt(l.logIndex, 16)}`, removed: l.removed, path: "live", realtime: true, recovery: null, kind: "swap", ...extra,
  });

  it("scores delivery, duplicates, backfill-only recovery and contamination on one window", () => {
    const m = new Measurement(s);
    const P = poolId(1);
    const logs = [initLog({ block: 10, logIndex: 0, pool: P }), swapLog({ block: 10, logIndex: 1, pool: P }), swapLog({ block: 11, logIndex: 0, pool: P }), swapLog({ block: 12, logIndex: 0, pool: P })];
    logs.forEach((l, k) => m.recordDirect(l, BigInt(k) * 1_000_000n));
    m.recordBus("feedeater.base_collector.ctl.status", status, 0n);
    m.recordBus("feedeater.base_collector.initialize", live(logs[0]!, { kind: "initialize" }), 2_000_000n);
    m.recordBus("feedeater.base_collector.swap", live(logs[1]!), 3_000_000n);
    m.recordBus("feedeater.base_collector.swap", live(logs[1]!), 4_000_000n);
    m.recordBus("feedeater.base_collector.backfill.swap", live(logs[2]!, { path: "backfill", realtime: false, recovery: "reconnect" }), 9_000_000n);
    m.recordBus("feedeater.base_collector.swap", live(logs[2]!, { path: "backfill", realtime: false, recovery: "reconnect" }), 9_500_000n);
    const rep = m.report(10, 11, W);
    expect(rep).toMatchObject({ expected: 3, deliveredLive: 3, duplicateLivePublishes: 1, backfillOnLiveSubjects: 1, lateLiveAfterBackfill: 1, filterDigestVerified: true });
    expect(rep.dat011.pass).toBe(false);
    expect(m.report(10, 12, W)).toMatchObject({ expected: 4, missedLive: 1, missedEntirely: 1 });
  });

  it("does not pass without the collector's filter digest", () => {
    const m = new Measurement(s);
    const l = initLog({ block: 10, logIndex: 0, pool: poolId(1) });
    m.recordDirect(l, 0n);
    m.recordBus("feedeater.base_collector.initialize", live(l, { kind: "initialize" }), 1n);
    const rep = m.report(10, 10, W);
    expect(rep.dat011).toMatchObject({ liveDelivery100: true, p99AddedLe10ms: true, pass: false });
  });
});
