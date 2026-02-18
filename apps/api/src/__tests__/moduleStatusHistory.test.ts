import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import type { Request, Response } from "express";
import { StatusHistoryDb, getModuleStatusHistory } from "../moduleStatusHistory.js";

const TEST_DB = `/tmp/test-status-history-${process.pid}.db`;

function makeReq(params: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return { params, query } as unknown as Request;
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

interface HistoryResponse {
  module: string;
  events: Array<{
    id: number;
    module: string;
    timestamp: string;
    event_type: string;
    message: string;
    details: unknown;
  }>;
  total_events: number;
  note?: string;
}

describe("GET /api/modules/:name/status/history", () => {
  let db: StatusHistoryDb;

  beforeEach(() => {
    db = new StatusHistoryDb(TEST_DB);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "unknown-mod" }), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain("Unknown module");
  });

  it("returns empty events with note when no history exists", () => {
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    const body = res.body as HistoryResponse;
    expect(body.module).toBe("binance");
    expect(body.events).toEqual([]);
    expect(body.total_events).toBe(0);
    expect(body.note).toBe("No status events recorded for this module");
  });

  it("returns events with correct shape", () => {
    db.record("coinbase", "started", "Module started");
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "coinbase" }), res);
    const body = res.body as HistoryResponse;
    expect(body.module).toBe("coinbase");
    expect(body.events.length).toBe(1);
    expect(body.events[0].id).toBeTypeOf("number");
    expect(body.events[0].module).toBe("coinbase");
    expect(body.events[0].timestamp).toBeTypeOf("string");
    expect(body.events[0].event_type).toBe("started");
    expect(body.events[0].message).toBe("Module started");
    expect(body.events[0].details).toBeNull();
    expect(body.total_events).toBe(1);
    expect(body.note).toBeUndefined();
  });

  it("stores and returns details as parsed JSON", () => {
    db.record("bybit", "error", "Connection failed", { code: 1006, reason: "timeout" });
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "bybit" }), res);
    const body = res.body as HistoryResponse;
    expect(body.events[0].details).toEqual({ code: 1006, reason: "timeout" });
  });

  it("defaults to 50 events", () => {
    for (let i = 0; i < 80; i++) {
      db.record("gemini", "started", `event-${i}`);
    }
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "gemini" }), res);
    const body = res.body as HistoryResponse;
    expect(body.events.length).toBe(50);
    expect(body.total_events).toBe(80);
  });

  it("respects ?limit query param", () => {
    for (let i = 0; i < 20; i++) {
      db.record("bitstamp", "started", `event-${i}`);
    }
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "bitstamp" }, { limit: "5" }), res);
    const body = res.body as HistoryResponse;
    expect(body.events.length).toBe(5);
    expect(body.total_events).toBe(20);
  });

  it("caps limit at 500", () => {
    for (let i = 0; i < 10; i++) {
      db.record("okx", "started", `event-${i}`);
    }
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "okx" }, { limit: "999" }), res);
    const body = res.body as HistoryResponse;
    expect(body.events.length).toBe(10);
  });

  it("returns 400 for invalid limit param", () => {
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "kalshi" }, { limit: "abc" }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("limit must be a positive integer");
  });

  it("returns 400 for zero limit", () => {
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "kalshi" }, { limit: "0" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for negative limit", () => {
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "kalshi" }, { limit: "-3" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns events in chronological order (oldest first)", () => {
    db.record("polymarket", "started", "first");
    db.record("polymarket", "error", "second");
    db.record("polymarket", "reconnected", "third");
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "polymarket" }), res);
    const body = res.body as HistoryResponse;
    expect(body.events[0].message).toBe("first");
    expect(body.events[1].message).toBe("second");
    expect(body.events[2].message).toBe("third");
  });

  it("supports all event types", () => {
    const types = ["started", "stopped", "error", "reconnected", "rate-limited", "config-changed"] as const;
    for (const t of types) {
      db.record("aerodrome-base", t, `${t} event`);
    }
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "aerodrome-base" }), res);
    const body = res.body as HistoryResponse;
    const eventTypes = body.events.map((e) => e.event_type);
    expect(eventTypes).toEqual([...types]);
  });

  it("isolates events per module", () => {
    db.record("binance", "started", "binance event");
    db.record("coinbase", "error", "coinbase event");
    const handler = getModuleStatusHistory({ historyDb: db });

    const res1 = makeRes();
    handler(makeReq({ name: "binance" }), res1);
    const body1 = res1.body as HistoryResponse;
    expect(body1.events.length).toBe(1);
    expect(body1.events[0].message).toBe("binance event");

    const res2 = makeRes();
    handler(makeReq({ name: "coinbase" }), res2);
    const body2 = res2.body as HistoryResponse;
    expect(body2.events.length).toBe(1);
    expect(body2.events[0].message).toBe("coinbase event");
  });

  it("returns most recent events when limit is smaller than total", () => {
    for (let i = 0; i < 10; i++) {
      db.record("uniswap-base", "started", `event-${i}`);
    }
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({ name: "uniswap-base" }, { limit: "3" }), res);
    const body = res.body as HistoryResponse;
    expect(body.events.length).toBe(3);
    expect(body.events[0].message).toBe("event-7");
    expect(body.events[2].message).toBe("event-9");
  });

  it("handles missing name param", () => {
    const handler = getModuleStatusHistory({ historyDb: db });
    const res = makeRes();
    handler(makeReq({}), res);
    expect(res.statusCode).toBe(404);
  });
});
