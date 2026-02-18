import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { postBulkEnable, postBulkDisable } from "../bulkModuleControl.js";
import { ModuleConfigDb } from "../moduleControl.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return { body, headers } as unknown as Request;
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

function makeDeps(publishFn?: (...args: unknown[]) => void) {
  const publish = publishFn ?? vi.fn();
  const nc = { publish } as unknown as import("nats").NatsConnection;
  const getNatsConn = vi.fn().mockResolvedValue(nc);
  const sc = { encode: vi.fn((s: string) => Buffer.from(s)) } as unknown as import("nats").Codec<string>;
  const disabledModules = new Set<string>();
  return { getNatsConn, sc, publish, disabledModules };
}

function tmpDbPath(): string {
  return join(tmpdir(), `bulkctl-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(p: string) {
  for (const f of [p, `${p}-wal`, `${p}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

interface BulkBody {
  succeeded: string[];
  failed: Array<{ name: string; reason: string }>;
}

describe("POST /api/modules/bulk-enable", () => {
  it("returns 400 when body has no modules array", async () => {
    const deps = makeDeps();
    const handler = postBulkEnable(deps);
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("modules");
  });

  it("returns 400 when body is null", async () => {
    const deps = makeDeps();
    const handler = postBulkEnable(deps);
    const res = makeRes();
    await handler(makeReq(null), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns empty arrays for empty modules list", async () => {
    const deps = makeDeps();
    const handler = postBulkEnable(deps);
    const res = makeRes();
    await handler(makeReq({ modules: [] }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as BulkBody;
    expect(body.succeeded).toEqual([]);
    expect(body.failed).toEqual([]);
  });

  it("enables multiple disabled modules", async () => {
    const publish = vi.fn();
    const deps = makeDeps(publish);
    deps.disabledModules.add("binance");
    deps.disabledModules.add("coinbase");
    const handler = postBulkEnable(deps);
    const res = makeRes();
    await handler(makeReq({ modules: ["binance", "coinbase"] }), res);
    const body = res.body as BulkBody;
    expect(body.succeeded).toContain("binance");
    expect(body.succeeded).toContain("coinbase");
    expect(body.failed).toEqual([]);
    expect(deps.disabledModules.has("binance")).toBe(false);
    expect(deps.disabledModules.has("coinbase")).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("reports unknown modules in failed array", async () => {
    const deps = makeDeps();
    const handler = postBulkEnable(deps);
    const res = makeRes();
    await handler(makeReq({ modules: ["fake-module", "binance"] }), res);
    const body = res.body as BulkBody;
    expect(body.succeeded).toContain("binance");
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].name).toBe("fake-module");
    expect(body.failed[0].reason).toBe("not found");
  });

  it("already-enabled modules succeed without NATS publish", async () => {
    const publish = vi.fn();
    const deps = makeDeps(publish);
    const handler = postBulkEnable(deps);
    const res = makeRes();
    await handler(makeReq({ modules: ["binance"] }), res);
    const body = res.body as BulkBody;
    expect(body.succeeded).toContain("binance");
    expect(publish).not.toHaveBeenCalled();
  });

  it("handles NATS failure for one module while others succeed", async () => {
    let callCount = 0;
    const getNatsConn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("NATS down"));
      return Promise.resolve({ publish: vi.fn() });
    });
    const sc = { encode: vi.fn((s: string) => Buffer.from(s)) } as unknown as import("nats").Codec<string>;
    const disabledModules = new Set(["binance", "coinbase"]);
    const handler = postBulkEnable({ getNatsConn, sc, disabledModules });
    const res = makeRes();
    await handler(makeReq({ modules: ["binance", "coinbase"] }), res);
    const body = res.body as BulkBody;
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].name).toBe("binance");
    expect(body.failed[0].reason).toBe("NATS down");
    expect(body.succeeded).toContain("coinbase");
  });

  it("persists to db when provided", async () => {
    const dbPath = tmpDbPath();
    const db = new ModuleConfigDb(dbPath);
    db.setDisabled("bybit", true);
    const publish = vi.fn();
    const deps = makeDeps(publish);
    deps.disabledModules.add("bybit");
    const handler = postBulkEnable({ ...deps, db });
    const res = makeRes();
    await handler(makeReq({ modules: ["bybit"] }), res);
    expect(db.loadDisabled()).toEqual([]);
    db.close();
    cleanup(dbPath);
  });
});

