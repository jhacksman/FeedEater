import { describe, it, expect, beforeEach } from "vitest";
import { getModuleReconnectStats, ReconnectStatsStore } from "../moduleReconnectStats.js";
import type { Request, Response } from "express";

function makeReq(params: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return { params, query } as unknown as Request;
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

describe("GET /api/modules/:name/reconnects (stats)", () => {
  let store: ReconnectStatsStore;
  const NOW = new Date("2025-06-01T12:00:00.000Z").getTime();

  beforeEach(() => {
    store = new ReconnectStatsStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "unknown-xyz" }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({}), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns zeros when no reconnect data exists", () => {
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.module).toBe("binance");
    expect(res.body.reconnect_count).toBe(0);
    expect(res.body.last_reconnect_at).toBeNull();
    expect(res.body.avg_reconnect_interval_seconds).toBe(0);
    expect(res.body.max_gap_seconds).toBe(0);
    expect(res.body.window_seconds).toBe(3600);
  });

  it("returns reconnect stats with recorded data", () => {
    const base = NOW - 30_000;
    store.getTimestamps("binance");
    (store as any).timestamps.set("binance", [base, base + 10_000, base + 25_000]);
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.reconnect_count).toBe(3);
    expect(res.body.last_reconnect_at).toBe(new Date(base + 25_000).toISOString());
    expect(res.body.avg_reconnect_interval_seconds).toBe(12.5);
    expect(res.body.max_gap_seconds).toBe(15);
  });

  it("respects custom window parameter", () => {
    const base = NOW - 7200_000;
    (store as any).timestamps.set("coinbase", [base, base + 1000, NOW - 500]);
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "coinbase" }, { window: "60" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.window_seconds).toBe(60);
    expect(res.body.reconnect_count).toBe(1);
  });

  it("uses default window of 3600 seconds", () => {
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "bybit" }), res);
    expect(res.body.window_seconds).toBe(3600);
  });

  it("ignores invalid window param", () => {
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "gemini" }, { window: "abc" }), res);
    expect(res.body.window_seconds).toBe(3600);
  });

  it("computes max_gap_seconds correctly", () => {
    const base = NOW - 60_000;
    (store as any).timestamps.set("okx", [base, base + 5_000, base + 45_000, base + 50_000]);
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "okx" }), res);
    expect(res.body.max_gap_seconds).toBe(40);
  });

  it("returns timestamp in ISO format", () => {
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    expect(res.body.timestamp).toBe(new Date(NOW).toISOString());
  });

  it("handles single reconnect (no interval)", () => {
    (store as any).timestamps.set("bitstamp", [NOW - 1000]);
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "bitstamp" }), res);
    expect(res.body.reconnect_count).toBe(1);
    expect(res.body.avg_reconnect_interval_seconds).toBe(0);
    expect(res.body.max_gap_seconds).toBe(0);
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleReconnectStats({ store, nowFn: () => NOW });
    for (const mod of modules) {
      const res = makeRes();
      handler(makeReq({ name: mod }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body.module).toBe(mod);
    }
  });
});
