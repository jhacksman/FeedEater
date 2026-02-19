import { describe, it, expect, beforeEach } from "vitest";
import { DataSampleStore, getModuleDataSample } from "../moduleDataSample.js";

function makeReq(name: string) {
  return { params: { name } } as any;
}

function makeRes() {
  let statusCode = 200;
  let body: any;
  let ended = false;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: any) { body = data; },
    end() { ended = true; },
  } as any;
  return { res, getStatus: () => statusCode, getBody: () => body, isEnded: () => ended };
}

describe("DataSampleStore", () => {
  let store: DataSampleStore;

  beforeEach(() => {
    store = new DataSampleStore();
  });

  it("returns null for unknown module", () => {
    expect(store.get("binance")).toBeNull();
  });

  it("records and retrieves a sample", () => {
    store.record("binance", { price: 50000, symbol: "BTC/USDT" }, 1000);
    const sample = store.get("binance")!;
    expect(sample.data).toEqual({ price: 50000, symbol: "BTC/USDT" });
    expect(sample.timestamp).toBe(1000);
  });

  it("overwrites previous sample", () => {
    store.record("binance", { price: 50000 }, 1000);
    store.record("binance", { price: 51000 }, 2000);
    const sample = store.get("binance")!;
    expect(sample.data).toEqual({ price: 51000 });
    expect(sample.timestamp).toBe(2000);
  });

  it("tracks modules independently", () => {
    store.record("binance", { price: 50000 }, 1000);
    store.record("coinbase", { price: 50100 }, 2000);
    expect(store.get("binance")!.data).toEqual({ price: 50000 });
    expect(store.get("coinbase")!.data).toEqual({ price: 50100 });
  });

  it("clear removes all samples", () => {
    store.record("binance", { price: 50000 }, 1000);
    store.clear();
    expect(store.get("binance")).toBeNull();
  });
});

describe("GET /api/modules/:name/data-sample", () => {
  let store: DataSampleStore;
  const fixedNow = 120_000;

  beforeEach(() => {
    store = new DataSampleStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleDataSample({ sampleStore: store, nowFn: () => fixedNow });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("nonexistent"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 204 if no data yet for known module", () => {
    const handler = getModuleDataSample({ sampleStore: store, nowFn: () => fixedNow });
    const { res, getStatus, isEnded } = makeRes();
    handler(makeReq("binance"), res);
    expect(getStatus()).toBe(204);
    expect(isEnded()).toBe(true);
  });

  it("returns sample data when available", () => {
    store.record("binance", { price: 50000, symbol: "BTC/USDT" }, fixedNow - 5_000);
    const handler = getModuleDataSample({ sampleStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.sample).toEqual({ price: 50000, symbol: "BTC/USDT" });
  });

  it("includes sampled_at as ISO timestamp", () => {
    store.record("binance", { price: 50000 }, fixedNow - 10_000);
    const handler = getModuleDataSample({ sampleStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const d = new Date(getBody().sampled_at);
    expect(isNaN(d.getTime())).toBe(false);
  });

  it("includes schema_version", () => {
    store.record("binance", { price: 50000 }, fixedNow - 10_000);
    const handler = getModuleDataSample({ sampleStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().schema_version).toBe("1.0.0");
  });

  it("returns all expected fields", () => {
    store.record("coinbase", { bid: 100, ask: 101 }, fixedNow - 1_000);
    const handler = getModuleDataSample({ sampleStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body).toHaveProperty("module");
    expect(body).toHaveProperty("sample");
    expect(body).toHaveProperty("sampled_at");
    expect(body).toHaveProperty("schema_version");
  });

  it("returns latest sample after overwrite", () => {
    store.record("binance", { price: 50000 }, fixedNow - 30_000);
    store.record("binance", { price: 51000 }, fixedNow - 5_000);
    const handler = getModuleDataSample({ sampleStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().sample).toEqual({ price: 51000 });
  });

  it("returns correct sampled_at from store timestamp", () => {
    const ts = new Date("2026-03-01T12:00:00Z").getTime();
    store.record("bybit", { vol: 999 }, ts);
    const handler = getModuleDataSample({ sampleStore: store, nowFn: () => ts + 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().sampled_at).toBe("2026-03-01T12:00:00.000Z");
  });
});
