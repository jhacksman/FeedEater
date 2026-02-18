import { describe, it, expect, beforeEach } from "vitest";
import { getSystemCapacity } from "../systemCapacity.js";
import { ModuleMetricsStore } from "../moduleMetrics.js";

const NOW = new Date("2025-06-01T12:00:00.000Z").getTime();

function makeReq() {
  return {} as any;
}

function makeRes() {
  let body: any;
  const res = {
    json(data: any) { body = data; },
  } as any;
  return { res, getBody: () => body };
}

describe("GET /api/system/capacity", () => {
  let metricsStore: ModuleMetricsStore;

  beforeEach(() => {
    metricsStore = new ModuleMetricsStore(() => NOW);
  });

  it("returns correct response shape with all fields", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("cpu_usage_pct");
    expect(body).toHaveProperty("memory_used_mb");
    expect(body).toHaveProperty("memory_total_mb");
    expect(body).toHaveProperty("memory_usage_pct");
    expect(body).toHaveProperty("active_connections");
    expect(body).toHaveProperty("max_connections");
    expect(body).toHaveProperty("db_size_mb");
    expect(body).toHaveProperty("message_queue_depth");
    expect(body).toHaveProperty("timestamp");
  });

  it("all numeric fields are numbers", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(typeof body.cpu_usage_pct).toBe("number");
    expect(typeof body.memory_used_mb).toBe("number");
    expect(typeof body.memory_total_mb).toBe("number");
    expect(typeof body.memory_usage_pct).toBe("number");
    expect(typeof body.active_connections).toBe("number");
    expect(typeof body.max_connections).toBe("number");
    expect(typeof body.db_size_mb).toBe("number");
    expect(typeof body.message_queue_depth).toBe("number");
  });

  it("memory_used_mb is positive", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().memory_used_mb).toBeGreaterThan(0);
  });

  it("memory_total_mb is positive", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().memory_total_mb).toBeGreaterThan(0);
  });

  it("memory_used_mb <= memory_total_mb", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().memory_used_mb).toBeLessThanOrEqual(getBody().memory_total_mb);
  });

  it("memory_usage_pct is between 0 and 100", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().memory_usage_pct).toBeGreaterThanOrEqual(0);
    expect(getBody().memory_usage_pct).toBeLessThanOrEqual(100);
  });

  it("active_connections is 0 when no modules have data", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().active_connections).toBe(0);
  });

  it("active_connections increases with module activity", () => {
    metricsStore.recordMessage("binance");
    metricsStore.recordMessage("coinbase");
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().active_connections).toBe(2);
  });

  it("max_connections defaults to 100", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().max_connections).toBe(100);
  });

  it("max_connections respects override", () => {
    const handler = getSystemCapacity({ metricsStore, maxConnections: 50, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().max_connections).toBe(50);
  });

  it("message_queue_depth counts recent messages within 60s window", () => {
    metricsStore.recordMessage("binance");
    metricsStore.recordMessage("binance");
    metricsStore.recordMessage("coinbase");
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().message_queue_depth).toBe(3);
  });

  it("timestamp is a valid ISO string", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().timestamp).toBe("2025-06-01T12:00:00.000Z");
  });

  it("cpu_usage_pct is non-negative", () => {
    const handler = getSystemCapacity({ metricsStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().cpu_usage_pct).toBeGreaterThanOrEqual(0);
  });
});
