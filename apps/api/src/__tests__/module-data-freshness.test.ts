import { describe, it, expect, beforeEach } from "vitest";
import { DataFreshnessStore, getModuleDataFreshness } from "../moduleDataFreshness.js";

function makeReq(name: string) {
  return { params: { name } } as any;
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

describe("DataFreshnessStore", () => {
  let store: DataFreshnessStore;

  beforeEach(() => {
    store = new DataFreshnessStore();
  });

  it("returns null for unknown module", () => {
    expect(store.getDataTypes("binance")).toBeNull();
  });

  it("records and retrieves data type", () => {
    store.record("binance", "trades", 1000);
    const types = store.getDataTypes("binance")!;
    expect(types.size).toBe(1);
    expect(types.get("trades")!.timestamp).toBe(1000);
  });

  it("records multiple data types per module", () => {
    store.record("binance", "trades", 1000);
    store.record("binance", "orderbook", 2000);
    store.record("binance", "ticker", 3000);
    const types = store.getDataTypes("binance")!;
    expect(types.size).toBe(3);
  });

  it("overwrites data type on re-record", () => {
    store.record("binance", "trades", 1000);
    store.record("binance", "trades", 5000);
    const types = store.getDataTypes("binance")!;
    expect(types.get("trades")!.timestamp).toBe(5000);
  });

  it("tracks modules independently", () => {
    store.record("binance", "trades", 1000);
    store.record("coinbase", "trades", 2000);
    expect(store.getDataTypes("binance")!.size).toBe(1);
    expect(store.getDataTypes("coinbase")!.size).toBe(1);
  });

  it("clear removes all state", () => {
    store.record("binance", "trades", 1000);
    store.clear();
    expect(store.getDataTypes("binance")).toBeNull();
  });
});

describe("GET /api/modules/:name/data-freshness", () => {
  let store: DataFreshnessStore;
  const fixedNow = 120_000;

  beforeEach(() => {
    store = new DataFreshnessStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("nonexistent"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns empty data_types for known module with no data", () => {
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.data_types).toEqual({});
    expect(body).toHaveProperty("checked_at");
  });

  it("returns all expected fields per data type", () => {
    store.record("binance", "trades", fixedNow - 30_000);
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const trades = getBody().data_types.trades;
    expect(trades).toHaveProperty("last_received_at");
    expect(trades).toHaveProperty("age_seconds");
    expect(trades).toHaveProperty("is_stale");
  });

  it("computes age_seconds correctly", () => {
    store.record("binance", "trades", fixedNow - 45_000);
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().data_types.trades.age_seconds).toBe(45);
  });

  it("marks fresh data as not stale (age <= 60s)", () => {
    store.record("binance", "trades", fixedNow - 30_000);
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().data_types.trades.is_stale).toBe(false);
  });

  it("marks old data as stale (age > 60s)", () => {
    store.record("binance", "trades", fixedNow - 90_000);
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().data_types.trades.is_stale).toBe(true);
  });

  it("returns multiple data types", () => {
    store.record("binance", "trades", fixedNow - 10_000);
    store.record("binance", "orderbook", fixedNow - 30_000);
    store.record("binance", "ticker", fixedNow - 90_000);
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const dt = getBody().data_types;
    expect(Object.keys(dt).length).toBe(3);
    expect(dt.trades.is_stale).toBe(false);
    expect(dt.orderbook.is_stale).toBe(false);
    expect(dt.ticker.is_stale).toBe(true);
  });

  it("returns checked_at as ISO timestamp", () => {
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const d = new Date(getBody().checked_at);
    expect(isNaN(d.getTime())).toBe(false);
  });

  it("boundary: exactly 60s is not stale", () => {
    store.record("binance", "trades", fixedNow - 60_000);
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().data_types.trades.is_stale).toBe(false);
    expect(getBody().data_types.trades.age_seconds).toBe(60);
  });

  it("returns last_received_at as ISO string", () => {
    store.record("coinbase", "orderbook", fixedNow - 5_000);
    const handler = getModuleDataFreshness({ freshnessStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const d = new Date(getBody().data_types.orderbook.last_received_at);
    expect(isNaN(d.getTime())).toBe(false);
  });
});
