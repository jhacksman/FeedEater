import { describe, it, expect, beforeEach } from "vitest";
import { ModuleMetricsStore } from "../moduleMetrics.js";
import { getModuleLatency } from "../moduleLatency.js";

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

describe("GET /api/modules/:name/latency handler", () => {
  let store: ModuleMetricsStore;
  let now: number;

  beforeEach(() => {
    now = 1700000000000;
    store = new ModuleMetricsStore(() => now);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns zeros when no latency data exists", () => {
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getStatus()).toBe(200);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.p50_ms).toBe(0);
    expect(body.p95_ms).toBe(0);
    expect(body.p99_ms).toBe(0);
    expect(body.sample_count).toBe(0);
    expect(body.window_seconds).toBe(300);
  });

  it("returns correct percentiles for recorded latencies", () => {
    for (let i = 1; i <= 100; i++) {
      store.recordMessage("coinbase", i);
    }
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.module).toBe("coinbase");
    expect(body.p50_ms).toBe(50);
    expect(body.p95_ms).toBe(95);
    expect(body.p99_ms).toBe(99);
    expect(body.sample_count).toBe(100);
  });

  it("returns correct percentiles for small sample set", () => {
    store.recordMessage("bybit", 10);
    store.recordMessage("bybit", 20);
    store.recordMessage("bybit", 30);
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    const body = getBody();
    expect(body.sample_count).toBe(3);
    expect(body.p50_ms).toBe(20);
    expect(body.p95_ms).toBe(30);
    expect(body.p99_ms).toBe(30);
  });

  it("returns single sample for all percentiles", () => {
    store.recordMessage("gemini", 42);
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    const body = getBody();
    expect(body.p50_ms).toBe(42);
    expect(body.p95_ms).toBe(42);
    expect(body.p99_ms).toBe(42);
    expect(body.sample_count).toBe(1);
  });

  it("includes timestamp as ISO string", () => {
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    const body = getBody();
    expect(body.timestamp).toBe(new Date(now).toISOString());
  });

  it("defaults window_seconds to 300", () => {
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    expect(getBody().window_seconds).toBe(300);
  });

  it("accepts custom window query parameter", () => {
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi", { window: "60" }), res);
    expect(getBody().window_seconds).toBe(60);
  });

  it("ignores invalid window query parameter", () => {
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket", { window: "abc" }), res);
    expect(getBody().window_seconds).toBe(300);
  });

  it("returns correct response shape fields", () => {
    store.recordMessage("binance", 15);
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module");
    expect(body).toHaveProperty("p50_ms");
    expect(body).toHaveProperty("p95_ms");
    expect(body).toHaveProperty("p99_ms");
    expect(body).toHaveProperty("sample_count");
    expect(body).toHaveProperty("window_seconds");
    expect(body).toHaveProperty("timestamp");
    expect(typeof body.p50_ms).toBe("number");
    expect(typeof body.p95_ms).toBe("number");
    expect(typeof body.p99_ms).toBe("number");
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleLatency({ metricsStore: store, nowFn: () => now });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});
