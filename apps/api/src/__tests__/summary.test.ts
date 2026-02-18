import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { StalenessTracker } from "../staleness.js";
import { ApiKeyDb } from "../apiKeys.js";
import { DeliveryLog } from "../webhooks.js";
import type { Webhook } from "../webhooks.js";
import { getStatusSummary } from "../statusSummary.js";
import { recordReconnect, resetStore as resetReconnects } from "../reconnects.js";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

const KEYS_DB = `/tmp/test-summary-keys-${randomUUID()}.db`;

let keyDb: ApiKeyDb;

beforeEach(() => {
  keyDb = new ApiKeyDb(KEYS_DB);
  resetReconnects();
});

afterEach(() => {
  keyDb.close();
  try { unlinkSync(KEYS_DB); } catch {}
  try { unlinkSync(KEYS_DB + "-wal"); } catch {}
  try { unlinkSync(KEYS_DB + "-shm"); } catch {}
});

function makeReq(): Request {
  return { params: {}, body: {}, headers: {}, query: {} } as unknown as Request;
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

function makeDeps(overrides: Partial<Parameters<typeof getStatusSummary>[0]> = {}) {
  const stalenessTracker = new StalenessTracker();
  const disabledModules = new Set<string>();
  const webhooks: Webhook[] = [];
  const deliveryLog = new DeliveryLog();
  const getNatsConn = () => Promise.resolve({} as import("nats").NatsConnection);
  return {
    stalenessTracker,
    disabledModules,
    webhooks,
    deliveryLog,
    apiKeyDb: keyDb,
    getNatsConn,
    ...overrides,
  };
}

describe("GET /api/status/summary", () => {
  it("returns all required top-level fields", async () => {
    const handler = getStatusSummary(makeDeps());
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("modules");
    expect(body).toHaveProperty("storage");
    expect(body).toHaveProperty("webhooks");
    expect(body).toHaveProperty("apiKeys");
    expect(body).toHaveProperty("nats");
  });

  it("timestamp is a valid ISO string", async () => {
    const handler = getStatusSummary(makeDeps());
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { timestamp: string };
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it("modules array contains all known modules", async () => {
    const handler = getStatusSummary(makeDeps());
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { modules: Array<{ name: string }> };
    expect(body.modules.length).toBeGreaterThanOrEqual(10);
    const names = body.modules.map((m) => m.name);
    expect(names).toContain("binance");
    expect(names).toContain("coinbase");
    expect(names).toContain("polymarket");
  });

  it("module entries have all required fields", async () => {
    const handler = getStatusSummary(makeDeps());
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { modules: Array<Record<string, unknown>> };
    const mod = body.modules[0];
    expect(mod).toHaveProperty("name");
    expect(mod).toHaveProperty("enabled");
    expect(mod).toHaveProperty("stale");
    expect(mod).toHaveProperty("staleSecs");
    expect(mod).toHaveProperty("reconnectCount");
  });

  it("disabled modules show enabled: false", async () => {
    const disabled = new Set(["binance"]);
    const handler = getStatusSummary(makeDeps({ disabledModules: disabled }));
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { modules: Array<{ name: string; enabled: boolean }> };
    const binance = body.modules.find((m) => m.name === "binance");
    expect(binance?.enabled).toBe(false);
    const coinbase = body.modules.find((m) => m.name === "coinbase");
    expect(coinbase?.enabled).toBe(true);
  });

  it("reflects staleness data", async () => {
    const tracker = new StalenessTracker(() => 100_000);
    tracker.updateModuleSeen("binance");
    const tracker2 = new StalenessTracker(() => 200_000);
    Object.assign(tracker, { nowFn: () => 200_000 });
    const handler = getStatusSummary(makeDeps({ stalenessTracker: tracker }));
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { modules: Array<{ name: string; staleSecs: number; stale: boolean }> };
    const binance = body.modules.find((m) => m.name === "binance");
    expect(binance?.staleSecs).toBeGreaterThan(0);
  });

  it("reflects reconnect counts", async () => {
    recordReconnect("okx");
    recordReconnect("okx");
    recordReconnect("okx");
    const handler = getStatusSummary(makeDeps());
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { modules: Array<{ name: string; reconnectCount: number }> };
    const okx = body.modules.find((m) => m.name === "okx");
    expect(okx?.reconnectCount).toBe(3);
  });

  it("webhooks shows registered count", async () => {
    const webhooks: Webhook[] = [
      { id: "w1", url: "http://a.com", module: "binance", secret: "s", createdAt: new Date().toISOString() },
      { id: "w2", url: "http://b.com", module: "okx", secret: "s", createdAt: new Date().toISOString() },
    ];
    const handler = getStatusSummary(makeDeps({ webhooks }));
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { webhooks: { registered: number; totalDeliveries: number } };
    expect(body.webhooks.registered).toBe(2);
  });

  it("webhooks shows totalDeliveries from log", async () => {
    const deliveryLog = new DeliveryLog();
    deliveryLog.record("w1", { timestamp: new Date().toISOString(), status: "success", httpStatus: 200 });
    deliveryLog.record("w1", { timestamp: new Date().toISOString(), status: "failure", error: "timeout" });
    const webhooks: Webhook[] = [
      { id: "w1", url: "http://a.com", module: "binance", secret: "s", createdAt: new Date().toISOString() },
    ];
    const handler = getStatusSummary(makeDeps({ webhooks, deliveryLog }));
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { webhooks: { totalDeliveries: number } };
    expect(body.webhooks.totalDeliveries).toBe(2);
  });

  it("apiKeys shows active count", async () => {
    keyDb.createKey("key-1");
    keyDb.createKey("key-2");
    const handler = getStatusSummary(makeDeps());
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { apiKeys: { active: number } };
    expect(body.apiKeys.active).toBe(2);
  });

  it("nats connected is true when connection succeeds", async () => {
    const handler = getStatusSummary(makeDeps());
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { nats: { connected: boolean } };
    expect(body.nats.connected).toBe(true);
  });

  it("nats connected is false when connection fails", async () => {
    const getNatsConn = () => Promise.reject(new Error("connection refused"));
    const handler = getStatusSummary(makeDeps({ getNatsConn }));
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { nats: { connected: boolean } };
    expect(body.nats.connected).toBe(false);
  });

  it("storage fields are present", async () => {
    const handler = getStatusSummary(makeDeps());
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { storage: { totalMessages: number; dbSizeMb: number } };
    expect(body.storage).toHaveProperty("totalMessages");
    expect(body.storage).toHaveProperty("dbSizeMb");
  });

  it("modules are sorted alphabetically", async () => {
    const handler = getStatusSummary(makeDeps());
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { modules: Array<{ name: string }> };
    const names = body.modules.map((m) => m.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});
