import { describe, it, expect, beforeEach } from "vitest";
import { ModuleMetricsStore } from "../moduleMetrics.js";
import { getModuleThroughput } from "../moduleThroughput.js";

function makeReq(name: string, query: Record<string, string> = {}) {
  return { params: { name }, query } as any;
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

describe("GET /api/modules/:name/throughput handler", () => {
  let store: ModuleMetricsStore;
  let now: number;

  beforeEach(() => {
    now = 1700000000000;
    store = new ModuleMetricsStore(() => now);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns zeros when no data exists", () => {
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getStatus()).toBe(200);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.messages_per_second).toBe(0);
    expect(body.total_messages).toBe(0);
    expect(body.peak_messages_per_second).toBe(0);
    expect(body.window_seconds).toBe(60);
  });

  it("returns correct throughput with recorded messages", () => {
    for (let i = 0; i < 30; i++) {
      store.recordMessage("coinbase");
    }
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.module).toBe("coinbase");
    expect(body.total_messages).toBe(30);
    expect(body.messages_per_second).toBe(0.5);
    expect(body.peak_messages_per_second).toBe(30);
  });

  it("filters messages outside the window", () => {
    store.recordMessage("bybit");
    store.recordMessage("bybit");
    now += 120_000;
    store.recordMessage("bybit");
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    const body = getBody();
    expect(body.total_messages).toBe(1);
  });

  it("accepts custom window query parameter", () => {
    store.recordMessage("gemini");
    now += 90_000;
    store.recordMessage("gemini");
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini", { window: "120" }), res);
    const body = getBody();
    expect(body.window_seconds).toBe(120);
    expect(body.total_messages).toBe(2);
  });

  it("ignores invalid window query parameter", () => {
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("okx", { window: "abc" }), res);
    expect(getBody().window_seconds).toBe(60);
  });

  it("computes peak_messages_per_second from 1s buckets", () => {
    store.recordMessage("bitstamp");
    store.recordMessage("bitstamp");
    store.recordMessage("bitstamp");
    now += 2000;
    store.recordMessage("bitstamp");
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    const body = getBody();
    expect(body.peak_messages_per_second).toBe(3);
    expect(body.total_messages).toBe(4);
  });

  it("includes timestamp as ISO string", () => {
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    expect(getBody().timestamp).toBe(new Date(now).toISOString());
  });

  it("returns correct response shape fields", () => {
    store.recordMessage("polymarket");
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    const body = getBody();
    expect(body).toHaveProperty("module");
    expect(body).toHaveProperty("messages_per_second");
    expect(body).toHaveProperty("total_messages");
    expect(body).toHaveProperty("window_seconds");
    expect(body).toHaveProperty("peak_messages_per_second");
    expect(body).toHaveProperty("timestamp");
    expect(typeof body.messages_per_second).toBe("number");
    expect(typeof body.peak_messages_per_second).toBe("number");
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleThroughput({ metricsStore: store, nowFn: () => now });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});
