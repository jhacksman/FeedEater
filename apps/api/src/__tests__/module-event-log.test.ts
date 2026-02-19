import { describe, it, expect, beforeEach } from "vitest";
import { EventLogStore, getModuleEventLog } from "../moduleEventLog.js";

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

describe("GET /api/modules/:name/event-log", () => {
  let store: EventLogStore;
  let tick: number;

  beforeEach(() => {
    tick = 1700000000000;
    store = new EventLogStore(() => tick);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns empty events when none recorded", () => {
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody()).toEqual({ module: "binance", events: [], total: 0 });
  });

  it("returns events with correct shape", () => {
    store.record("coinbase", "connect", "WebSocket connected", { url: "wss://example.com" });
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const ev = getBody().events[0];
    expect(ev.type).toBe("connect");
    expect(ev.message).toBe("WebSocket connected");
    expect(ev.occurred_at).toBe(new Date(1700000000000).toISOString());
    expect(ev.metadata).toEqual({ url: "wss://example.com" });
  });

  it("occurred_at is ISO format", () => {
    store.record("bybit", "error", "timeout");
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().events[0].occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("defaults metadata to empty object", () => {
    store.record("gemini", "restart", "Module restarted");
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().events[0].metadata).toEqual({});
  });

  it("defaults limit to 50", () => {
    for (let i = 0; i < 60; i++) {
      tick = 1700000000000 + i * 1000;
      store.record("okx", "connect", `Event ${i}`);
    }
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    expect(getBody().events.length).toBe(50);
    expect(getBody().total).toBe(60);
  });

  it("respects custom limit", () => {
    for (let i = 0; i < 10; i++) {
      store.record("bitstamp", "connect", `Event ${i}`);
    }
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp", { limit: "3" }), res);
    expect(getBody().events.length).toBe(3);
  });

  it("caps limit at 500", () => {
    for (let i = 0; i < 5; i++) {
      store.record("kalshi", "connect", `Event ${i}`);
    }
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi", { limit: "9999" }), res);
    expect(getBody().events.length).toBe(5);
  });

  it("returns 400 for invalid limit", () => {
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", { limit: "abc" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("limit");
  });

  it("filters by type", () => {
    store.record("binance", "connect", "Connected");
    store.record("binance", "error", "Failed");
    store.record("binance", "disconnect", "Disconnected");
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance", { type: "error" }), res);
    expect(getBody().events.length).toBe(1);
    expect(getBody().events[0].type).toBe("error");
    expect(getBody().total).toBe(1);
  });

  it("returns 400 for invalid type filter", () => {
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", { type: "invalid" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("Invalid type");
  });

  it("accepts all valid type filters", () => {
    const types = ["connect", "disconnect", "error", "restart", "config"] as const;
    for (const t of types) {
      store.record("coinbase", t, `${t} event`);
    }
    const handler = getModuleEventLog({ eventLogStore: store });
    for (const t of types) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq("coinbase", { type: t }), res);
      expect(getStatus()).toBe(200);
      expect(getBody().events.length).toBe(1);
      expect(getBody().events[0].type).toBe(t);
    }
  });

  it("filters by since timestamp", () => {
    tick = 1000;
    store.record("bybit", "connect", "Old event");
    tick = 3000;
    store.record("bybit", "error", "New event");
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit", { since: new Date(2000).toISOString() }), res);
    expect(getBody().events.length).toBe(1);
    expect(getBody().events[0].message).toBe("New event");
    expect(getBody().total).toBe(1);
  });

  it("returns 400 for invalid since", () => {
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", { since: "not-a-date" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("since");
  });

  it("combines type and since filters", () => {
    tick = 1000;
    store.record("gemini", "connect", "Old connect");
    store.record("gemini", "error", "Old error");
    tick = 3000;
    store.record("gemini", "connect", "New connect");
    store.record("gemini", "error", "New error");
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini", { type: "error", since: new Date(2000).toISOString() }), res);
    expect(getBody().events.length).toBe(1);
    expect(getBody().events[0].message).toBe("New error");
  });

  it("modules are isolated", () => {
    store.record("binance", "connect", "Binance event");
    store.record("coinbase", "error", "Coinbase event");
    const handler = getModuleEventLog({ eventLogStore: store });

    const { res: r1, getBody: gb1 } = makeRes();
    handler(makeReq("binance"), r1);
    expect(gb1().events.length).toBe(1);
    expect(gb1().events[0].message).toBe("Binance event");

    const { res: r2, getBody: gb2 } = makeRes();
    handler(makeReq("coinbase"), r2);
    expect(gb2().events.length).toBe(1);
    expect(gb2().events[0].message).toBe("Coinbase event");
  });

  it("returns most recent events when over limit", () => {
    for (let i = 0; i < 10; i++) {
      tick = 1700000000000 + i * 1000;
      store.record("okx", "connect", `Event ${i}`);
    }
    const handler = getModuleEventLog({ eventLogStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("okx", { limit: "3" }), res);
    const events = getBody().events;
    expect(events[0].message).toBe("Event 7");
    expect(events[2].message).toBe("Event 9");
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleEventLog({ eventLogStore: store });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});
