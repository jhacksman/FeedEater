import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { LiveStatusStore, getStatus } from "../status.js";

function makeReq(): Request {
  return {} as unknown as Request;
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

describe("LiveStatusStore", () => {
  it("returns empty modules when no messages recorded", () => {
    const store = new LiveStatusStore();
    expect(store.getAllModules()).toEqual([]);
  });

  it("records messages and increments count", () => {
    const store = new LiveStatusStore();
    store.recordMessage("binance");
    store.recordMessage("binance");
    store.recordMessage("binance");
    const modules = store.getAllModules();
    expect(modules).toHaveLength(1);
    expect(modules[0].name).toBe("binance");
    expect(modules[0].message_count).toBe(3);
    expect(modules[0].reconnect_count).toBe(0);
    expect(modules[0].last_message_at).toBeDefined();
  });

  it("records reconnects separately from messages", () => {
    const store = new LiveStatusStore();
    store.recordMessage("coinbase");
    store.recordReconnect("coinbase");
    store.recordReconnect("coinbase");
    const modules = store.getAllModules();
    expect(modules[0].message_count).toBe(1);
    expect(modules[0].reconnect_count).toBe(2);
  });

  it("tracks reconnects even before any messages", () => {
    const store = new LiveStatusStore();
    store.recordReconnect("bybit");
    const modules = store.getAllModules();
    expect(modules[0].name).toBe("bybit");
    expect(modules[0].reconnect_count).toBe(1);
    expect(modules[0].message_count).toBe(0);
    expect(modules[0].last_message_at).toBeNull();
  });

  it("returns healthy status for recently active module", () => {
    const store = new LiveStatusStore();
    store.recordMessage("gemini");
    const modules = store.getAllModules();
    expect(modules[0].status).toBe("healthy");
  });

  it("returns offline status for module with no messages", () => {
    const store = new LiveStatusStore();
    store.recordReconnect("okx");
    expect(store.getModuleStatus("okx")).toBe("offline");
  });

  it("returns stale status after 5+ minutes", () => {
    const store = new LiveStatusStore();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(new Date(now).toISOString());
    store.recordMessage("bitstamp");

    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
    expect(store.getModuleStatus("bitstamp")).toBe("stale");

    vi.restoreAllMocks();
  });

  it("returns offline status after 30+ minutes", () => {
    const store = new LiveStatusStore();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(new Date(now).toISOString());
    store.recordMessage("kalshi");

    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60 * 1000);
    expect(store.getModuleStatus("kalshi")).toBe("offline");

    vi.restoreAllMocks();
  });

  it("sorts modules alphabetically", () => {
    const store = new LiveStatusStore();
    store.recordMessage("okx");
    store.recordMessage("binance");
    store.recordMessage("coinbase");
    const names = store.getAllModules().map((m) => m.name);
    expect(names).toEqual(["binance", "coinbase", "okx"]);
  });

  it("tracks uptime in seconds", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = new LiveStatusStore();

    vi.spyOn(Date, "now").mockReturnValue(now + 10_000);
    expect(store.getUptimeSeconds()).toBe(10);

    vi.restoreAllMocks();
  });

  it("isolates modules from each other", () => {
    const store = new LiveStatusStore();
    store.recordMessage("binance");
    store.recordMessage("binance");
    store.recordReconnect("coinbase");
    const modules = store.getAllModules();
    const binance = modules.find((m) => m.name === "binance");
    const coinbase = modules.find((m) => m.name === "coinbase");
    expect(binance?.message_count).toBe(2);
    expect(binance?.reconnect_count).toBe(0);
    expect(coinbase?.message_count).toBe(0);
    expect(coinbase?.reconnect_count).toBe(1);
  });

  it("includes warmState field in module output", () => {
    const store = new LiveStatusStore();
    store.recordMessage("binance");
    const modules = store.getAllModules();
    expect(modules[0]).toHaveProperty("warmState");
  });

  it("returns warming_up when module has no messages yet", () => {
    const store = new LiveStatusStore();
    store.recordReconnect("bybit");
    const modules = store.getAllModules();
    expect(modules[0].warmState).toBe("warming_up");
  });

  it("returns warm after module receives a message", () => {
    const store = new LiveStatusStore();
    store.recordReconnect("gemini");
    expect(store.getWarmState("gemini")).toBe("warming_up");
    store.recordMessage("gemini");
    expect(store.getWarmState("gemini")).toBe("warm");
    const modules = store.getAllModules();
    expect(modules[0].warmState).toBe("warm");
  });

  it("returns stopped for unknown module", () => {
    const store = new LiveStatusStore();
    expect(store.getWarmState("nonexistent")).toBe("stopped");
  });
});

describe("GET /api/status handler", () => {
  it("returns full status shape with nats and postgres connected", async () => {
    const store = new LiveStatusStore();
    store.recordMessage("binance");
    const nc = { isClosed: () => false } as unknown as import("nats").NatsConnection;
    const getNatsConn = vi.fn().mockResolvedValue(nc);
    const mockPrisma = { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) } as unknown as import("@prisma/client").PrismaClient;
    const handler = getStatus({ store, getNatsConn, prisma: mockPrisma });
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as {
      uptime_seconds: number;
      modules: Array<{ name: string; status: string; last_message_at: string | null; message_count: number; reconnect_count: number }>;
      nats_connected: boolean;
      postgres_connected: boolean;
      timestamp: string;
    };
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(body.modules).toHaveLength(1);
    expect(body.modules[0].name).toBe("binance");
    expect(body.nats_connected).toBe(true);
    expect(body.postgres_connected).toBe(true);
    expect(body.timestamp).toBeDefined();
  });

  it("reports nats_connected false when NATS is down", async () => {
    const store = new LiveStatusStore();
    const getNatsConn = vi.fn().mockRejectedValue(new Error("NATS down"));
    const mockPrisma = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as import("@prisma/client").PrismaClient;
    const handler = getStatus({ store, getNatsConn, prisma: mockPrisma });
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { nats_connected: boolean };
    expect(body.nats_connected).toBe(false);
  });

  it("reports postgres_connected false when Postgres is down", async () => {
    const store = new LiveStatusStore();
    const nc = { isClosed: () => false } as unknown as import("nats").NatsConnection;
    const getNatsConn = vi.fn().mockResolvedValue(nc);
    const mockPrisma = { $queryRaw: vi.fn().mockRejectedValue(new Error("PG down")) } as unknown as import("@prisma/client").PrismaClient;
    const handler = getStatus({ store, getNatsConn, prisma: mockPrisma });
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { postgres_connected: boolean };
    expect(body.postgres_connected).toBe(false);
  });

  it("reports nats_connected false when connection is closed", async () => {
    const store = new LiveStatusStore();
    const nc = { isClosed: () => true } as unknown as import("nats").NatsConnection;
    const getNatsConn = vi.fn().mockResolvedValue(nc);
    const mockPrisma = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as import("@prisma/client").PrismaClient;
    const handler = getStatus({ store, getNatsConn, prisma: mockPrisma });
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.body as { nats_connected: boolean };
    expect(body.nats_connected).toBe(false);
  });
});
