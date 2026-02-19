import { describe, it, expect, beforeEach } from "vitest";
import { postModuleDrain } from "../moduleDrain.js";
import type { DrainExecutor } from "../moduleDrain.js";

function makeReq(name: string, body: Record<string, unknown> = {}) {
  return { params: { name }, body } as any;
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

const stubNats = {
  getNatsConn: () => Promise.resolve({} as any),
  sc: { encode: () => new Uint8Array(), decode: () => "" } as any,
};

describe("POST /api/modules/:name/drain", () => {
  let tick: number;
  let mockDrain: DrainExecutor;

  beforeEach(() => {
    tick = 1700000000000;
    mockDrain = async () => ({ messages_flushed: 5 });
  });

  it("returns 404 for unknown module", async () => {
    const handler = postModuleDrain({ ...stubNats, drainFn: mockDrain, nowFn: () => tick });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", async () => {
    const handler = postModuleDrain({ ...stubNats, drainFn: mockDrain, nowFn: () => tick });
    const { res, getStatus } = makeRes();
    await handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape on success", async () => {
    const handler = postModuleDrain({ ...stubNats, drainFn: mockDrain, nowFn: () => tick });
    const { res, getBody } = makeRes();
    await handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.drained).toBe(true);
    expect(body.messages_flushed).toBe(5);
    expect(body).toHaveProperty("duration_ms");
    expect(body).toHaveProperty("drained_at");
  });

  it("drained_at is ISO format", async () => {
    const handler = postModuleDrain({ ...stubNats, drainFn: mockDrain, nowFn: () => tick });
    const { res, getBody } = makeRes();
    await handler(makeReq("coinbase"), res);
    expect(getBody().drained_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("uses default timeout of 30 seconds", async () => {
    let capturedTimeout = 0;
    const captureDrain: DrainExecutor = async (_mod, tMs) => { capturedTimeout = tMs; return { messages_flushed: 0 }; };
    const handler = postModuleDrain({ ...stubNats, drainFn: captureDrain, nowFn: () => tick });
    const { res } = makeRes();
    await handler(makeReq("bybit"), res);
    expect(capturedTimeout).toBe(30000);
  });

  it("accepts custom timeout_seconds", async () => {
    let capturedTimeout = 0;
    const captureDrain: DrainExecutor = async (_mod, tMs) => { capturedTimeout = tMs; return { messages_flushed: 0 }; };
    const handler = postModuleDrain({ ...stubNats, drainFn: captureDrain, nowFn: () => tick });
    const { res } = makeRes();
    await handler(makeReq("gemini", { timeout_seconds: 60 }), res);
    expect(capturedTimeout).toBe(60000);
  });

  it("caps timeout at 120 seconds", async () => {
    let capturedTimeout = 0;
    const captureDrain: DrainExecutor = async (_mod, tMs) => { capturedTimeout = tMs; return { messages_flushed: 0 }; };
    const handler = postModuleDrain({ ...stubNats, drainFn: captureDrain, nowFn: () => tick });
    const { res } = makeRes();
    await handler(makeReq("okx", { timeout_seconds: 999 }), res);
    expect(capturedTimeout).toBe(120000);
  });

  it("returns 400 for invalid timeout_seconds", async () => {
    const handler = postModuleDrain({ ...stubNats, drainFn: mockDrain, nowFn: () => tick });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("binance", { timeout_seconds: "abc" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("timeout_seconds");
  });

  it("returns 400 for negative timeout_seconds", async () => {
    const handler = postModuleDrain({ ...stubNats, drainFn: mockDrain, nowFn: () => tick });
    const { res, getStatus } = makeRes();
    await handler(makeReq("binance", { timeout_seconds: -5 }), res);
    expect(getStatus()).toBe(400);
  });

  it("returns 400 for zero timeout_seconds", async () => {
    const handler = postModuleDrain({ ...stubNats, drainFn: mockDrain, nowFn: () => tick });
    const { res, getStatus } = makeRes();
    await handler(makeReq("binance", { timeout_seconds: 0 }), res);
    expect(getStatus()).toBe(400);
  });

  it("passes correct module name to drain executor", async () => {
    let capturedModule = "";
    const captureDrain: DrainExecutor = async (mod) => { capturedModule = mod; return { messages_flushed: 0 }; };
    const handler = postModuleDrain({ ...stubNats, drainFn: captureDrain, nowFn: () => tick });
    const { res } = makeRes();
    await handler(makeReq("bitstamp"), res);
    expect(capturedModule).toBe("bitstamp");
  });

  it("returns 500 when drain executor throws", async () => {
    const failDrain: DrainExecutor = async () => { throw new Error("NATS down"); };
    const handler = postModuleDrain({ ...stubNats, drainFn: failDrain, nowFn: () => tick });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("kalshi"), res);
    expect(getStatus()).toBe(500);
    expect(getBody().error).toBe("NATS down");
  });

  it("computes duration_ms from nowFn", async () => {
    let calls = 0;
    const stepNow = () => { calls++; return calls === 1 ? 1000 : 1050; };
    const handler = postModuleDrain({ ...stubNats, drainFn: mockDrain, nowFn: stepNow });
    const { res, getBody } = makeRes();
    await handler(makeReq("polymarket"), res);
    expect(getBody().duration_ms).toBe(50);
  });

  it("returns messages_flushed from executor", async () => {
    const bigDrain: DrainExecutor = async () => ({ messages_flushed: 42 });
    const handler = postModuleDrain({ ...stubNats, drainFn: bigDrain, nowFn: () => tick });
    const { res, getBody } = makeRes();
    await handler(makeReq("aerodrome-base"), res);
    expect(getBody().messages_flushed).toBe(42);
  });

  it("works for all known modules", async () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = postModuleDrain({ ...stubNats, drainFn: mockDrain, nowFn: () => tick });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      await handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
      expect(getBody().drained).toBe(true);
    }
  });

  it("floors fractional timeout_seconds", async () => {
    let capturedTimeout = 0;
    const captureDrain: DrainExecutor = async (_mod, tMs) => { capturedTimeout = tMs; return { messages_flushed: 0 }; };
    const handler = postModuleDrain({ ...stubNats, drainFn: captureDrain, nowFn: () => tick });
    const { res } = makeRes();
    await handler(makeReq("binance", { timeout_seconds: 45.7 }), res);
    expect(capturedTimeout).toBe(45000);
  });
});