describe("POST /api/modules/bulk-disable", () => {
  it("returns 400 when body has no modules array", async () => {
    const deps = makeDeps();
    const handler = postBulkDisable(deps);
    const res = makeRes();
    await handler(makeReq({ wrong: true }), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns empty arrays for empty modules list", async () => {
    const deps = makeDeps();
    const handler = postBulkDisable(deps);
    const res = makeRes();
    await handler(makeReq({ modules: [] }), res);
    const body = res.body as BulkBody;
    expect(body.succeeded).toEqual([]);
    expect(body.failed).toEqual([]);
  });

  it("disables multiple modules and publishes NATS messages", async () => {
    const publish = vi.fn();
    const deps = makeDeps(publish);
    const handler = postBulkDisable(deps);
    const res = makeRes();
    await handler(makeReq({ modules: ["gemini", "okx"] }), res);
    const body = res.body as BulkBody;
    expect(body.succeeded).toContain("gemini");
    expect(body.succeeded).toContain("okx");
    expect(deps.disabledModules.has("gemini")).toBe(true);
    expect(deps.disabledModules.has("okx")).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("reports unknown modules in failed array", async () => {
    const deps = makeDeps();
    const handler = postBulkDisable(deps);
    const res = makeRes();
    await handler(makeReq({ modules: ["nonexistent", "kalshi"] }), res);
    const body = res.body as BulkBody;
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].name).toBe("nonexistent");
    expect(body.succeeded).toContain("kalshi");
  });

  it("already-disabled modules succeed without NATS publish", async () => {
    const publish = vi.fn();
    const deps = makeDeps(publish);
    deps.disabledModules.add("bitstamp");
    const handler = postBulkDisable(deps);
    const res = makeRes();
    await handler(makeReq({ modules: ["bitstamp"] }), res);
    const body = res.body as BulkBody;
    expect(body.succeeded).toContain("bitstamp");
    expect(publish).not.toHaveBeenCalled();
  });

  it("persists to db when provided", async () => {
    const dbPath = tmpDbPath();
    const db = new ModuleConfigDb(dbPath);
    const publish = vi.fn();
    const deps = makeDeps(publish);
    const handler = postBulkDisable({ ...deps, db });
    const res = makeRes();
    await handler(makeReq({ modules: ["polymarket", "aerodrome-base"] }), res);
    const disabled = db.loadDisabled().sort();
    expect(disabled).toEqual(["aerodrome-base", "polymarket"]);
    db.close();
    cleanup(dbPath);
  });

  it("mixed success and failure in single request", async () => {
    const deps = makeDeps();
    const handler = postBulkDisable(deps);
    const res = makeRes();
    await handler(makeReq({ modules: ["binance", "fake1", "coinbase", "fake2"] }), res);
    const body = res.body as BulkBody;
    expect(body.succeeded.sort()).toEqual(["binance", "coinbase"]);
    expect(body.failed.map((f) => f.name).sort()).toEqual(["fake1", "fake2"]);
  });

  it("bulk-disable then bulk-enable restores state", async () => {
    const publish = vi.fn();
    const deps = makeDeps(publish);
    const disableHandler = postBulkDisable(deps);
    const res1 = makeRes();
    await disableHandler(makeReq({ modules: ["uniswap-base", "bybit"] }), res1);
    expect(deps.disabledModules.has("uniswap-base")).toBe(true);
    expect(deps.disabledModules.has("bybit")).toBe(true);

    const enableHandler = postBulkEnable(deps);
    const res2 = makeRes();
    await enableHandler(makeReq({ modules: ["uniswap-base", "bybit"] }), res2);
    expect(deps.disabledModules.has("uniswap-base")).toBe(false);
    expect(deps.disabledModules.has("bybit")).toBe(false);
    expect(publish).toHaveBeenCalledTimes(4);
  });
});
