import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { postModuleRestart, KNOWN_MODULES } from "../moduleRestart.js";

function makeReq(name: string, headers: Record<string, string> = {}): Request {
  return {
    params: { name },
    headers,
  } as unknown as Request;
}

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: unknown) { body = data; statusCode = statusCode; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function makeDeps(publishFn?: (...args: unknown[]) => void) {
  const publish = publishFn ?? vi.fn();
  const nc = { publish } as unknown as import("nats").NatsConnection;
  const getNatsConn = vi.fn().mockResolvedValue(nc);
  const sc = { encode: vi.fn((s: string) => Buffer.from(s)) } as unknown as import("nats").Codec<string>;
  return { getNatsConn, sc, publish };
}

describe("POST /api/modules/:name/restart", () => {
  it("returns 400 for unknown module name", async () => {
    const { getNatsConn, sc } = makeDeps();
    const handler = postModuleRestart({ getNatsConn, sc });
    const req = makeReq("unknown-module");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("Unknown module");
  });

  it("returns 400 for empty module name", async () => {
    const { getNatsConn, sc } = makeDeps();
    const handler = postModuleRestart({ getNatsConn, sc });
    const req = makeReq("");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("publishes NATS message for valid module", async () => {
    const publish = vi.fn();
    const { getNatsConn, sc } = makeDeps(publish);
    const handler = postModuleRestart({ getNatsConn, sc });
    const req = makeReq("binance");
    const res = makeRes();
    await handler(req, res);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toBe("feedeater.control.restart.binance");
  });

  it("returns {ok, module, message} on success", async () => {
    const { getNatsConn, sc } = makeDeps();
    const handler = postModuleRestart({ getNatsConn, sc });
    const req = makeReq("coinbase");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; module: string; message: string };
    expect(body.ok).toBe(true);
    expect(body.module).toBe("coinbase");
    expect(body.message).toContain("coinbase");
  });

  it("includes correct payload in NATS message", async () => {
    const publish = vi.fn();
    const encode = vi.fn((s: string) => Buffer.from(s));
    const nc = { publish } as unknown as import("nats").NatsConnection;
    const getNatsConn = vi.fn().mockResolvedValue(nc);
    const sc = { encode } as unknown as import("nats").Codec<string>;
    const handler = postModuleRestart({ getNatsConn, sc });
    const req = makeReq("bybit", { authorization: "Bearer test-key" });
    const res = makeRes();
    await handler(req, res);
    const encoded = encode.mock.calls[0][0] as string;
    const payload = JSON.parse(encoded);
    expect(payload.module).toBe("bybit");
    expect(payload.timestamp).toBeDefined();
    expect(payload.requestedBy).toBe("api-key-user");
  });

  it("sets requestedBy to anonymous when no auth header", async () => {
    const publish = vi.fn();
    const encode = vi.fn((s: string) => Buffer.from(s));
    const nc = { publish } as unknown as import("nats").NatsConnection;
    const getNatsConn = vi.fn().mockResolvedValue(nc);
    const sc = { encode } as unknown as import("nats").Codec<string>;
    const handler = postModuleRestart({ getNatsConn, sc });
    const req = makeReq("gemini");
    const res = makeRes();
    await handler(req, res);
    const encoded = encode.mock.calls[0][0] as string;
    const payload = JSON.parse(encoded);
    expect(payload.requestedBy).toBe("anonymous");
  });

  it("returns 500 when NATS connection fails", async () => {
    const getNatsConn = vi.fn().mockRejectedValue(new Error("NATS down"));
    const sc = { encode: vi.fn() } as unknown as import("nats").Codec<string>;
    const handler = postModuleRestart({ getNatsConn, sc });
    const req = makeReq("okx");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toBe("NATS down");
  });

  it("accepts all known modules", async () => {
    const { getNatsConn, sc } = makeDeps();
    for (const name of KNOWN_MODULES) {
      const handler = postModuleRestart({ getNatsConn, sc });
      const req = makeReq(name);
      const res = makeRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }
  });

  it("KNOWN_MODULES contains exactly 10 modules", () => {
    expect(KNOWN_MODULES.size).toBe(10);
    expect(KNOWN_MODULES.has("binance")).toBe(true);
    expect(KNOWN_MODULES.has("coinbase")).toBe(true);
    expect(KNOWN_MODULES.has("bybit")).toBe(true);
    expect(KNOWN_MODULES.has("gemini")).toBe(true);
    expect(KNOWN_MODULES.has("bitstamp")).toBe(true);
    expect(KNOWN_MODULES.has("okx")).toBe(true);
    expect(KNOWN_MODULES.has("kalshi")).toBe(true);
    expect(KNOWN_MODULES.has("polymarket")).toBe(true);
    expect(KNOWN_MODULES.has("aerodrome-base")).toBe(true);
    expect(KNOWN_MODULES.has("uniswap-base")).toBe(true);
  });
});
