import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { ModuleConfigDb, getModuleConfig, patchModuleConfig } from "../moduleControl.js";
import { adminKeyAuth } from "../rateLimitConfig.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpDbPath(): string {
  return join(tmpdir(), `modcfgpatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(p: string) {
  for (const f of [p, `${p}-wal`, `${p}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

function makeReq(name: string, body: unknown = {}, headers: Record<string, string> = {}): Request {
  return { params: { name }, body, headers } as unknown as Request;
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

function makePatchDeps(db: ModuleConfigDb) {
  const publish = vi.fn();
  const nc = { publish } as unknown as import("nats").NatsConnection;
  const getNatsConn = vi.fn().mockResolvedValue(nc);
  const sc = { encode: vi.fn((s: string) => Buffer.from(s)) } as unknown as import("nats").Codec<string>;
  return { db, getNatsConn, sc, publish };
}

describe("PATCH /api/modules/:name/config", () => {
  let dbPath: string;
  let db: ModuleConfigDb;

  afterEach(() => {
    try { db?.close(); } catch {}
    if (dbPath) cleanup(dbPath);
  });

  it("returns 404 for unknown module", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const deps = makePatchDeps(db);
    const handler = patchModuleConfig(deps);
    const res = makeRes();
    await handler(makeReq("unknown-module", { key: "val" }), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for empty body", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const deps = makePatchDeps(db);
    const handler = patchModuleConfig(deps);
    const res = makeRes();
    await handler(makeReq("binance", {}), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for array body", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const deps = makePatchDeps(db);
    const handler = patchModuleConfig(deps);
    const res = makeRes();
    await handler(makeReq("binance", [1, 2, 3]), res);
    expect(res.statusCode).toBe(400);
  });

  it("persists config overrides for valid module", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const deps = makePatchDeps(db);
    const handler = patchModuleConfig(deps);
    const res = makeRes();
    await handler(makeReq("binance", { pollInterval: "5000", symbols: "BTCUSDT" }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { module: string; configOverrides: Record<string, string> };
    expect(body.module).toBe("binance");
    expect(body.configOverrides.pollInterval).toBe("5000");
    expect(body.configOverrides.symbols).toBe("BTCUSDT");
  });

  it("publishes NATS configReload message", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const deps = makePatchDeps(db);
    const handler = patchModuleConfig(deps);
    const res = makeRes();
    await handler(makeReq("coinbase", { refreshRate: "10" }), res);
    expect(deps.publish).toHaveBeenCalledOnce();
    expect(deps.publish.mock.calls[0][0]).toBe("feedeater.control.configReload.coinbase");
  });

  it("merges overrides across multiple PATCH calls", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const deps = makePatchDeps(db);
    const handler = patchModuleConfig(deps);

    await handler(makeReq("bybit", { key1: "a" }), makeRes());
    await handler(makeReq("bybit", { key2: "b" }), makeRes());

    const overrides = db.getOverrides("bybit");
    expect(overrides.key1).toBe("a");
    expect(overrides.key2).toBe("b");
  });

  it("overwrites existing key on second PATCH", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const deps = makePatchDeps(db);
    const handler = patchModuleConfig(deps);

    await handler(makeReq("gemini", { interval: "100" }), makeRes());
    await handler(makeReq("gemini", { interval: "200" }), makeRes());

    expect(db.getOverrides("gemini").interval).toBe("200");
  });

  it("converts numeric values to strings", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const deps = makePatchDeps(db);
    const handler = patchModuleConfig(deps);
    const res = makeRes();
    await handler(makeReq("okx", { timeout: 3000 }), res);
    const body = res.body as { configOverrides: Record<string, string> };
    expect(body.configOverrides.timeout).toBe("3000");
  });

  it("does not fail when NATS is unavailable", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const getNatsConn = vi.fn().mockRejectedValue(new Error("NATS down"));
    const sc = { encode: vi.fn((s: string) => Buffer.from(s)) } as unknown as import("nats").Codec<string>;
    const handler = patchModuleConfig({ db, getNatsConn, sc });
    const res = makeRes();
    await handler(makeReq("kalshi", { mode: "live" }), res);
    expect(res.statusCode).toBe(200);
    expect(db.getOverrides("kalshi").mode).toBe("live");
  });
});

describe("GET /api/modules/:name/config reflects overrides", () => {
  let dbPath: string;
  let db: ModuleConfigDb;

  afterEach(() => {
    try { db?.close(); } catch {}
    if (dbPath) cleanup(dbPath);
  });

  it("returns empty configOverrides when none set", () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const handler = getModuleConfig({ disabledModules: new Set(), db });
    const res = makeRes();
    handler(makeReq("binance"), res);
    const body = res.body as { configOverrides: Record<string, string> };
    expect(body.configOverrides).toEqual({});
  });

  it("returns persisted overrides after PATCH", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const patchDeps = makePatchDeps(db);
    const patchHandler = patchModuleConfig(patchDeps);
    await patchHandler(makeReq("coinbase", { symbol: "ETH-USD" }), makeRes());

    const getHandler = getModuleConfig({ disabledModules: new Set(), db });
    const res = makeRes();
    getHandler(makeReq("coinbase"), res);
    const body = res.body as { configOverrides: Record<string, string> };
    expect(body.configOverrides.symbol).toBe("ETH-USD");
  });

  it("overrides survive db close and reopen", async () => {
    dbPath = tmpDbPath();
    db = new ModuleConfigDb(dbPath);
    const patchDeps = makePatchDeps(db);
    const patchHandler = patchModuleConfig(patchDeps);
    await patchHandler(makeReq("polymarket", { apiUrl: "https://example.com" }), makeRes());
    db.close();

    const db2 = new ModuleConfigDb(dbPath);
    const overrides = db2.getOverrides("polymarket");
    expect(overrides.apiUrl).toBe("https://example.com");
    db2.close();
    db = new ModuleConfigDb(tmpDbPath());
  });
});

describe("adminKeyAuth guards PATCH", () => {
  it("rejects when ADMIN_KEY not set", () => {
    const orig = process.env.ADMIN_KEY;
    delete process.env.ADMIN_KEY;
    const res = makeRes();
    let called = false;
    adminKeyAuth(makeReq("binance"), res, (() => { called = true; }) as unknown as NextFunction);
    expect(called).toBe(false);
    expect(res.statusCode).toBe(503);
    if (orig) process.env.ADMIN_KEY = orig;
  });

  it("rejects when X-Admin-Key is wrong", () => {
    const orig = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = "secret";
    const res = makeRes();
    let called = false;
    adminKeyAuth(
      makeReq("binance", {}, { "x-admin-key": "wrong" }),
      res,
      (() => { called = true; }) as unknown as NextFunction,
    );
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    process.env.ADMIN_KEY = orig ?? "";
    if (!orig) delete process.env.ADMIN_KEY;
  });
});
