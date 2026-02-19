import { describe, it, expect, beforeEach } from "vitest";
import { LastUpdateStore, getModuleLastUpdate } from "../moduleLastUpdate.js";

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

describe("GET /api/modules/:name/last-update", () => {
  let store: LastUpdateStore;
  let tick: number;

  beforeEach(() => {
    tick = 1700000000000;
    store = new LastUpdateStore(() => tick);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns null fields when no updates recorded", () => {
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.last_update_at).toBeNull();
    expect(body.seconds_ago).toBeNull();
    expect(body.update_count_last_60s).toBe(0);
    expect(body.record_count).toBe(0);
  });

  it("returns correct response shape with data", () => {
    store.record("binance", 10);
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module");
    expect(body).toHaveProperty("last_update_at");
    expect(body).toHaveProperty("seconds_ago");
    expect(body).toHaveProperty("update_count_last_60s");
    expect(body).toHaveProperty("data_type");
    expect(body).toHaveProperty("record_count");
  });

  it("last_update_at is ISO format", () => {
    store.record("coinbase", 5);
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    expect(getBody().last_update_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("computes seconds_ago correctly", () => {
    store.record("bybit", 3);
    tick += 5000;
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().seconds_ago).toBe(5);
  });

  it("returns record_count from latest update", () => {
    store.record("gemini", 7);
    tick += 1000;
    store.record("gemini", 15);
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().record_count).toBe(15);
  });

  it("counts updates in last 60 seconds", () => {
    for (let i = 0; i < 5; i++) {
      store.record("bitstamp", 1);
      tick += 10000;
    }
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    expect(getBody().update_count_last_60s).toBeGreaterThanOrEqual(5);
  });

  it("excludes updates older than 60 seconds from count", () => {
    store.record("okx", 1);
    tick += 70000;
    store.record("okx", 2);
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    expect(getBody().update_count_last_60s).toBe(1);
  });

  it("returns trade data_type for CEX modules", () => {
    store.record("binance", 1);
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().data_type).toBe("trade");
  });

  it("returns event data_type for prediction market modules", () => {
    store.record("kalshi", 1);
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    expect(getBody().data_type).toBe("event");
  });

  it("returns swap data_type for DEX modules", () => {
    store.record("aerodrome-base", 1);
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("aerodrome-base"), res);
    expect(getBody().data_type).toBe("swap");
  });

  it("isolates data between modules", () => {
    store.record("binance", 10);
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res: res1, getBody: getBody1 } = makeRes();
    handler(makeReq("binance"), res1);
    expect(getBody1().record_count).toBe(10);

    const { res: res2, getBody: getBody2 } = makeRes();
    handler(makeReq("coinbase"), res2);
    expect(getBody2().last_update_at).toBeNull();
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });

  it("seconds_ago is 0 when update is current", () => {
    store.record("binance", 1);
    const handler = getModuleLastUpdate({ updateStore: store, nowFn: () => tick });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().seconds_ago).toBe(0);
  });
});

describe("LastUpdateStore", () => {
  it("evicts old entries beyond 100k", () => {
    let t = 1000;
    const store = new LastUpdateStore(() => t++);
    for (let i = 0; i < 100_005; i++) {
      store.record("binance", 1);
    }
    const latest = store.getLatest("binance");
    expect(latest).not.toBeNull();
  });
});
