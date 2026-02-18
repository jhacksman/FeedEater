import { describe, it, expect, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { ModuleLogStore, getModuleLogs } from "../moduleLogs.js";

function makeReq(params: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return { params, query } as unknown as Request;
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

interface LogsResponse {
  module: string;
  lines: Array<{ timestamp: string; level: string; message: string }>;
  total_lines: number;
  note?: string;
}

describe("GET /api/modules/:name/logs", () => {
  let logStore: ModuleLogStore;

  beforeEach(() => {
    logStore = new ModuleLogStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "unknown-mod" }), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain("Unknown module");
  });

  it("returns empty lines with note when no log data exists", () => {
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    const body = res.body as LogsResponse;
    expect(body.module).toBe("binance");
    expect(body.lines).toEqual([]);
    expect(body.total_lines).toBe(0);
    expect(body.note).toBe("No log data available for this module");
  });

  it("returns log entries with correct shape", () => {
    logStore.record("coinbase", "info", "Message received");
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "coinbase" }), res);
    const body = res.body as LogsResponse;
    expect(body.module).toBe("coinbase");
    expect(body.lines.length).toBe(1);
    expect(body.lines[0].timestamp).toBeTypeOf("string");
    expect(body.lines[0].level).toBe("info");
    expect(body.lines[0].message).toBe("Message received");
    expect(body.total_lines).toBe(1);
    expect(body.note).toBeUndefined();
  });

  it("defaults to 50 lines", () => {
    for (let i = 0; i < 80; i++) {
      logStore.record("bybit", "info", `msg-${i}`);
    }
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "bybit" }), res);
    const body = res.body as LogsResponse;
    expect(body.lines.length).toBe(50);
    expect(body.total_lines).toBe(80);
  });

  it("respects ?lines query param", () => {
    for (let i = 0; i < 20; i++) {
      logStore.record("gemini", "info", `msg-${i}`);
    }
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "gemini" }, { lines: "5" }), res);
    const body = res.body as LogsResponse;
    expect(body.lines.length).toBe(5);
    expect(body.total_lines).toBe(20);
  });

  it("caps lines at 500", () => {
    for (let i = 0; i < 600; i++) {
      logStore.record("bitstamp", "info", `msg-${i}`);
    }
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "bitstamp" }, { lines: "999" }), res);
    const body = res.body as LogsResponse;
    expect(body.lines.length).toBe(500);
  });

  it("returns 400 for invalid lines param", () => {
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "okx" }, { lines: "abc" }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("lines must be a positive integer");
  });

  it("returns 400 for negative lines param", () => {
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "okx" }, { lines: "-5" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for zero lines param", () => {
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "okx" }, { lines: "0" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns tail (most recent) entries", () => {
    logStore.record("kalshi", "info", "first");
    logStore.record("kalshi", "warn", "second");
    logStore.record("kalshi", "error", "third");
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "kalshi" }, { lines: "2" }), res);
    const body = res.body as LogsResponse;
    expect(body.lines.length).toBe(2);
    expect(body.lines[0].message).toBe("second");
    expect(body.lines[1].message).toBe("third");
  });

  it("supports all log levels", () => {
    logStore.record("polymarket", "info", "info msg");
    logStore.record("polymarket", "warn", "warn msg");
    logStore.record("polymarket", "error", "error msg");
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "polymarket" }), res);
    const body = res.body as LogsResponse;
    const levels = body.lines.map((l) => l.level);
    expect(levels).toEqual(["info", "warn", "error"]);
  });

  it("handles module with no params", () => {
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({}), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns correct total_lines even when fewer requested", () => {
    for (let i = 0; i < 100; i++) {
      logStore.record("aerodrome-base", "info", `msg-${i}`);
    }
    const handler = getModuleLogs({ logStore });
    const res = makeRes();
    handler(makeReq({ name: "aerodrome-base" }, { lines: "3" }), res);
    const body = res.body as LogsResponse;
    expect(body.lines.length).toBe(3);
    expect(body.total_lines).toBe(100);
  });

  it("buffer evicts old entries beyond max size", () => {
    for (let i = 0; i < 1100; i++) {
      logStore.record("uniswap-base", "info", `msg-${i}`);
    }
    const total = logStore.totalLines("uniswap-base");
    expect(total).toBeLessThanOrEqual(1000);
  });

  it("isolates logs per module", () => {
    logStore.record("binance", "info", "binance msg");
    logStore.record("coinbase", "warn", "coinbase msg");
    const handler = getModuleLogs({ logStore });

    const res1 = makeRes();
    handler(makeReq({ name: "binance" }), res1);
    const body1 = res1.body as LogsResponse;
    expect(body1.lines.length).toBe(1);
    expect(body1.lines[0].message).toBe("binance msg");

    const res2 = makeRes();
    handler(makeReq({ name: "coinbase" }), res2);
    const body2 = res2.body as LogsResponse;
    expect(body2.lines.length).toBe(1);
    expect(body2.lines[0].message).toBe("coinbase msg");
  });
});
