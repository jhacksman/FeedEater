import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { UsageTracker, getKeyUsage } from "../usageTracker.js";
import { ApiKeyDb } from "../apiKeys.js";
import { apiKeyAuth, setDynamicKeyDb, setUsageTracker } from "../middleware/auth.js";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

const USAGE_DB = `/tmp/test-usage-${randomUUID()}.db`;
const KEYS_DB = `/tmp/test-keys-usage-${randomUUID()}.db`;

let tracker: UsageTracker;
let keyDb: ApiKeyDb;

beforeEach(() => {
  tracker = new UsageTracker(USAGE_DB);
  keyDb = new ApiKeyDb(KEYS_DB);
});

afterEach(() => {
  tracker.close();
  keyDb.close();
  for (const p of [USAGE_DB, KEYS_DB]) {
    try { unlinkSync(p); } catch {}
    try { unlinkSync(p + "-wal"); } catch {}
    try { unlinkSync(p + "-shm"); } catch {}
  }
  delete process.env.API_KEY;
  setDynamicKeyDb(null as unknown as ApiKeyDb);
  setUsageTracker(null as unknown as UsageTracker);
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

describe("UsageTracker", () => {
  it("records a request and returns usage", () => {
    tracker.recordRequest("key-1");
    const usage = tracker.getUsage("key-1");
    expect(usage).toHaveLength(1);
    expect(usage[0].count).toBe(1);
  });

  it("increments count on repeated requests same day", () => {
    tracker.recordRequest("key-1");
    tracker.recordRequest("key-1");
    tracker.recordRequest("key-1");
    const usage = tracker.getUsage("key-1");
    expect(usage).toHaveLength(1);
    expect(usage[0].count).toBe(3);
  });

  it("tracks different keys independently", () => {
    tracker.recordRequest("key-a");
    tracker.recordRequest("key-a");
    tracker.recordRequest("key-b");
    expect(tracker.getTotalUsage("key-a")).toBe(2);
    expect(tracker.getTotalUsage("key-b")).toBe(1);
  });

  it("getTotalUsage returns 0 for unknown key", () => {
    expect(tracker.getTotalUsage("nonexistent")).toBe(0);
  });

  it("getUsage returns empty array for unknown key", () => {
    expect(tracker.getUsage("nonexistent")).toEqual([]);
  });

  it("getUsage returns entries with date and count", () => {
    tracker.recordRequest("key-1");
    const usage = tracker.getUsage("key-1");
    expect(usage[0]).toHaveProperty("date");
    expect(usage[0]).toHaveProperty("count");
    expect(usage[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("getTotalUsage sums across all days", () => {
    tracker.recordRequest("key-1");
    tracker.recordRequest("key-1");
    tracker.recordRequest("key-1");
    expect(tracker.getTotalUsage("key-1")).toBe(3);
  });

  it("getUsage respects days parameter", () => {
    tracker.recordRequest("key-1");
    const usage = tracker.getUsage("key-1", 1);
    expect(usage).toHaveLength(1);
    const usageWide = tracker.getUsage("key-1", 365);
    expect(usageWide).toHaveLength(1);
  });

  it("getUsage default is 30 days", () => {
    tracker.recordRequest("key-1");
    const usage = tracker.getUsage("key-1");
    expect(usage.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/keys/:id/usage handler", () => {
  it("returns usage for key with requests", () => {
    tracker.recordRequest("key-abc");
    tracker.recordRequest("key-abc");
    const handler = getKeyUsage({ tracker });
    const res = makeRes();
    handler(makeReq({ params: { id: "key-abc" } } as Partial<Request>), res);
    const body = res.body as { keyId: string; totalRequests: number; dailyBreakdown: Array<{ date: string; count: number }> };
    expect(body.keyId).toBe("key-abc");
    expect(body.totalRequests).toBe(2);
    expect(body.dailyBreakdown).toHaveLength(1);
    expect(body.dailyBreakdown[0].count).toBe(2);
  });

  it("returns zero usage for key with no requests", () => {
    const handler = getKeyUsage({ tracker });
    const res = makeRes();
    handler(makeReq({ params: { id: "no-requests" } } as Partial<Request>), res);
    const body = res.body as { keyId: string; totalRequests: number; dailyBreakdown: unknown[] };
    expect(body.totalRequests).toBe(0);
    expect(body.dailyBreakdown).toEqual([]);
  });

  it("respects days query param", () => {
    tracker.recordRequest("key-days");
    const handler = getKeyUsage({ tracker });
    const res = makeRes();
    handler(makeReq({ params: { id: "key-days" }, query: { days: "7" } } as Partial<Request>), res);
    const body = res.body as { dailyBreakdown: unknown[] };
    expect(body.dailyBreakdown).toHaveLength(1);
  });

  it("returns 400 when id is missing", () => {
    const handler = getKeyUsage({ tracker });
    const res = makeRes();
    handler(makeReq({ params: { id: "" } } as Partial<Request>), res);
    expect(res.statusCode).toBe(400);
  });
});

describe("apiKeyAuth usage tracking integration", () => {
  it("records request when dynamic key is used", () => {
    process.env.API_KEY = "static-key";
    setDynamicKeyDb(keyDb);
    setUsageTracker(tracker);
    const created = keyDb.createKey("tracked");
    const res = makeRes();
    let called = false;
    apiKeyAuth(
      makeReq({ headers: { authorization: `Bearer ${created.key}` }, path: "/api/status" } as Partial<Request>),
      res,
      (() => { called = true; }) as NextFunction,
    );
    expect(called).toBe(true);
    expect(tracker.getTotalUsage(created.id)).toBe(1);
  });

  it("increments on multiple requests with same key", () => {
    process.env.API_KEY = "static-key";
    setDynamicKeyDb(keyDb);
    setUsageTracker(tracker);
    const created = keyDb.createKey("multi");
    const req = makeReq({ headers: { authorization: `Bearer ${created.key}` }, path: "/api/status" } as Partial<Request>);
    const noop = (() => {}) as NextFunction;
    apiKeyAuth(req, makeRes(), noop);
    apiKeyAuth(req, makeRes(), noop);
    apiKeyAuth(req, makeRes(), noop);
    expect(tracker.getTotalUsage(created.id)).toBe(3);
  });

  it("does not record for static env key", () => {
    process.env.API_KEY = "static-key";
    setDynamicKeyDb(keyDb);
    setUsageTracker(tracker);
    const res = makeRes();
    let called = false;
    apiKeyAuth(
      makeReq({ headers: { authorization: "Bearer static-key" }, path: "/api/status" } as Partial<Request>),
      res,
      (() => { called = true; }) as NextFunction,
    );
    expect(called).toBe(true);
    expect(tracker.getUsage("static-key")).toEqual([]);
  });

  it("does not record for rejected key", () => {
    process.env.API_KEY = "static-key";
    setDynamicKeyDb(keyDb);
    setUsageTracker(tracker);
    const res = makeRes();
    apiKeyAuth(
      makeReq({ headers: { authorization: "Bearer bogus" }, path: "/api/status" } as Partial<Request>),
      res,
      (() => {}) as NextFunction,
    );
    expect(res.statusCode).toBe(401);
  });
});
