import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { StatusHistoryDb } from "../moduleStatusHistory.js";
import { getModuleEvents } from "../moduleEvents.js";

function makeReq(name: string, query: Record<string, string> = {}) {
  return { params: { name }, query } as any;
}

function makeRes() {
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: any) { body = data; },
  } as any;
  return { res, getStatus: () => statusCode, getBody: () => body };
}

const DB_PATH = "test-module-events.db";

describe("GET /api/modules/:name/events", () => {
  let db: StatusHistoryDb;

  beforeEach(() => {
    try { unlinkSync(DB_PATH); } catch {}
    db = new StatusHistoryDb(DB_PATH);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(DB_PATH); } catch {}
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleEvents({ historyDb: db });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("unknown-xyz"), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("returns 400 for invalid limit", () => {
    const handler = getModuleEvents({ historyDb: db });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", { limit: "abc" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("limit");
  });

  it("returns correct response shape with no events", () => {
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("events");
    expect(body).toHaveProperty("total_events", 0);
    expect(body).toHaveProperty("returned", 0);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("returns events with correct fields", () => {
    db.record("binance", "started", "Module started");
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const ev = getBody().events[0];
    expect(ev).toHaveProperty("id");
    expect(ev).toHaveProperty("event_type", "started");
    expect(ev).toHaveProperty("severity", "info");
    expect(ev).toHaveProperty("timestamp");
    expect(ev).toHaveProperty("message", "Module started");
    expect(ev).toHaveProperty("details");
  });

  it("maps severity correctly for each event type", () => {
    db.record("binance", "started", "s");
    db.record("binance", "stopped", "s");
    db.record("binance", "error", "e");
    db.record("binance", "reconnected", "r");
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const events = getBody().events;
    const sevMap: Record<string, string> = {};
    for (const e of events) sevMap[e.event_type] = e.severity;
    expect(sevMap["started"]).toBe("info");
    expect(sevMap["stopped"]).toBe("warning");
    expect(sevMap["error"]).toBe("error");
    expect(sevMap["reconnected"]).toBe("warning");
  });

  it("defaults to 20 events", () => {
    for (let i = 0; i < 30; i++) {
      db.record("coinbase", "started", `Event ${i}`);
    }
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    expect(getBody().returned).toBe(20);
    expect(getBody().total_events).toBe(30);
  });

  it("respects custom limit query param", () => {
    for (let i = 0; i < 10; i++) {
      db.record("bybit", "started", `Event ${i}`);
    }
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit", { limit: "5" }), res);
    expect(getBody().returned).toBe(5);
  });

  it("caps limit at 200", () => {
    for (let i = 0; i < 5; i++) {
      db.record("gemini", "started", `Event ${i}`);
    }
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini", { limit: "9999" }), res);
    expect(getBody().returned).toBe(5);
  });

  it("returns events in chronological order", () => {
    db.record("okx", "started", "First");
    db.record("okx", "error", "Second");
    db.record("okx", "reconnected", "Third");
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    const events = getBody().events;
    expect(events[0].message).toBe("First");
    expect(events[2].message).toBe("Third");
  });

  it("does not return events from other modules", () => {
    db.record("binance", "started", "Binance event");
    db.record("coinbase", "started", "Coinbase event");
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().returned).toBe(1);
    expect(getBody().events[0].message).toBe("Binance event");
  });

  it("parses details JSON when present", () => {
    db.record("kalshi", "error", "Connection failed", { reason: "timeout", code: 504 });
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    const ev = getBody().events[0];
    expect(ev.details).toEqual({ reason: "timeout", code: 504 });
  });

  it("details is null when not provided", () => {
    db.record("polymarket", "started", "Started");
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    expect(getBody().events[0].details).toBeNull();
  });

  it("timestamp is valid ISO format", () => {
    db.record("binance", "started", "Test");
    const handler = getModuleEvents({ historyDb: db });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const ts = getBody().events[0].timestamp;
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});
