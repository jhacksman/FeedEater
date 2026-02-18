import { describe, it, expect, beforeEach } from "vitest";
import { getModuleErrors } from "../moduleErrors.js";
import { ModuleLogStore } from "../moduleLogs.js";
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

describe("GET /api/modules/:name/errors", () => {
  let logStore: ModuleLogStore;
  const NOW = new Date("2025-06-01T12:00:00.000Z").getTime();

  beforeEach(() => {
    logStore = new ModuleLogStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "unknown-xyz" }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({}), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns empty errors array when no errors exist", () => {
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.module).toBe("binance");
    expect(res.body.errors).toEqual([]);
    expect(res.body.total_errors).toBe(0);
  });

  it("returns empty errors when only info/warn logs exist", () => {
    logStore.record("binance", "info", "connected");
    logStore.record("binance", "warn", "slow response");
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.total_errors).toBe(0);
  });

  it("returns error entries with correct shape", () => {
    logStore.record("binance", "error", "WebSocket disconnected");
    logStore.record("binance", "error", "Rate limit exceeded");
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.module).toBe("binance");
    expect(res.body.total_errors).toBe(2);
    expect(res.body.errors).toHaveLength(2);
    const err = res.body.errors[0];
    expect(err).toHaveProperty("timestamp");
    expect(err.level).toBe("error");
    expect(err.message).toBe("WebSocket disconnected");
    expect(err.count).toBe(1);
  });

  it("respects limit query parameter", () => {
    for (let i = 0; i < 30; i++) {
      logStore.record("coinbase", "error", `error-${i}`);
    }
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "coinbase" }, { limit: "5" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.errors).toHaveLength(5);
    expect(res.body.total_errors).toBe(30);
  });

  it("uses default limit of 20", () => {
    for (let i = 0; i < 30; i++) {
      logStore.record("coinbase", "error", `error-${i}`);
    }
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "coinbase" }), res);
    expect(res.body.errors).toHaveLength(20);
    expect(res.body.total_errors).toBe(30);
  });

  it("ignores invalid limit param and uses default", () => {
    for (let i = 0; i < 25; i++) {
      logStore.record("bybit", "error", `error-${i}`);
    }
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "bybit" }, { limit: "abc" }), res);
    expect(res.body.errors).toHaveLength(20);
  });

  it("filters errors by since parameter", () => {
    logStore.record("gemini", "error", "old error");
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const sinceAfterNow = new Date(Date.now() + 60_000).toISOString();
    const res = makeRes();
    handler(makeReq({ name: "gemini" }, { since: sinceAfterNow }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.total_errors).toBe(0);
  });

  it("returns window_start and window_end", () => {
    logStore.record("binance", "error", "test");
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    expect(res.body).toHaveProperty("window_start");
    expect(res.body).toHaveProperty("window_end");
    expect(res.body.window_end).toBe(new Date(NOW).toISOString());
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    for (const mod of modules) {
      const res = makeRes();
      handler(makeReq({ name: mod }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body.module).toBe(mod);
    }
  });

  it("only returns error-level entries, not info or warn", () => {
    logStore.record("okx", "info", "connected");
    logStore.record("okx", "warn", "slow");
    logStore.record("okx", "error", "disconnect");
    logStore.record("okx", "info", "reconnected");
    logStore.record("okx", "error", "timeout");
    const handler = getModuleErrors({ logStore, nowFn: () => NOW });
    const res = makeRes();
    handler(makeReq({ name: "okx" }), res);
    expect(res.body.total_errors).toBe(2);
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors[0].message).toBe("disconnect");
    expect(res.body.errors[1].message).toBe("timeout");
  });
});
