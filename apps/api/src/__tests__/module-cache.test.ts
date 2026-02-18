import { describe, it, expect, beforeEach } from "vitest";
import { ModuleCacheStore, deleteModuleCache, getModuleCacheStats } from "../moduleCache.js";

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

describe("DELETE /api/modules/:name/cache", () => {
  let store: ModuleCacheStore;
  let tick: number;

  beforeEach(() => {
    tick = 1000;
    store = new ModuleCacheStore(() => tick++);
  });

  it("returns 404 for unknown module", () => {
    const handler = deleteModuleCache({ cacheStore: store, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = deleteModuleCache({ cacheStore: store, nowFn: () => 5000 });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns success response with correct shape", () => {
    const handler = deleteModuleCache({ cacheStore: store, nowFn: () => 1700000000000 });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("success", true);
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("cleared_at");
    expect(body.cleared_at).toBe(new Date(1700000000000).toISOString());
  });

  it("clears cached data for the module", () => {
    store.put("coinbase", "key1", { price: 100 });
    store.put("coinbase", "key2", { price: 200 });
    expect(store.getStats("coinbase").size).toBe(2);
    const handler = deleteModuleCache({ cacheStore: store, nowFn: () => 5000 });
    const { res } = makeRes();
    handler(makeReq("coinbase"), res);
    expect(store.getStats("coinbase").size).toBe(0);
  });

  it("does not affect other modules", () => {
    store.put("binance", "k1", { a: 1 });
    store.put("coinbase", "k1", { b: 2 });
    const handler = deleteModuleCache({ cacheStore: store, nowFn: () => 5000 });
    const { res } = makeRes();
    handler(makeReq("binance"), res);
    expect(store.getStats("binance").size).toBe(0);
    expect(store.getStats("coinbase").size).toBe(1);
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = deleteModuleCache({ cacheStore: store, nowFn: () => 5000 });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().success).toBe(true);
      expect(getBody().module).toBe(mod);
    }
  });

  it("can be called multiple times", () => {
    store.put("bybit", "k1", { x: 1 });
    const handler = deleteModuleCache({ cacheStore: store, nowFn: () => 5000 });
    const { res: r1, getBody: gb1 } = makeRes();
    handler(makeReq("bybit"), r1);
    expect(gb1().success).toBe(true);
    const { res: r2, getBody: gb2 } = makeRes();
    handler(makeReq("bybit"), r2);
    expect(gb2().success).toBe(true);
  });
});

describe("GET /api/modules/:name/cache-stats", () => {
  let store: ModuleCacheStore;
  let tick: number;

  beforeEach(() => {
    tick = 1000;
    store = new ModuleCacheStore(() => tick++);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct shape with zero stats", () => {
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("hits", 0);
    expect(body).toHaveProperty("misses", 0);
    expect(body).toHaveProperty("hit_ratio", 0);
    expect(body).toHaveProperty("size", 0);
    expect(body).toHaveProperty("last_cleared", null);
  });

  it("tracks cache hits", () => {
    store.put("gemini", "k1", { price: 50 });
    store.get("gemini", "k1");
    store.get("gemini", "k1");
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().hits).toBe(2);
    expect(getBody().misses).toBe(0);
    expect(getBody().hit_ratio).toBe(1);
    expect(getBody().size).toBe(1);
  });

  it("tracks cache misses", () => {
    store.get("okx", "nonexistent");
    store.get("okx", "also-missing");
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    expect(getBody().hits).toBe(0);
    expect(getBody().misses).toBe(2);
    expect(getBody().hit_ratio).toBe(0);
  });

  it("calculates hit ratio correctly", () => {
    store.put("bitstamp", "k1", { x: 1 });
    store.get("bitstamp", "k1");
    store.get("bitstamp", "k1");
    store.get("bitstamp", "k1");
    store.get("bitstamp", "missing");
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    expect(getBody().hits).toBe(3);
    expect(getBody().misses).toBe(1);
    expect(getBody().hit_ratio).toBe(0.75);
  });

  it("reflects cache size", () => {
    store.put("kalshi", "k1", { a: 1 });
    store.put("kalshi", "k2", { b: 2 });
    store.put("kalshi", "k3", { c: 3 });
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    expect(getBody().size).toBe(3);
  });

  it("shows last_cleared after DELETE", () => {
    store.put("polymarket", "k1", { x: 1 });
    store.clear("polymarket");
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    expect(getBody().last_cleared).not.toBeNull();
    expect(getBody().size).toBe(0);
  });

  it("preserves stats after cache clear", () => {
    store.put("aerodrome-base", "k1", { x: 1 });
    store.get("aerodrome-base", "k1");
    store.get("aerodrome-base", "missing");
    store.clear("aerodrome-base");
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("aerodrome-base"), res);
    expect(getBody().hits).toBe(1);
    expect(getBody().misses).toBe(1);
    expect(getBody().size).toBe(0);
  });

  it("modules are isolated", () => {
    store.put("binance", "k1", { a: 1 });
    store.get("binance", "k1");
    const handler = getModuleCacheStats({ cacheStore: store });
    const { res: r1, getBody: gb1 } = makeRes();
    handler(makeReq("binance"), r1);
    expect(gb1().hits).toBe(1);
    const { res: r2, getBody: gb2 } = makeRes();
    handler(makeReq("coinbase"), r2);
    expect(gb2().hits).toBe(0);
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleCacheStats({ cacheStore: store });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});
