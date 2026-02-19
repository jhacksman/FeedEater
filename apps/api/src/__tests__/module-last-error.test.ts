import { describe, it, expect, beforeEach } from "vitest";
import { LastErrorStore, getModuleLastError } from "../moduleLastError.js";

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

describe("GET /api/modules/:name/last-error", () => {
  let store: LastErrorStore;
  let tick: number;

  beforeEach(() => {
    tick = 1700000000000;
    store = new LastErrorStore(() => tick);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns error null when no errors recorded", () => {
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody()).toEqual({ module: "binance", error: null });
  });

  it("returns full error details when error recorded", () => {
    const err = new Error("WebSocket disconnected");
    store.record("coinbase", err, { attempt: 3 });
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.module).toBe("coinbase");
    expect(body.error_message).toBe("WebSocket disconnected");
    expect(body.error_type).toBe("Error");
    expect(body.stack_trace).toBeTypeOf("string");
    expect(body.occurred_at).toBe(new Date(1700000000000).toISOString());
    expect(body.context).toEqual({ attempt: 3 });
  });

  it("occurred_at is ISO string", () => {
    store.record("bybit", new Error("timeout"));
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns latest error when multiple recorded", () => {
    tick = 1000;
    store.record("gemini", new Error("first error"));
    tick = 2000;
    store.record("gemini", new Error("second error"));
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().error_message).toBe("second error");
    expect(getBody().occurred_at).toBe(new Date(2000).toISOString());
  });

  it("preserves error_type from error class", () => {
    class ConnectionError extends Error { constructor(msg: string) { super(msg); this.name = "ConnectionError"; } }
    const err = new ConnectionError("refused");
    store.record("okx", err);
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    expect(getBody().error_type).toBe("ConnectionError");
  });

  it("truncates long stack traces", () => {
    const err = new Error("big stack");
    err.stack = "x".repeat(5000);
    store.record("bitstamp", err);
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    expect(getBody().stack_trace.length).toBe(2000);
  });

  it("returns null stack_trace when error has no stack", () => {
    const err = new Error("no stack");
    err.stack = undefined;
    store.record("kalshi", err);
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    expect(getBody().stack_trace).toBeNull();
  });

  it("returns empty context when none provided", () => {
    store.record("polymarket", new Error("fail"));
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    expect(getBody().context).toEqual({});
  });

  it("modules are isolated", () => {
    store.record("binance", new Error("binance error"));
    const handler = getModuleLastError({ lastErrorStore: store });

    const { res: r1, getBody: gb1 } = makeRes();
    handler(makeReq("binance"), r1);
    expect(gb1().error_message).toBe("binance error");

    const { res: r2, getBody: gb2 } = makeRes();
    handler(makeReq("coinbase"), r2);
    expect(gb2()).toEqual({ module: "coinbase", error: null });
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleLastError({ lastErrorStore: store });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });

  it("context can hold nested objects", () => {
    store.record("binance", new Error("complex"), { ws: { state: "closed", url: "wss://example.com" }, retries: 5 });
    const handler = getModuleLastError({ lastErrorStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().context.ws).toEqual({ state: "closed", url: "wss://example.com" });
    expect(getBody().context.retries).toBe(5);
  });
});
