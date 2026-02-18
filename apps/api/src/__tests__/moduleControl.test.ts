import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { postModuleDisable, postModuleEnable } from "../moduleControl.js";

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
  const disabledModules = new Set<string>();
  return { getNatsConn, sc, publish, disabledModules };
}

describe("POST /api/modules/:name/disable", () => {
  it("returns 404 for unknown module name", async () => {
    const { getNatsConn, sc, disabledModules } = makeDeps();
    const handler = postModuleDisable({ getNatsConn, sc, disabledModules });
    const req = makeReq("unknown-module");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", async () => {
    const { getNatsConn, sc, disabledModules } = makeDeps();
    const handler = postModuleDisable({ getNatsConn, sc, disabledModules });
    const req = makeReq("");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("disables a valid module and publishes NATS message", async () => {
    const publish = vi.fn();
    const { getNatsConn, sc, disabledModules } = makeDeps(publish);
    const handler = postModuleDisable({ getNatsConn, sc, disabledModules });
    const req = makeReq("binance");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; module: string; message: string };
    expect(body.ok).toBe(true);
    expect(body.module).toBe("binance");
    expect(body.message).toContain("disabled");
    expect(disabledModules.has("binance")).toBe(true);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toBe("feedeater.control.disable.binance");
  });

  it("double-disable is idempotent (returns 200 both times)", async () => {
    const publish = vi.fn();
    const { getNatsConn, sc, disabledModules } = makeDeps(publish);
    const handler = postModuleDisable({ getNatsConn, sc, disabledModules });

    const req1 = makeReq("coinbase");
    const res1 = makeRes();
    await handler(req1, res1);
    expect(res1.statusCode).toBe(200);
    expect(disabledModules.has("coinbase")).toBe(true);

    const req2 = makeReq("coinbase");
    const res2 = makeRes();
    await handler(req2, res2);
    expect(res2.statusCode).toBe(200);
    expect((res2.body as { message: string }).message).toContain("already disabled");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("includes action:disable in NATS payload", async () => {
    const publish = vi.fn();
    const encode = vi.fn((s: string) => Buffer.from(s));
    const nc = { publish } as unknown as import("nats").NatsConnection;
    const getNatsConn = vi.fn().mockResolvedValue(nc);
    const sc = { encode } as unknown as import("nats").Codec<string>;
    const disabledModules = new Set<string>();
    const handler = postModuleDisable({ getNatsConn, sc, disabledModules });
    const req = makeReq("bybit", { authorization: "Bearer test-key" });
    const res = makeRes();
    await handler(req, res);
    const encoded = encode.mock.calls[0][0] as string;
    const payload = JSON.parse(encoded);
    expect(payload.module).toBe("bybit");
    expect(payload.action).toBe("disable");
    expect(payload.timestamp).toBeDefined();
    expect(payload.requestedBy).toBe("api-key-user");
  });

  it("returns 500 when NATS connection fails", async () => {
    const getNatsConn = vi.fn().mockRejectedValue(new Error("NATS down"));
    const sc = { encode: vi.fn() } as unknown as import("nats").Codec<string>;
    const disabledModules = new Set<string>();
    const handler = postModuleDisable({ getNatsConn, sc, disabledModules });
    const req = makeReq("okx");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toBe("NATS down");
  });
});

describe("POST /api/modules/:name/enable", () => {
  it("returns 404 for unknown module name", async () => {
    const { getNatsConn, sc, disabledModules } = makeDeps();
    const handler = postModuleEnable({ getNatsConn, sc, disabledModules });
    const req = makeReq("unknown-module");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain("Unknown module");
  });

  it("enable on non-disabled module returns 200 (already enabled)", async () => {
    const { getNatsConn, sc, disabledModules } = makeDeps();
    const handler = postModuleEnable({ getNatsConn, sc, disabledModules });
    const req = makeReq("binance");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { message: string }).message).toContain("already enabled");
  });

  it("enables a previously disabled module and publishes NATS message", async () => {
    const publish = vi.fn();
    const { getNatsConn, sc, disabledModules } = makeDeps(publish);
    disabledModules.add("gemini");
    const handler = postModuleEnable({ getNatsConn, sc, disabledModules });
    const req = makeReq("gemini");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; module: string; message: string };
    expect(body.ok).toBe(true);
    expect(body.module).toBe("gemini");
    expect(body.message).toContain("enabled");
    expect(disabledModules.has("gemini")).toBe(false);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toBe("feedeater.control.enable.gemini");
  });

  it("includes action:enable in NATS payload", async () => {
    const publish = vi.fn();
    const encode = vi.fn((s: string) => Buffer.from(s));
    const nc = { publish } as unknown as import("nats").NatsConnection;
    const getNatsConn = vi.fn().mockResolvedValue(nc);
    const sc = { encode } as unknown as import("nats").Codec<string>;
    const disabledModules = new Set<string>(["bitstamp"]);
    const handler = postModuleEnable({ getNatsConn, sc, disabledModules });
    const req = makeReq("bitstamp");
    const res = makeRes();
    await handler(req, res);
    const encoded = encode.mock.calls[0][0] as string;
    const payload = JSON.parse(encoded);
    expect(payload.module).toBe("bitstamp");
    expect(payload.action).toBe("enable");
    expect(payload.timestamp).toBeDefined();
    expect(payload.requestedBy).toBe("anonymous");
  });

  it("returns 500 when NATS connection fails", async () => {
    const getNatsConn = vi.fn().mockRejectedValue(new Error("NATS down"));
    const sc = { encode: vi.fn() } as unknown as import("nats").Codec<string>;
    const disabledModules = new Set<string>(["kalshi"]);
    const handler = postModuleEnable({ getNatsConn, sc, disabledModules });
    const req = makeReq("kalshi");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toBe("NATS down");
  });

  it("disable then enable restores module state", async () => {
    const publish = vi.fn();
    const { getNatsConn, sc, disabledModules } = makeDeps(publish);

    const disableHandler = postModuleDisable({ getNatsConn, sc, disabledModules });
    const req1 = makeReq("polymarket");
    const res1 = makeRes();
    await disableHandler(req1, res1);
    expect(disabledModules.has("polymarket")).toBe(true);

    const enableHandler = postModuleEnable({ getNatsConn, sc, disabledModules });
    const req2 = makeReq("polymarket");
    const res2 = makeRes();
    await enableHandler(req2, res2);
    expect(disabledModules.has("polymarket")).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
