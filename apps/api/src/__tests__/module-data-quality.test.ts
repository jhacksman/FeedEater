import { describe, it, expect, beforeEach } from "vitest";
import { ModuleDataQualityStore, getModuleDataQuality } from "../moduleDataQuality.js";

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

describe("GET /api/modules/:name/data-quality", () => {
  let store: ModuleDataQualityStore;
  let now: number;

  beforeEach(() => {
    now = 1700000000000;
    store = new ModuleDataQualityStore(() => now);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape", () => {
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("message_rate");
    expect(body).toHaveProperty("gap_seconds");
    expect(body).toHaveProperty("duplicate_rate");
    expect(body).toHaveProperty("malformed_rate");
    expect(body).toHaveProperty("quality_score");
    expect(body).toHaveProperty("grade");
    expect(body).toHaveProperty("timestamp");
    expect(typeof body.message_rate).toBe("number");
    expect(typeof body.duplicate_rate).toBe("number");
    expect(typeof body.malformed_rate).toBe("number");
    expect(typeof body.quality_score).toBe("number");
    expect(typeof body.grade).toBe("string");
  });

  it("returns zeros when no data exists", () => {
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.message_rate).toBe(0);
    expect(body.gap_seconds).toBeNull();
    expect(body.duplicate_rate).toBe(0);
    expect(body.malformed_rate).toBe(0);
  });

  it("computes message_rate from last 60s", () => {
    for (let i = 0; i < 30; i++) {
      now = 1700000000000 + i * 1000;
      store.recordMessage("bybit");
    }
    now = 1700000000000 + 30_000;
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().message_rate).toBe(0.5);
  });

  it("computes gap_seconds from last message", () => {
    store.recordMessage("gemini");
    now += 10_000;
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().gap_seconds).toBe(10);
  });

  it("computes duplicate_rate correctly", () => {
    for (let i = 0; i < 100; i++) store.recordMessage("okx");
    for (let i = 0; i < 5; i++) store.recordDuplicate("okx");
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    expect(getBody().duplicate_rate).toBe(0.05);
  });

  it("computes malformed_rate correctly", () => {
    for (let i = 0; i < 200; i++) store.recordMessage("bitstamp");
    for (let i = 0; i < 10; i++) store.recordMalformed("bitstamp");
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    expect(getBody().malformed_rate).toBe(0.05);
  });

  it("returns quality_score 100 for fresh data with no issues", () => {
    store.recordMessage("binance");
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().quality_score).toBe(100);
    expect(getBody().grade).toBe("A");
  });

  it("penalizes large gap in quality_score", () => {
    store.recordMessage("kalshi");
    now += 120_000;
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    expect(getBody().quality_score).toBeLessThan(100);
  });

  it("penalizes no data with score <= 60", () => {
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    expect(getBody().quality_score).toBeLessThanOrEqual(60);
  });

  it("penalizes duplicates in quality_score", () => {
    for (let i = 0; i < 100; i++) store.recordMessage("binance");
    for (let i = 0; i < 10; i++) store.recordDuplicate("binance");
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().quality_score).toBeLessThan(100);
  });

  it("penalizes malformed in quality_score", () => {
    for (let i = 0; i < 100; i++) store.recordMessage("coinbase");
    for (let i = 0; i < 10; i++) store.recordMalformed("coinbase");
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    expect(getBody().quality_score).toBeLessThan(100);
  });

  it("grade A for score >= 90", () => {
    store.recordMessage("binance");
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().grade).toBe("A");
  });

  it("grade D for no-data module (score 60)", () => {
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("aerodrome-base"), res);
    expect(getBody().quality_score).toBe(60);
    expect(getBody().grade).toBe("D");
  });

  it("grade F for heavily degraded module", () => {
    for (let i = 0; i < 100; i++) store.recordMessage("uniswap-base");
    for (let i = 0; i < 50; i++) store.recordDuplicate("uniswap-base");
    for (let i = 0; i < 50; i++) store.recordMalformed("uniswap-base");
    now += 600_000;
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("uniswap-base"), res);
    expect(getBody().quality_score).toBeLessThan(60);
    expect(getBody().grade).toBe("F");
  });

  it("quality_score is clamped 0-100", () => {
    for (let i = 0; i < 100; i++) store.recordMessage("bybit");
    for (let i = 0; i < 50; i++) store.recordDuplicate("bybit");
    for (let i = 0; i < 50; i++) store.recordMalformed("bybit");
    now += 600_000;
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().quality_score).toBeGreaterThanOrEqual(0);
    expect(getBody().quality_score).toBeLessThanOrEqual(100);
  });

  it("timestamp is valid ISO string", () => {
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().timestamp).toBe(new Date(now).toISOString());
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleDataQuality({ qualityStore: store, nowFn: () => now });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});
