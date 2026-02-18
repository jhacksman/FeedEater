import { describe, it, expect, beforeEach } from "vitest";
import { ModuleMetricsStore, getModuleMetrics } from "../moduleMetrics.js";

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

describe("ModuleMetricsStore", () => {
  let store: ModuleMetricsStore;
  let now: number;

  beforeEach(() => {
    now = 1700000000000;
    store = new ModuleMetricsStore(() => now);
  });

  it("returns null for untracked module", () => {
    expect(store.getMetrics("binance")).toBeNull();
  });

  it("tracks total_messages after recordMessage", () => {
    store.recordMessage("binance");
    store.recordMessage("binance");
    const m = store.getMetrics("binance")!;
    expect(m.total_messages).toBe(2);
  });

  it("tracks total_errors after recordError", () => {
    store.recordError("coinbase");
    store.recordError("coinbase");
    store.recordError("coinbase");
    const m = store.getMetrics("coinbase")!;
    expect(m.total_errors).toBe(3);
  });

  it("calculates message_rate over 5 min window", () => {
    store.recordMessage("bybit");
    store.recordMessage("bybit");
    store.recordMessage("bybit");
    const m = store.getMetrics("bybit")!;
    expect(m.message_rate).toBe(0.6);
  });

  it("excludes old messages from rate calculation", () => {
    store.recordMessage("gemini");
    now += 6 * 60 * 1000;
    const m = store.getMetrics("gemini")!;
    expect(m.message_rate).toBe(0);
    expect(m.total_messages).toBe(1);
  });

  it("calculates error_rate over 5 min window", () => {
    store.recordError("okx");
    store.recordError("okx");
    const m = store.getMetrics("okx")!;
    expect(m.error_rate).toBe(0.4);
  });

  it("computes uptime_seconds from startedAt", () => {
    store.recordStart("bitstamp");
    now += 120_000;
    const m = store.getMetrics("bitstamp")!;
    expect(m.uptime_seconds).toBe(120);
  });

  it("resets uptime on recordStart", () => {
    store.recordMessage("kalshi");
    now += 60_000;
    store.recordStart("kalshi");
    now += 30_000;
    const m = store.getMetrics("kalshi")!;
    expect(m.uptime_seconds).toBe(30);
  });

  it("computes avg_latency_ms from samples", () => {
    store.recordMessage("binance", 10);
    store.recordMessage("binance", 20);
    store.recordMessage("binance", 30);
    const m = store.getMetrics("binance")!;
    expect(m.avg_latency_ms).toBe(20);
  });

  it("returns null avg_latency_ms when no latency recorded", () => {
    store.recordMessage("coinbase");
    const m = store.getMetrics("coinbase")!;
    expect(m.avg_latency_ms).toBeNull();
  });

  it("sets last_message_at as ISO string", () => {
    store.recordMessage("polymarket");
    const m = store.getMetrics("polymarket")!;
    expect(m.last_message_at).toBe(new Date(now).toISOString());
  });

  it("tracks modules independently", () => {
    store.recordMessage("binance");
    store.recordMessage("binance");
    store.recordMessage("coinbase");
    expect(store.getMetrics("binance")!.total_messages).toBe(2);
    expect(store.getMetrics("coinbase")!.total_messages).toBe(1);
  });
});

describe("GET /api/modules/:name/metrics handler", () => {
  let store: ModuleMetricsStore;

  beforeEach(() => {
    store = new ModuleMetricsStore(() => 1700000000000);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleMetrics({ metricsStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns zeroed metrics for known module with no data", () => {
    const handler = getModuleMetrics({ metricsStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getStatus()).toBe(200);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.message_rate).toBe(0);
    expect(body.error_rate).toBe(0);
    expect(body.total_messages).toBe(0);
    expect(body.total_errors).toBe(0);
    expect(body.avg_latency_ms).toBeNull();
    expect(body.last_message_at).toBeNull();
  });

  it("returns populated metrics for tracked module", () => {
    store.recordMessage("coinbase", 15);
    store.recordMessage("coinbase", 25);
    store.recordError("coinbase");
    const handler = getModuleMetrics({ metricsStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.module).toBe("coinbase");
    expect(body.total_messages).toBe(2);
    expect(body.total_errors).toBe(1);
    expect(body.avg_latency_ms).toBe(20);
    expect(typeof body.message_rate).toBe("number");
    expect(typeof body.error_rate).toBe("number");
    expect(typeof body.last_message_at).toBe("string");
  });

  it("returns correct metric value types", () => {
    store.recordMessage("bybit", 5);
    const handler = getModuleMetrics({ metricsStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    const body = getBody();
    expect(typeof body.message_rate).toBe("number");
    expect(typeof body.error_rate).toBe("number");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(typeof body.total_messages).toBe("number");
    expect(typeof body.total_errors).toBe("number");
    expect(typeof body.avg_latency_ms).toBe("number");
    expect(typeof body.last_message_at).toBe("string");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleMetrics({ metricsStore: store });
    const { res, getStatus } = makeRes();
    handler({ params: { name: "" } } as any, res);
    expect(getStatus()).toBe(404);
  });
});
