import { describe, it, expect, beforeEach } from "vitest";
import { getModuleUptime, UptimeStore } from "../moduleUptime.js";
import type { Request, Response } from "express";

function makeReq(params: Record<string, string> = {}): Request {
  return { params, query: {} } as unknown as Request;
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

describe("GET /api/modules/:name/uptime", () => {
  let store: UptimeStore;
  const NOW = new Date("2025-06-01T12:00:00.000Z").getTime();

  beforeEach(() => {
    store = new UptimeStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "unknown-xyz" }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({}), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns zeros when no uptime data exists", () => {
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.module).toBe("binance");
    expect(res.body.uptime_seconds).toBe(0);
    expect(res.body.uptime_human).toBe("0s");
    expect(res.body.started_at).toBeNull();
    expect(res.body.restart_count).toBe(0);
    expect(res.body.last_restart_at).toBeNull();
    expect(res.body.status).toBe("unknown");
  });

  it("returns uptime when module has started", () => {
    const startTime = NOW - 135_000;
    (store as any).modules.set("binance", { startedAt: startTime, restartCount: 0, lastRestartAt: null });
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.uptime_seconds).toBe(135);
    expect(res.body.started_at).toBe(new Date(startTime).toISOString());
    expect(res.body.restart_count).toBe(0);
    expect(res.body.last_restart_at).toBeNull();
    expect(res.body.status).toBe("running");
  });

  it("tracks restart count and last_restart_at", () => {
    const firstStart = NOW - 300_000;
    const secondStart = NOW - 60_000;
    (store as any).modules.set("coinbase", { startedAt: secondStart, restartCount: 1, lastRestartAt: firstStart });
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "coinbase" }), res);
    expect(res.body.restart_count).toBe(1);
    expect(res.body.last_restart_at).toBe(new Date(firstStart).toISOString());
    expect(res.body.uptime_seconds).toBe(60);
  });

  it("formats uptime_human with seconds only", () => {
    (store as any).modules.set("bybit", { startedAt: NOW - 45_000, restartCount: 0, lastRestartAt: null });
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "bybit" }), res);
    expect(res.body.uptime_human).toBe("45s");
  });

  it("formats uptime_human with minutes", () => {
    (store as any).modules.set("gemini", { startedAt: NOW - 180_000, restartCount: 0, lastRestartAt: null });
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "gemini" }), res);
    expect(res.body.uptime_human).toBe("3m");
  });

  it("formats uptime_human with hours and minutes", () => {
    const twoHours15Min = (2 * 3600 + 15 * 60) * 1000;
    (store as any).modules.set("okx", { startedAt: NOW - twoHours15Min, restartCount: 0, lastRestartAt: null });
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "okx" }), res);
    expect(res.body.uptime_human).toBe("2h 15m");
  });

  it("formats uptime_human with days, hours, and minutes", () => {
    const threeDays4Hours = (3 * 86400 + 4 * 3600 + 30 * 60) * 1000;
    (store as any).modules.set("bitstamp", { startedAt: NOW - threeDays4Hours, restartCount: 0, lastRestartAt: null });
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "bitstamp" }), res);
    expect(res.body.uptime_human).toBe("3d 4h 30m");
  });

  it("recordStart increments restart count on subsequent calls", () => {
    store.recordStart("kalshi");
    store.recordStart("kalshi");
    const data = store.getData("kalshi");
    expect(data?.restartCount).toBe(1);
    expect(data?.lastRestartAt).not.toBeNull();
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleUptime({ uptimeStore: store, nowFn: () => NOW });
    for (const mod of modules) {
      const res = makeRes();
      handler(makeReq({ name: mod }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body.module).toBe(mod);
    }
  });
});
