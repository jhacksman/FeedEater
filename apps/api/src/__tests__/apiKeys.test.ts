import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { ApiKeyDb, masterKeyAuth, postApiKey, listApiKeys, deleteApiKey } from "../apiKeys.js";
import { apiKeyAuth, setDynamicKeyDb } from "../middleware/auth.js";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

const TEST_DB = `/tmp/test-apikeys-${randomUUID()}.db`;

let db: ApiKeyDb;

beforeEach(() => {
  db = new ApiKeyDb(TEST_DB);
});

afterEach(() => {
  db.close();
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
});

function makeReq(overrides: Partial<Request> = {}): Request {
  return { params: {}, body: {}, headers: {}, ...overrides } as unknown as Request;
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

describe("ApiKeyDb", () => {
  it("creates a key and returns id, key, label, createdAt", () => {
    const result = db.createKey("test-label");
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("key");
    expect(result).toHaveProperty("label", "test-label");
    expect(result).toHaveProperty("createdAt");
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lists non-revoked keys without key values", () => {
    db.createKey("key-one");
    db.createKey("key-two");
    const list = db.listKeys();
    expect(list).toHaveLength(2);
    expect(list[0]).toHaveProperty("id");
    expect(list[0]).toHaveProperty("label");
    expect(list[0]).toHaveProperty("createdAt");
    expect(list[0]).toHaveProperty("lastUsedAt");
    expect(list[0]).not.toHaveProperty("key");
  });

  it("revokes a key and excludes from list", () => {
    const created = db.createKey("to-revoke");
    expect(db.listKeys()).toHaveLength(1);
    const revoked = db.revokeKey(created.id);
    expect(revoked).toBe(true);
    expect(db.listKeys()).toHaveLength(0);
  });

  it("revokeKey returns false for unknown id", () => {
    expect(db.revokeKey("nonexistent-id")).toBe(false);
  });

  it("revokeKey returns false for already-revoked key", () => {
    const created = db.createKey("double-revoke");
    db.revokeKey(created.id);
    expect(db.revokeKey(created.id)).toBe(false);
  });

  it("isValidKey returns true for active key", () => {
    const created = db.createKey("valid-key");
    expect(db.isValidKey(created.key)).toBe(true);
  });

  it("isValidKey returns false for revoked key", () => {
    const created = db.createKey("revoked-key");
    db.revokeKey(created.id);
    expect(db.isValidKey(created.key)).toBe(false);
  });

  it("isValidKey returns false for unknown key", () => {
    expect(db.isValidKey("not-a-real-key")).toBe(false);
  });

  it("isValidKey updates last_used_at", () => {
    const created = db.createKey("track-usage");
    const before = db.listKeys().find((k) => k.id === created.id);
    expect(before?.lastUsedAt).toBeNull();
    db.isValidKey(created.key);
    const after = db.listKeys().find((k) => k.id === created.id);
    expect(after?.lastUsedAt).not.toBeNull();
  });

  it("creates multiple keys with unique ids and key values", () => {
    const k1 = db.createKey("first");
    const k2 = db.createKey("second");
    expect(k1.id).not.toBe(k2.id);
    expect(k1.key).not.toBe(k2.key);
  });
});

describe("masterKeyAuth", () => {
  it("returns 503 when MASTER_API_KEY not set", () => {
    delete process.env.MASTER_API_KEY;
    const res = makeRes();
    let called = false;
    masterKeyAuth(makeReq(), res, (() => { called = true; }) as NextFunction);
    expect(res.statusCode).toBe(503);
    expect(called).toBe(false);
  });

  it("returns 401 when X-Master-Key header missing", () => {
    process.env.MASTER_API_KEY = "master-secret";
    const res = makeRes();
    let called = false;
    masterKeyAuth(makeReq(), res, (() => { called = true; }) as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(called).toBe(false);
    delete process.env.MASTER_API_KEY;
  });

  it("returns 401 when X-Master-Key header wrong", () => {
    process.env.MASTER_API_KEY = "master-secret";
    const res = makeRes();
    let called = false;
    masterKeyAuth(
      makeReq({ headers: { "x-master-key": "wrong" } } as Partial<Request>),
      res,
      (() => { called = true; }) as NextFunction,
    );
    expect(res.statusCode).toBe(401);
    expect(called).toBe(false);
    delete process.env.MASTER_API_KEY;
  });

  it("calls next when X-Master-Key matches", () => {
    process.env.MASTER_API_KEY = "master-secret";
    const res = makeRes();
    let called = false;
    masterKeyAuth(
      makeReq({ headers: { "x-master-key": "master-secret" } } as Partial<Request>),
      res,
      (() => { called = true; }) as NextFunction,
    );
    expect(called).toBe(true);
    delete process.env.MASTER_API_KEY;
  });
});

describe("POST /api/keys handler", () => {
  it("returns 400 when label missing", () => {
    const handler = postApiKey({ db });
    const res = makeRes();
    handler(makeReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when label is empty string", () => {
    const handler = postApiKey({ db });
    const res = makeRes();
    handler(makeReq({ body: { label: "  " } }), res);
    expect(res.statusCode).toBe(400);
  });

  it("creates key and returns 201", () => {
    const handler = postApiKey({ db });
    const res = makeRes();
    handler(makeReq({ body: { label: "my-service" } }), res);
    expect(res.statusCode).toBe(201);
    const body = res.body as { id: string; key: string; label: string; createdAt: string };
    expect(body.label).toBe("my-service");
    expect(body.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("trims label whitespace", () => {
    const handler = postApiKey({ db });
    const res = makeRes();
    handler(makeReq({ body: { label: "  trimmed  " } }), res);
    expect((res.body as { label: string }).label).toBe("trimmed");
  });
});

describe("GET /api/keys handler", () => {
  it("returns empty array when no keys", () => {
    const handler = listApiKeys({ db });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body).toEqual([]);
  });

  it("returns keys without key values", () => {
    db.createKey("key-a");
    db.createKey("key-b");
    const handler = listApiKeys({ db });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as Array<{ id: string; label: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]).not.toHaveProperty("key");
  });

  it("excludes revoked keys", () => {
    const created = db.createKey("to-revoke");
    db.createKey("keep");
    db.revokeKey(created.id);
    const handler = listApiKeys({ db });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body).toHaveLength(1);
  });
});

describe("DELETE /api/keys/:id handler", () => {
  it("revokes key and returns {revoked: true}", () => {
    const created = db.createKey("del-me");
    const handler = deleteApiKey({ db });
    const res = makeRes();
    handler(makeReq({ params: { id: created.id } } as Partial<Request>), res);
    expect(res.body).toEqual({ revoked: true });
  });

  it("returns 404 for unknown id", () => {
    const handler = deleteApiKey({ db });
    const res = makeRes();
    handler(makeReq({ params: { id: "no-such-id" } } as Partial<Request>), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for already-revoked key", () => {
    const created = db.createKey("revoke-twice");
    db.revokeKey(created.id);
    const handler = deleteApiKey({ db });
    const res = makeRes();
    handler(makeReq({ params: { id: created.id } } as Partial<Request>), res);
    expect(res.statusCode).toBe(404);
  });
});

describe("apiKeyAuth with dynamic keys", () => {
  afterEach(() => {
    delete process.env.API_KEY;
    setDynamicKeyDb(null as unknown as ApiKeyDb);
  });

  it("accepts dynamic key when env API_KEY is set", () => {
    process.env.API_KEY = "static-key";
    setDynamicKeyDb(db);
    const created = db.createKey("dynamic");
    const res = makeRes();
    let called = false;
    apiKeyAuth(
      makeReq({ headers: { authorization: `Bearer ${created.key}` }, path: "/api/keys" } as Partial<Request>),
      res,
      (() => { called = true; }) as NextFunction,
    );
    expect(called).toBe(true);
  });

  it("rejects revoked dynamic key", () => {
    process.env.API_KEY = "static-key";
    setDynamicKeyDb(db);
    const created = db.createKey("to-revoke");
    db.revokeKey(created.id);
    const res = makeRes();
    let called = false;
    apiKeyAuth(
      makeReq({ headers: { authorization: `Bearer ${created.key}` }, path: "/api/keys" } as Partial<Request>),
      res,
      (() => { called = true; }) as NextFunction,
    );
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("still accepts static env API_KEY", () => {
    process.env.API_KEY = "static-key";
    setDynamicKeyDb(db);
    const res = makeRes();
    let called = false;
    apiKeyAuth(
      makeReq({ headers: { authorization: "Bearer static-key" }, path: "/api/keys" } as Partial<Request>),
      res,
      (() => { called = true; }) as NextFunction,
    );
    expect(called).toBe(true);
  });

  it("rejects invalid key when dynamic db is set", () => {
    process.env.API_KEY = "static-key";
    setDynamicKeyDb(db);
    const res = makeRes();
    let called = false;
    apiKeyAuth(
      makeReq({ headers: { authorization: "Bearer bogus" }, path: "/api/keys" } as Partial<Request>),
      res,
      (() => { called = true; }) as NextFunction,
    );
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
