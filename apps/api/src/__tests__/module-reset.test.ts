import { describe, it, expect, beforeEach } from "vitest";
import { postModuleReset } from "../moduleReset.js";
import { ModuleMetricsStore } from "../moduleMetrics.js";
import { ReconnectStatsStore } from "../moduleReconnectStats.js";
import type { Request, Response } from "express";

const NOW = new Date("2025-06-01T12:00:00.000Z").getTime();

function makeReq(params: Record<string, string> = {}, body?: unknown): Request {
  return { params, query: {}, body } as unknown as Request;
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(obj: unknown) {
      res.body = obj;
      return res;
    },
  };
  return res as Response & { statusCode: number; body: any };
}

describe("POST /api/modules/:name/reset", () => {
  let metricsStore: ModuleMetricsStore;
  let reconnectStore: ReconnectStatsStore;

  beforeEach(() => {
    metricsStore = new ModuleMetricsStore(() => NOW);
    reconnectStore = new ReconnectStatsStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "unknown-xyz" }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", () => {
    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({}), res);
    expect(res.statusCode).toBe(404);
  });

  it("resets all counters when no body provided", () => {
    metricsStore.recordMessage("binance");
    metricsStore.recordError("binance");
    (reconnectStore as any).timestamps.set("binance", [NOW - 1000]);

    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.module_name).toBe("binance");
    expect(res.body.counters_reset).toEqual(["errors", "reconnects", "throughput"]);
    expect(res.body.reset_at).toBe(new Date(NOW).toISOString());

    const metrics = metricsStore.getMetrics("binance");
    expect(metrics?.total_errors).toBe(0);
    expect(metrics?.total_messages).toBe(0);
    expect(reconnectStore.getTimestamps("binance")).toEqual([]);
  });

  it("resets only errors when specified", () => {
    metricsStore.recordMessage("coinbase");
    metricsStore.recordError("coinbase");
    metricsStore.recordError("coinbase");

    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "coinbase" }, { counters: ["errors"] }), res);

    expect(res.body.counters_reset).toEqual(["errors"]);
    const metrics = metricsStore.getMetrics("coinbase");
    expect(metrics?.total_errors).toBe(0);
    expect(metrics?.total_messages).toBe(1);
  });

  it("resets only reconnects when specified", () => {
    (reconnectStore as any).timestamps.set("bybit", [NOW - 5000, NOW - 3000]);
    metricsStore.recordError("bybit");

    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "bybit" }, { counters: ["reconnects"] }), res);

    expect(res.body.counters_reset).toEqual(["reconnects"]);
    expect(reconnectStore.getTimestamps("bybit")).toEqual([]);
    expect(metricsStore.getMetrics("bybit")?.total_errors).toBe(1);
  });

  it("resets only throughput when specified", () => {
    metricsStore.recordMessage("gemini");
    metricsStore.recordMessage("gemini");
    metricsStore.recordError("gemini");

    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "gemini" }, { counters: ["throughput"] }), res);

    expect(res.body.counters_reset).toEqual(["throughput"]);
    const metrics = metricsStore.getMetrics("gemini");
    expect(metrics?.total_messages).toBe(0);
    expect(metrics?.total_errors).toBe(1);
  });

  it("resets multiple specific counters", () => {
    metricsStore.recordMessage("okx");
    metricsStore.recordError("okx");
    (reconnectStore as any).timestamps.set("okx", [NOW - 1000]);

    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "okx" }, { counters: ["errors", "reconnects"] }), res);

    expect(res.body.counters_reset).toEqual(["errors", "reconnects"]);
    expect(metricsStore.getMetrics("okx")?.total_errors).toBe(0);
    expect(reconnectStore.getTimestamps("okx")).toEqual([]);
    expect(metricsStore.getMetrics("okx")?.total_messages).toBe(1);
  });

  it("returns 400 for invalid counter names", () => {
    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }, { counters: ["invalid"] }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("Invalid counters");
  });

  it("resets all when counters array is empty", () => {
    metricsStore.recordError("bitstamp");
    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "bitstamp" }, { counters: [] }), res);
    expect(res.body.counters_reset).toEqual(["errors", "reconnects", "throughput"]);
  });

  it("includes reset_at timestamp in ISO format", () => {
    const handler = postModuleReset({ metricsStore, reconnectStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "kalshi" }), res);
    expect(res.body.reset_at).toBe("2025-06-01T12:00:00.000Z");
  });
});
