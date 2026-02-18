import { describe, it, expect, beforeEach } from "vitest";
import { getSystemMetrics } from "../systemMetrics.js";
import { ModuleMetricsStore } from "../moduleMetrics.js";
import { ReconnectStatsStore } from "../moduleReconnectStats.js";
import { UptimeStore } from "../moduleUptime.js";
import type { Request, Response } from "express";

function makeReq(): Request {
  return { params: {}, query: {} } as unknown as Request;
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

describe("GET /api/system/metrics", () => {
  let metricsStore: ModuleMetricsStore;
  let reconnectStore: ReconnectStatsStore;
  let uptimeStore: UptimeStore;
  const NOW = new Date("2025-06-01T12:00:00.000Z").getTime();

  beforeEach(() => {
    metricsStore = new ModuleMetricsStore(() => NOW);
    reconnectStore = new ReconnectStatsStore();
    uptimeStore = new UptimeStore();
  });

  it("returns zeros for empty system", () => {
    const handler = getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total_modules).toBe(10);
    expect(res.body.active_modules).toBe(0);
    expect(res.body.total_messages_processed).toBe(0);
    expect(res.body.total_errors).toBe(0);
    expect(res.body.avg_uptime_seconds).toBe(0);
    expect(res.body.total_reconnects).toBe(0);
    expect(res.body.system_throughput_per_second).toBe(0);
  });

  it("aggregates messages across multiple modules", () => {
    metricsStore.recordMessage("binance");
    metricsStore.recordMessage("binance");
    metricsStore.recordMessage("coinbase");
    const handler = getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body.active_modules).toBe(2);
    expect(res.body.total_messages_processed).toBe(3);
  });

  it("aggregates errors across modules", () => {
    metricsStore.recordError("binance");
    metricsStore.recordError("binance");
    metricsStore.recordError("coinbase");
    const handler = getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body.total_errors).toBe(3);
  });

  it("aggregates reconnects across modules", () => {
    (reconnectStore as any).timestamps.set("binance", [NOW - 5000, NOW - 3000]);
    (reconnectStore as any).timestamps.set("coinbase", [NOW - 1000]);
    const handler = getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body.total_reconnects).toBe(3);
  });

  it("computes avg_uptime_seconds from uptime store", () => {
    (uptimeStore as any).modules.set("binance", { startedAt: NOW - 120_000, restartCount: 0, lastRestartAt: null });
    (uptimeStore as any).modules.set("coinbase", { startedAt: NOW - 60_000, restartCount: 0, lastRestartAt: null });
    const handler = getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body.avg_uptime_seconds).toBe(90);
  });

  it("computes system_throughput_per_second from recent messages", () => {
    metricsStore.recordMessage("binance");
    metricsStore.recordMessage("binance");
    metricsStore.recordMessage("coinbase");
    const handler = getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body.system_throughput_per_second).toBe(0.05);
  });

  it("returns timestamp in ISO format", () => {
    const handler = getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body.timestamp).toBe(new Date(NOW).toISOString());
  });

  it("has correct response shape", () => {
    const handler = getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq(), res);
    const keys = Object.keys(res.body);
    expect(keys).toContain("total_modules");
    expect(keys).toContain("active_modules");
    expect(keys).toContain("total_messages_processed");
    expect(keys).toContain("total_errors");
    expect(keys).toContain("avg_uptime_seconds");
    expect(keys).toContain("total_reconnects");
    expect(keys).toContain("system_throughput_per_second");
    expect(keys).toContain("timestamp");
  });

  it("total_modules reflects KNOWN_MODULES size", () => {
    const handler = getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body.total_modules).toBe(10);
  });
});
