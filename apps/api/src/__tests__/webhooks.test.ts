import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import {
  postWebhook,
  listWebhooks,
  deleteWebhook,
  deliverWebhooks,
  signPayload,
  getDeliveries,
  WebhookDb,
  DeliveryLog,
} from "../webhooks.js";
import type { Webhook } from "../webhooks.js";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}): Request {
  return {
    body,
    params,
    headers: {},
  } as unknown as Request;
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

describe("POST /api/webhooks", () => {
  it("registers a webhook and returns id, url, module, createdAt", () => {
    const webhooks: Webhook[] = [];
    const handler = postWebhook({ webhooks });
    const req = makeReq({ url: "https://example.com/hook", module: "binance", secret: "s3cret" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(201);
    const body = res.body as { id: string; url: string; module: string; createdAt: string };
    expect(body.id).toBeDefined();
    expect(body.url).toBe("https://example.com/hook");
    expect(body.module).toBe("binance");
    expect(body.createdAt).toBeDefined();
    expect((body as Record<string, unknown>).secret).toBeUndefined();
    expect(webhooks).toHaveLength(1);
  });

  it("returns 400 when url is missing", () => {
    const webhooks: Webhook[] = [];
    const handler = postWebhook({ webhooks });
    const req = makeReq({ module: "binance", secret: "s3cret" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("url");
  });

  it("returns 400 when module is missing", () => {
    const webhooks: Webhook[] = [];
    const handler = postWebhook({ webhooks });
    const req = makeReq({ url: "https://example.com/hook", secret: "s3cret" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("module");
  });

  it("returns 400 when secret is missing", () => {
    const webhooks: Webhook[] = [];
    const handler = postWebhook({ webhooks });
    const req = makeReq({ url: "https://example.com/hook", module: "binance" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("secret");
  });

  it("returns 400 for unknown module", () => {
    const webhooks: Webhook[] = [];
    const handler = postWebhook({ webhooks });
    const req = makeReq({ url: "https://example.com/hook", module: "unknown-mod", secret: "s3cret" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("Unknown module");
  });
});

describe("GET /api/webhooks", () => {
  it("lists registered webhooks without exposing secret", () => {
    const webhooks: Webhook[] = [
      { id: "wh-1", url: "https://a.com/hook", module: "binance", secret: "top-secret", createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "wh-2", url: "https://b.com/hook", module: "coinbase", secret: "also-secret", createdAt: "2025-01-02T00:00:00.000Z" },
    ];
    const handler = listWebhooks({ webhooks });
    const req = makeReq();
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = res.body as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("wh-1");
    expect(body[0].url).toBe("https://a.com/hook");
    expect(body[0].secret).toBeUndefined();
    expect(body[1].secret).toBeUndefined();
  });

  it("returns empty array when no webhooks registered", () => {
    const webhooks: Webhook[] = [];
    const handler = listWebhooks({ webhooks });
    const req = makeReq();
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("DELETE /api/webhooks/:id", () => {
  it("deletes an existing webhook", () => {
    const webhooks: Webhook[] = [
      { id: "wh-1", url: "https://a.com/hook", module: "binance", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" },
    ];
    const handler = deleteWebhook({ webhooks });
    const req = makeReq({}, { id: "wh-1" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(webhooks).toHaveLength(0);
  });

  it("returns 404 for unknown webhook id", () => {
    const webhooks: Webhook[] = [];
    const handler = deleteWebhook({ webhooks });
    const req = makeReq({}, { id: "nonexistent" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain("not found");
  });
});

describe("deliverWebhooks", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new globalThis.Response("ok", { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires POST to matching webhooks when NATS message arrives", async () => {
    const webhooks: Webhook[] = [
      { id: "wh-1", url: "https://a.com/hook", module: "binance", secret: "mysecret", createdAt: "2025-01-01T00:00:00.000Z" },
    ];

    await deliverWebhooks(webhooks, "binance", { price: 100 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://a.com/hook");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toBeDefined();
    const headers = opts.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-FeedEater-Signature"]).toBeDefined();

    const body = JSON.parse(opts.body as string) as { module: string; data: unknown; timestamp: string };
    expect(body.module).toBe("binance");
    expect(body.data).toEqual({ price: 100 });
    expect(body.timestamp).toBeDefined();
  });

  it("includes valid HMAC-SHA256 signature header", async () => {
    const secret = "test-secret-key";
    const webhooks: Webhook[] = [
      { id: "wh-1", url: "https://a.com/hook", module: "coinbase", secret, createdAt: "2025-01-01T00:00:00.000Z" },
    ];

    await deliverWebhooks(webhooks, "coinbase", { trade: "abc" });

    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    const [, opts] = lastCall as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    const signature = headers["X-FeedEater-Signature"];
    const bodyStr = opts.body as string;
    const expected = signPayload(bodyStr, secret);
    expect(signature).toBe(expected);
  });

  it("does not fire any requests when no webhooks match", async () => {
    const webhooks: Webhook[] = [
      { id: "wh-1", url: "https://a.com/hook", module: "binance", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" },
    ];

    await deliverWebhooks(webhooks, "coinbase", { price: 50 });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not fire any requests when webhooks array is empty", async () => {
    await deliverWebhooks([], "binance", { price: 50 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fires multiple matching webhooks for the same module", async () => {
    const webhooks: Webhook[] = [
      { id: "wh-1", url: "https://a.com/hook", module: "bybit", secret: "s1", createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "wh-2", url: "https://b.com/hook", module: "bybit", secret: "s2", createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "wh-3", url: "https://c.com/hook", module: "binance", secret: "s3", createdAt: "2025-01-01T00:00:00.000Z" },
    ];

    await deliverWebhooks(webhooks, "bybit", { data: 1 });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => (c as [string])[0]);
    expect(urls).toContain("https://a.com/hook");
    expect(urls).toContain("https://b.com/hook");
  });

  it("does not throw when fetch fails after retries", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));
    const webhooks: Webhook[] = [
      { id: "wh-1", url: "https://a.com/hook", module: "okx", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" },
    ];
    const noSleep = () => Promise.resolve();

    await expect(deliverWebhooks(webhooks, "okx", {}, undefined, noSleep)).resolves.toBeUndefined();
  });

  it("retries up to 3 times on failure then logs error", async () => {
    fetchSpy.mockRejectedValue(new Error("connect refused"));
    const log = new DeliveryLog();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const webhooks: Webhook[] = [
      { id: "wh-retry", url: "https://a.com/hook", module: "binance", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" },
    ];
    const noSleep = () => Promise.resolve();

    await deliverWebhooks(webhooks, "binance", { x: 1 }, log, noSleep);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("wh-retry");
    const entries = log.get("wh-retry");
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("failure");
    expect(entries[0].error).toContain("connect refused");
  });

  it("retries on non-2xx then succeeds on second attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(new globalThis.Response("bad", { status: 500 }))
      .mockResolvedValueOnce(new globalThis.Response("ok", { status: 200 }));
    const log = new DeliveryLog();
    const webhooks: Webhook[] = [
      { id: "wh-r2", url: "https://a.com/hook", module: "coinbase", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" },
    ];
    const noSleep = () => Promise.resolve();

    await deliverWebhooks(webhooks, "coinbase", {}, log, noSleep);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const entries = log.get("wh-r2");
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("success");
    expect(entries[0].httpStatus).toBe(200);
  });

  it("records success delivery in log", async () => {
    const log = new DeliveryLog();
    const webhooks: Webhook[] = [
      { id: "wh-log", url: "https://a.com/hook", module: "binance", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" },
    ];

    await deliverWebhooks(webhooks, "binance", { p: 1 }, log);

    const entries = log.get("wh-log");
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("success");
    expect(entries[0].httpStatus).toBe(200);
  });
});

describe("DeliveryLog", () => {
  it("keeps only last 20 entries per webhook", () => {
    const log = new DeliveryLog();
    for (let i = 0; i < 25; i++) {
      log.record("wh-cap", { timestamp: new Date().toISOString(), status: "success", httpStatus: 200 });
    }
    expect(log.get("wh-cap")).toHaveLength(20);
  });

  it("returns empty array for unknown webhook", () => {
    const log = new DeliveryLog();
    expect(log.get("nonexistent")).toEqual([]);
  });
});

describe("GET /api/webhooks/:id/deliveries", () => {
  it("returns delivery entries for a known webhook", () => {
    const log = new DeliveryLog();
    log.record("wh-d1", { timestamp: "2025-01-01T00:00:00.000Z", status: "success", httpStatus: 200 });
    log.record("wh-d1", { timestamp: "2025-01-01T00:01:00.000Z", status: "failure", error: "timeout" });
    const webhooks: Webhook[] = [
      { id: "wh-d1", url: "https://a.com/hook", module: "binance", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" },
    ];
    const handler = getDeliveries({ webhooks, deliveryLog: log });
    const req = makeReq({}, { id: "wh-d1" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = res.body as Array<{ status: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].status).toBe("success");
    expect(body[1].status).toBe("failure");
  });

  it("returns 404 for unknown webhook id", () => {
    const log = new DeliveryLog();
    const webhooks: Webhook[] = [];
    const handler = getDeliveries({ webhooks, deliveryLog: log });
    const req = makeReq({}, { id: "nonexistent" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns empty array when no deliveries yet", () => {
    const log = new DeliveryLog();
    const webhooks: Webhook[] = [
      { id: "wh-empty", url: "https://a.com/hook", module: "binance", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" },
    ];
    const handler = getDeliveries({ webhooks, deliveryLog: log });
    const req = makeReq({}, { id: "wh-empty" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("WebhookDb (SQLite persistence)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `feedeater-test-${randomUUID()}.db`);
  });

  afterEach(() => {
    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch {}
  });

  it("persists webhooks and loads them on re-open", () => {
    const db1 = new WebhookDb(dbPath);
    const wh: Webhook = { id: "persist-1", url: "https://a.com", module: "binance", secret: "sec", createdAt: "2025-01-01T00:00:00.000Z" };
    db1.insert(wh);
    db1.close();

    const db2 = new WebhookDb(dbPath);
    const loaded = db2.loadAll();
    db2.close();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("persist-1");
    expect(loaded[0].url).toBe("https://a.com");
    expect(loaded[0].module).toBe("binance");
    expect(loaded[0].secret).toBe("sec");
    expect(loaded[0].createdAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("removes a webhook from the database", () => {
    const db = new WebhookDb(dbPath);
    db.insert({ id: "rm-1", url: "https://a.com", module: "binance", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" });
    db.insert({ id: "rm-2", url: "https://b.com", module: "coinbase", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" });
    db.remove("rm-1");
    const loaded = db.loadAll();
    db.close();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("rm-2");
  });

  it("postWebhook syncs to SQLite when db provided", () => {
    const db = new WebhookDb(dbPath);
    const webhooks: Webhook[] = [];
    const handler = postWebhook({ webhooks, db });
    const req = makeReq({ url: "https://x.com/hook", module: "binance", secret: "s" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(201);

    const loaded = db.loadAll();
    db.close();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].url).toBe("https://x.com/hook");
  });

  it("deleteWebhook syncs removal to SQLite when db provided", () => {
    const db = new WebhookDb(dbPath);
    const wh: Webhook = { id: "del-db", url: "https://a.com", module: "binance", secret: "s", createdAt: "2025-01-01T00:00:00.000Z" };
    db.insert(wh);
    const webhooks: Webhook[] = [wh];
    const handler = deleteWebhook({ webhooks, db });
    const req = makeReq({}, { id: "del-db" });
    const res = makeRes();
    handler(req, res);
    expect(res.statusCode).toBe(200);

    const loaded = db.loadAll();
    db.close();
    expect(loaded).toHaveLength(0);
  });

  it("returns empty array from fresh database", () => {
    const db = new WebhookDb(dbPath);
    expect(db.loadAll()).toEqual([]);
    db.close();
  });

  it("simulates server restart: webhooks survive via SQLite", () => {
    const db1 = new WebhookDb(dbPath);
    db1.insert({ id: "srv-1", url: "https://a.com", module: "coinbase", secret: "s1", createdAt: "2025-01-01T00:00:00.000Z" });
    db1.insert({ id: "srv-2", url: "https://b.com", module: "binance", secret: "s2", createdAt: "2025-01-02T00:00:00.000Z" });
    db1.close();

    const db2 = new WebhookDb(dbPath);
    const webhooks = db2.loadAll();
    db2.close();

    expect(webhooks).toHaveLength(2);
    expect(webhooks.map((w) => w.id).sort()).toEqual(["srv-1", "srv-2"]);
  });
});
