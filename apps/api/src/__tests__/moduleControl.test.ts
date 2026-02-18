import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { postModuleDisable, postModuleEnable, ModuleConfigDb, getModuleConfig } from "../moduleControl.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  it("returns 500 when NATS connection fails and does not mutate state", async () => {
    const getNatsConn = vi.fn().mockRejectedValue(new Error("NATS down"));
    const sc = { encode: vi.fn() } as unknown as import("nats").Codec<string>;
    const disabledModules = new Set<string>();
    const handler = postModuleDisable({ getNatsConn, sc, disabledModules });
    const req = makeReq("okx");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toBe("NATS down");
    expect(disabledModules.has("okx")).toBe(false);
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

  it("returns 500 when NATS connection fails and does not mutate state", async () => {
    const getNatsConn = vi.fn().mockRejectedValue(new Error("NATS down"));
    const sc = { encode: vi.fn() } as unknown as import("nats").Codec<string>;
    const disabledModules = new Set<string>(["kalshi"]);
    const handler = postModuleEnable({ getNatsConn, sc, disabledModules });
    const req = makeReq("kalshi");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toBe("NATS down");
    expect(disabledModules.has("kalshi")).toBe(true);
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

function tmpDbPath(): string {
  return join(tmpdir(), `moduleconfig-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(p: string) {
  for (const f of [p, `${p}-wal`, `${p}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

describe("ModuleConfigDb", () => {
  let dbPath: string;
  let db: ModuleConfigDb;

  afterEach(() => {
    try { db?.close(); } catch {}
    cleanup(dbPath);
  });

  it("loadDisabled returns empty array from fresh database", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    expect(db.loadDisabled()).toEqual([]);
  });

  it("setDisabled(true) persists disabled state", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    db.setDisabled("binance", true);
    expect(db.loadDisabled()).toEqual(["binance"]);
  });

  it("setDisabled(false) removes module from disabled list", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    db.setDisabled("coinbase", true);
    db.setDisabled("coinbase", false);
    expect(db.loadDisabled()).toEqual([]);
  });

  it("tracks multiple modules independently", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    db.setDisabled("binance", true);
    db.setDisabled("coinbase", true);
    db.setDisabled("gemini", true);
    db.setDisabled("coinbase", false);
    const disabled = db.loadDisabled().sort();
    expect(disabled).toEqual(["binance", "gemini"]);
  });

  it("getConfig returns null for unknown module", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    expect(db.getConfig("nonexistent")).toBeNull();
  });

  it("getConfig returns correct state after disable", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    db.setDisabled("okx", true);
    const cfg = db.getConfig("okx");
    expect(cfg).not.toBeNull();
    expect(cfg!.module).toBe("okx");
    expect(cfg!.disabled).toBe(true);
    expect(cfg!.updatedAt).toBeDefined();
  });

  it("getConfig returns correct state after re-enable", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    db.setDisabled("bybit", true);
    db.setDisabled("bybit", false);
    const cfg = db.getConfig("bybit");
    expect(cfg).not.toBeNull();
    expect(cfg!.disabled).toBe(false);
  });

  it("state survives close and reopen (simulated restart)", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    db.setDisabled("binance", true);
    db.setDisabled("gemini", true);
    db.close();
    const db2 = new ModuleConfigDb(dbPath);
    const disabled = db2.loadDisabled().sort();
    expect(disabled).toEqual(["binance", "gemini"]);
    db2.close();
  });
});

describe("GET /api/modules/:name/config", () => {
  let dbPath: string;
  let db: ModuleConfigDb;

  afterEach(() => {
    try { db?.close(); } catch {}
    if (dbPath) cleanup(dbPath);
  });

  it("returns 404 for unknown module", () => {
    const disabledModules = new Set<string>();
    const handler = getModuleConfig({ disabledModules });
    const req = makeReq("unknown-module");
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns enabled state for known module (no db)", () => {
    const disabledModules = new Set<string>();
    const handler = getModuleConfig({ disabledModules });
    const req = makeReq("binance");
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { module: string; disabled: boolean; updatedAt: string | null };
    expect(body.module).toBe("binance");
    expect(body.disabled).toBe(false);
    expect(body.updatedAt).toBeNull();
  });

  it("returns disabled state for disabled module (no db)", () => {
    const disabledModules = new Set<string>(["coinbase"]);
    const handler = getModuleConfig({ disabledModules });
    const req = makeReq("coinbase");
    const res = makeRes();
    handler(req, res);
    const body = res.body as { module: string; disabled: boolean };
    expect(body.disabled).toBe(true);
  });

  it("returns updatedAt from db when available", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    db.setDisabled("gemini", true);
    const disabledModules = new Set<string>(["gemini"]);
    const handler = getModuleConfig({ disabledModules, db });
    const req = makeReq("gemini");
    const res = makeRes();
    handler(req, res);
    const body = res.body as { module: string; disabled: boolean; updatedAt: string | null };
    expect(body.disabled).toBe(true);
    expect(body.updatedAt).not.toBeNull();
  });
});

describe("disable/enable handlers sync with ModuleConfigDb", () => {
  let dbPath: string;
  let db: ModuleConfigDb;

  afterEach(() => {
    try { db?.close(); } catch {}
    if (dbPath) cleanup(dbPath);
  });

  it("postModuleDisable writes to db", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const publish = vi.fn();
    const { getNatsConn, sc, disabledModules } = makeDeps(publish);
    const handler = postModuleDisable({ getNatsConn, sc, disabledModules, db });
    const req = makeReq("binance");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(db.loadDisabled()).toEqual(["binance"]);
  });

  it("postModuleEnable writes to db", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    db.setDisabled("okx", true);
    const publish = vi.fn();
    const { getNatsConn, sc, disabledModules } = makeDeps(publish);
    disabledModules.add("okx");
    const handler = postModuleEnable({ getNatsConn, sc, disabledModules, db });
    const req = makeReq("okx");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(db.loadDisabled()).toEqual([]);
  });

  it("full cycle: disable → restart sim → state preserved", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const publish = vi.fn();
    const { getNatsConn, sc, disabledModules } = makeDeps(publish);
    const handler = postModuleDisable({ getNatsConn, sc, disabledModules, db });
    await handler(makeReq("bitstamp"), makeRes());
    await handler(makeReq("gemini"), makeRes());
    db.close();
    const db2 = new ModuleConfigDb(dbPath);
    const restored = new Set<string>(db2.loadDisabled());
    expect(restored.has("bitstamp")).toBe(true);
    expect(restored.has("gemini")).toBe(true);
    db2.close();
    db = new ModuleConfigDb(tmpDbPath());
  });
});
