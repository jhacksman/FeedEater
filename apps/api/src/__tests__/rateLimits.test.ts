import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { RateLimitDb, adminKeyAuth, listRateLimits, putRateLimit, deleteRateLimit } from "../rateLimitConfig.js";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

const DB_PATH = `/tmp/test-rate-limits-${randomUUID()}.db`;

let db: RateLimitDb;

beforeEach(() => {
  db = new RateLimitDb(DB_PATH);
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(DB_PATH + "-wal"); } catch {}
  try { unlinkSync(DB_PATH + "-shm"); } catch {}
});

function makeReq(overrides: Partial<Request> = {}): Request {
  return { params: {}, body: {}, headers: {}, query: {}, ...overrides } as unknown as Request;
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

const DEFAULT_LIMIT = 100;
function deps() {
  return { db, defaultLimit: DEFAULT_LIMIT };
}

describe("RateLimitDb", () => {
  it("returns null for unknown key", () => {
    expect(db.getLimit("unknown-key")).toBeNull();
  });

  it("stores and retrieves a custom limit", () => {
    db.setLimit("key-1", 500);
    expect(db.getLimit("key-1")).toBe(500);
  });

  it("updates existing limit", () => {
    db.setLimit("key-1", 500);
    db.setLimit("key-1", 200);
    expect(db.getLimit("key-1")).toBe(200);
  });

  it("deletes a custom limit", () => {
    db.setLimit("key-1", 500);
    expect(db.deleteLimit("key-1")).toBe(true);
    expect(db.getLimit("key-1")).toBeNull();
  });

  it("returns false when deleting non-existent limit", () => {
    expect(db.deleteLimit("no-such-key")).toBe(false);
  });

  it("lists all custom limits", () => {
    db.setLimit("key-a", 50);
    db.setLimit("key-b", 200);
    const all = db.listAll();
    expect(all).toHaveLength(2);
    const keys = all.map((r) => r.apiKey);
    expect(keys).toContain("key-a");
    expect(keys).toContain("key-b");
  });
});

describe("adminKeyAuth", () => {
  it("rejects when ADMIN_KEY is not set", () => {
    const orig = process.env.ADMIN_KEY;
    delete process.env.ADMIN_KEY;
    const res = makeRes();
    let called = false;
    adminKeyAuth(makeReq(), res, (() => { called = true; }) as unknown as NextFunction);
    expect(called).toBe(false);
    expect(res.statusCode).toBe(503);
    if (orig) process.env.ADMIN_KEY = orig;
  });

  it("rejects when X-Admin-Key header is missing", () => {
    const orig = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = "secret-admin";
    const res = makeRes();
    let called = false;
    adminKeyAuth(makeReq(), res, (() => { called = true; }) as unknown as NextFunction);
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    process.env.ADMIN_KEY = orig ?? "";
    if (!orig) delete process.env.ADMIN_KEY;
  });

  it("passes when X-Admin-Key matches", () => {
    const orig = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = "secret-admin";
    const res = makeRes();
    let called = false;
    const req = makeReq({ headers: { "x-admin-key": "secret-admin" } as Record<string, string> });
    adminKeyAuth(req, res, (() => { called = true; }) as unknown as NextFunction);
    expect(called).toBe(true);
    process.env.ADMIN_KEY = orig ?? "";
    if (!orig) delete process.env.ADMIN_KEY;
  });
});

describe("GET /api/rate-limits", () => {
  it("returns defaultLimit and empty overrides", () => {
    const handler = listRateLimits(deps());
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { defaultLimit: number; overrides: unknown[] };
    expect(body.defaultLimit).toBe(DEFAULT_LIMIT);
    expect(body.overrides).toEqual([]);
  });

  it("lists stored overrides", () => {
    db.setLimit("key-x", 300);
    const handler = listRateLimits(deps());
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { overrides: Array<{ apiKey: string; requestsPerMinute: number }> };
    expect(body.overrides).toHaveLength(1);
    expect(body.overrides[0]!.apiKey).toBe("key-x");
    expect(body.overrides[0]!.requestsPerMinute).toBe(300);
  });
});

describe("PUT /api/rate-limits/:key", () => {
  it("sets a custom rate limit", () => {
    const handler = putRateLimit(deps());
    const res = makeRes();
    handler(makeReq({ params: { key: "k1" }, body: { requestsPerMinute: 250 } } as Partial<Request>), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { apiKey: string; requestsPerMinute: number };
    expect(body.apiKey).toBe("k1");
    expect(body.requestsPerMinute).toBe(250);
    expect(db.getLimit("k1")).toBe(250);
  });

  it("rejects missing requestsPerMinute", () => {
    const handler = putRateLimit(deps());
    const res = makeRes();
    handler(makeReq({ params: { key: "k1" }, body: {} } as Partial<Request>), res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects requestsPerMinute below 1", () => {
    const handler = putRateLimit(deps());
    const res = makeRes();
    handler(makeReq({ params: { key: "k1" }, body: { requestsPerMinute: 0 } } as Partial<Request>), res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects requestsPerMinute above 10000", () => {
    const handler = putRateLimit(deps());
    const res = makeRes();
    handler(makeReq({ params: { key: "k1" }, body: { requestsPerMinute: 99999 } } as Partial<Request>), res);
    expect(res.statusCode).toBe(400);
  });

  it("floors fractional values", () => {
    const handler = putRateLimit(deps());
    const res = makeRes();
    handler(makeReq({ params: { key: "k1" }, body: { requestsPerMinute: 55.9 } } as Partial<Request>), res);
    const body = res.body as { requestsPerMinute: number };
    expect(body.requestsPerMinute).toBe(55);
  });
});

describe("DELETE /api/rate-limits/:key", () => {
  it("resets a custom limit", () => {
    db.setLimit("k1", 500);
    const handler = deleteRateLimit(deps());
    const res = makeRes();
    handler(makeReq({ params: { key: "k1" } } as Partial<Request>), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { apiKey: string; resetToDefault: number };
    expect(body.resetToDefault).toBe(DEFAULT_LIMIT);
    expect(db.getLimit("k1")).toBeNull();
  });

  it("returns 404 for non-existent key", () => {
    const handler = deleteRateLimit(deps());
    const res = makeRes();
    handler(makeReq({ params: { key: "nope" } } as Partial<Request>), res);
    expect(res.statusCode).toBe(404);
  });
});
