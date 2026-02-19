import { describe, it, expect, beforeEach } from "vitest";
import { BandwidthStore, getSystemBandwidth } from "../systemBandwidth.js";

function makeReq() {
  return {} as any;
}

function makeRes() {
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: any) { body = data; },
  } as any;
  return { res, getStatus: () => statusCode, getBody: () => body };
}

describe("BandwidthStore", () => {
  let store: BandwidthStore;

  beforeEach(() => {
    store = new BandwidthStore();
  });

  it("starts empty", () => {
    expect(store.getSamples(0)).toEqual([]);
  });

  it("records and retrieves samples", () => {
    store.record("binance", 100, 50, 1000);
    const samples = store.getSamples(0);
    expect(samples.length).toBe(1);
    expect(samples[0].module).toBe("binance");
    expect(samples[0].bytesIn).toBe(100);
    expect(samples[0].bytesOut).toBe(50);
  });

  it("filters by window start", () => {
    store.record("binance", 100, 50, 1000);
    store.record("binance", 200, 100, 2000);
    expect(store.getSamples(1500).length).toBe(1);
    expect(store.getSamples(3000).length).toBe(0);
  });

  it("clear removes all samples", () => {
    store.record("binance", 100, 50, 1000);
    store.clear();
    expect(store.getSamples(0)).toEqual([]);
  });

  it("prune removes old samples", () => {
    store.record("binance", 100, 50, 1000);
    store.record("binance", 200, 100, 2000);
    store.prune(1500);
    expect(store.getSamples(0).length).toBe(1);
    expect(store.getSamples(0)[0].timestamp).toBe(2000);
  });
});

describe("GET /api/system/bandwidth", () => {
  let store: BandwidthStore;
  const fixedNow = 120_000;

  beforeEach(() => {
    store = new BandwidthStore();
  });

  it("returns correct response shape with no data", () => {
    const handler = getSystemBandwidth({ bandwidthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("system");
    expect(body).toHaveProperty("modules");
    expect(body).toHaveProperty("sampled_at");
    expect(body.system).toHaveProperty("in_bps");
    expect(body.system).toHaveProperty("out_bps");
    expect(body.system).toHaveProperty("total_messages_sec");
  });

  it("returns zero bandwidth when no samples", () => {
    const handler = getSystemBandwidth({ bandwidthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.system.in_bps).toBe(0);
    expect(body.system.out_bps).toBe(0);
    expect(body.system.total_messages_sec).toBe(0);
  });

  it("includes all known modules in response", () => {
    const handler = getSystemBandwidth({ bandwidthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const modules = getBody().modules;
    expect(modules).toHaveProperty("binance");
    expect(modules).toHaveProperty("coinbase");
    expect(modules).toHaveProperty("kalshi");
    expect(modules).toHaveProperty("uniswap-base");
  });

  it("computes per-module bandwidth from samples", () => {
    store.record("binance", 6000, 3000, fixedNow - 30_000);
    const handler = getSystemBandwidth({ bandwidthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.modules.binance.in_bps).toBe(100);
    expect(body.modules.binance.out_bps).toBe(50);
  });

  it("computes system totals from multiple modules", () => {
    store.record("binance", 6000, 3000, fixedNow - 10_000);
    store.record("coinbase", 6000, 3000, fixedNow - 10_000);
    const handler = getSystemBandwidth({ bandwidthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.system.in_bps).toBe(200);
    expect(body.system.out_bps).toBe(100);
  });

  it("excludes samples outside 60-second window", () => {
    store.record("binance", 6000, 3000, fixedNow - 90_000);
    const handler = getSystemBandwidth({ bandwidthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().modules.binance.in_bps).toBe(0);
    expect(getBody().system.in_bps).toBe(0);
  });

  it("computes total_messages_sec correctly", () => {
    for (let i = 0; i < 60; i++) {
      store.record("binance", 100, 50, fixedNow - i * 500);
    }
    const handler = getSystemBandwidth({ bandwidthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().system.total_messages_sec).toBe(1);
  });

  it("returns sampled_at as ISO timestamp", () => {
    const handler = getSystemBandwidth({ bandwidthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const d = new Date(getBody().sampled_at);
    expect(isNaN(d.getTime())).toBe(false);
  });

  it("returns zero for modules with no samples", () => {
    store.record("binance", 6000, 3000, fixedNow - 10_000);
    const handler = getSystemBandwidth({ bandwidthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().modules.coinbase.in_bps).toBe(0);
    expect(getBody().modules.coinbase.out_bps).toBe(0);
  });
});
