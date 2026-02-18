import { describe, it, expect, beforeEach } from "vitest";
import type { Request, Response } from "express";
import {
  recordReconnect,
  getReconnectSummary,
  getModuleReconnects,
  resetStore,
  getModuleReconnectsHandler,
  getReconnectSummaryHandler,
} from "../reconnects.js";

function makeReq(name: string): Request {
  return { params: { name } } as unknown as Request;
}

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: unknown) { body = data; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

beforeEach(() => {
  resetStore();
});

describe("recordReconnect", () => {
  it("creates entry on first call", () => {
    recordReconnect("binance");
    const entry = getModuleReconnects("binance");
    expect(entry).not.toBeNull();
    expect(entry!.count).toBe(1);
    expect(entry!.lastReconnectMs).toBeGreaterThan(0);
  });

  it("increments count on subsequent calls", () => {
    recordReconnect("coinbase");
    recordReconnect("coinbase");
    recordReconnect("coinbase");
    const entry = getModuleReconnects("coinbase");
    expect(entry!.count).toBe(3);
  });

  it("updates lastReconnectMs on each call", async () => {
    recordReconnect("gemini");
    const first = getModuleReconnects("gemini")!.lastReconnectMs;
    await new Promise((r) => setTimeout(r, 10));
    recordReconnect("gemini");
    const second = getModuleReconnects("gemini")!.lastReconnectMs;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("tracks different modules independently", () => {
    recordReconnect("binance");
    recordReconnect("binance");
    recordReconnect("okx");
    expect(getModuleReconnects("binance")!.count).toBe(2);
    expect(getModuleReconnects("okx")!.count).toBe(1);
  });
});

describe("getModuleReconnects", () => {
  it("returns null for module with no reconnects", () => {
    expect(getModuleReconnects("bybit")).toBeNull();
  });

  it("returns correct shape", () => {
    recordReconnect("bitstamp");
    const entry = getModuleReconnects("bitstamp");
    expect(entry).toHaveProperty("module", "bitstamp");
    expect(entry).toHaveProperty("count");
    expect(entry).toHaveProperty("lastReconnectMs");
  });
});

describe("getReconnectSummary", () => {
  it("returns empty array when no reconnects recorded", () => {
    expect(getReconnectSummary()).toEqual([]);
  });

  it("returns all modules with reconnects", () => {
    recordReconnect("binance");
    recordReconnect("okx");
    recordReconnect("gemini");
    const summary = getReconnectSummary();
    expect(summary).toHaveLength(3);
    const modules = summary.map((s) => s.module).sort();
    expect(modules).toEqual(["binance", "gemini", "okx"]);
  });

  it("reflects correct counts per module", () => {
    recordReconnect("binance");
    recordReconnect("binance");
    recordReconnect("okx");
    const summary = getReconnectSummary();
    const binance = summary.find((s) => s.module === "binance");
    const okx = summary.find((s) => s.module === "okx");
    expect(binance!.count).toBe(2);
    expect(okx!.count).toBe(1);
  });
});

describe("resetStore", () => {
  it("clears all recorded reconnects", () => {
    recordReconnect("binance");
    recordReconnect("okx");
    resetStore();
    expect(getReconnectSummary()).toEqual([]);
    expect(getModuleReconnects("binance")).toBeNull();
  });
});

describe("GET /api/modules/:name/reconnects handler", () => {
  it("returns 404 for unknown module", () => {
    const handler = getModuleReconnectsHandler();
    const res = makeRes();
    handler(makeReq("unknown-module"), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain("Unknown module");
  });

  it("returns zero counts for known module with no reconnects", () => {
    const handler = getModuleReconnectsHandler();
    const res = makeRes();
    handler(makeReq("binance"), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { module: string; count: number; lastReconnectMs: number };
    expect(body.module).toBe("binance");
    expect(body.count).toBe(0);
    expect(body.lastReconnectMs).toBe(0);
  });

  it("returns recorded reconnects for known module", () => {
    recordReconnect("coinbase");
    recordReconnect("coinbase");
    const handler = getModuleReconnectsHandler();
    const res = makeRes();
    handler(makeReq("coinbase"), res);
    const body = res.body as { module: string; count: number; lastReconnectMs: number };
    expect(body.count).toBe(2);
    expect(body.lastReconnectMs).toBeGreaterThan(0);
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleReconnectsHandler();
    const res = makeRes();
    handler(makeReq(""), res);
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/reconnects handler", () => {
  it("returns empty array when nothing recorded", () => {
    const handler = getReconnectSummaryHandler();
    const res = makeRes();
    handler(makeReq(""), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns full summary after reconnects", () => {
    recordReconnect("binance");
    recordReconnect("gemini");
    const handler = getReconnectSummaryHandler();
    const res = makeRes();
    handler(makeReq(""), res);
    const body = res.body as Array<{ module: string; count: number; lastReconnectMs: number }>;
    expect(body).toHaveLength(2);
  });
});
