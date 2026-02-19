import { describe, it, expect, beforeEach } from "vitest";
import { StorageStore, getSystemStorage } from "../systemStorage.js";

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

describe("StorageStore", () => {
  let store: StorageStore;

  beforeEach(() => {
    store = new StorageStore();
  });

  it("starts with empty defaults", () => {
    const state = store.getState();
    expect(state.db_size_mb).toBe(0);
    expect(state.db_path).toBeNull();
    expect(state.oldest_record_at).toBeNull();
    expect(state.newest_record_at).toBeNull();
    expect(state.total_records).toBe(0);
    expect(state.records_per_module).toEqual({});
    expect(state.estimated_daily_growth_mb).toBe(0);
  });

  it("update sets partial fields", () => {
    store.update({ db_size_mb: 42.5, db_path: "/data/feedeater.db" });
    const state = store.getState();
    expect(state.db_size_mb).toBe(42.5);
    expect(state.db_path).toBe("/data/feedeater.db");
    expect(state.total_records).toBe(0);
  });

  it("update overwrites previous values", () => {
    store.update({ db_size_mb: 10 });
    store.update({ db_size_mb: 20 });
    expect(store.getState().db_size_mb).toBe(20);
  });

  it("recordInsert increments total and per-module counts", () => {
    store.recordInsert("binance", "2026-01-01T00:00:00Z");
    store.recordInsert("binance", "2026-01-01T00:01:00Z");
    store.recordInsert("coinbase", "2026-01-01T00:02:00Z");
    const state = store.getState();
    expect(state.total_records).toBe(3);
    expect(state.records_per_module["binance"]).toBe(2);
    expect(state.records_per_module["coinbase"]).toBe(1);
  });

  it("recordInsert tracks oldest and newest timestamps", () => {
    store.recordInsert("binance", "2026-01-02T00:00:00Z");
    store.recordInsert("binance", "2026-01-01T00:00:00Z");
    store.recordInsert("binance", "2026-01-03T00:00:00Z");
    const state = store.getState();
    expect(state.oldest_record_at).toBe("2026-01-01T00:00:00Z");
    expect(state.newest_record_at).toBe("2026-01-03T00:00:00Z");
  });

  it("getState returns a copy of records_per_module", () => {
    store.recordInsert("binance", "2026-01-01T00:00:00Z");
    const state1 = store.getState();
    state1.records_per_module["binance"] = 999;
    expect(store.getState().records_per_module["binance"]).toBe(1);
  });

  it("clear resets all state", () => {
    store.update({ db_size_mb: 50, db_path: "/data/test.db", estimated_daily_growth_mb: 2.5 });
    store.recordInsert("binance", "2026-01-01T00:00:00Z");
    store.clear();
    const state = store.getState();
    expect(state.db_size_mb).toBe(0);
    expect(state.db_path).toBeNull();
    expect(state.total_records).toBe(0);
    expect(state.records_per_module).toEqual({});
    expect(state.oldest_record_at).toBeNull();
  });

  it("update can set estimated_daily_growth_mb", () => {
    store.update({ estimated_daily_growth_mb: 3.7 });
    expect(store.getState().estimated_daily_growth_mb).toBe(3.7);
  });
});

describe("GET /api/system/storage", () => {
  let store: StorageStore;
  const fixedNow = 120_000;

  beforeEach(() => {
    store = new StorageStore();
  });

  it("returns all expected fields", () => {
    const handler = getSystemStorage({ storageStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("db_size_mb");
    expect(body).toHaveProperty("db_path");
    expect(body).toHaveProperty("oldest_record_at");
    expect(body).toHaveProperty("newest_record_at");
    expect(body).toHaveProperty("total_records");
    expect(body).toHaveProperty("records_per_module");
    expect(body).toHaveProperty("estimated_daily_growth_mb");
    expect(body).toHaveProperty("checked_at");
  });

  it("returns default empty state", () => {
    const handler = getSystemStorage({ storageStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.db_size_mb).toBe(0);
    expect(body.total_records).toBe(0);
    expect(body.records_per_module).toEqual({});
  });

  it("reflects store state", () => {
    store.update({ db_size_mb: 128.5, db_path: "/data/feedeater.db", estimated_daily_growth_mb: 5.2 });
    store.recordInsert("binance", "2026-01-01T00:00:00Z");
    store.recordInsert("coinbase", "2026-01-02T00:00:00Z");
    const handler = getSystemStorage({ storageStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.db_size_mb).toBe(128.5);
    expect(body.db_path).toBe("/data/feedeater.db");
    expect(body.total_records).toBe(2);
    expect(body.records_per_module["binance"]).toBe(1);
    expect(body.estimated_daily_growth_mb).toBe(5.2);
  });

  it("returns checked_at as ISO timestamp", () => {
    const handler = getSystemStorage({ storageStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const d = new Date(getBody().checked_at);
    expect(isNaN(d.getTime())).toBe(false);
  });
});
