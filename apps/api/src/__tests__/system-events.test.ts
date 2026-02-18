import { describe, it, expect, beforeEach } from "vitest";
import { SystemEventStore, getSystemEvents } from "../systemEvents.js";

function makeReq(query: Record<string, string> = {}) {
  return { query } as any;
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

describe("SystemEventStore", () => {
  let store: SystemEventStore;

  beforeEach(() => {
    store = new SystemEventStore();
  });

  it("starts empty", () => {
    expect(store.all()).toEqual([]);
  });

  it("records an event with all fields", () => {
    const ev = store.record("start", "Module binance started", "info", "binance");
    expect(ev.type).toBe("start");
    expect(ev.message).toBe("Module binance started");
    expect(ev.severity).toBe("info");
    expect(ev.module).toBe("binance");
    expect(ev.timestamp).toBeDefined();
  });

  it("module defaults to null for system-wide events", () => {
    const ev = store.record("error", "System OOM", "error");
    expect(ev.module).toBeNull();
  });

  it("recordWithTimestamp uses provided timestamp", () => {
    const ev = store.recordWithTimestamp("restart", "restarted", "warn", "2026-01-15T00:00:00Z", "okx");
    expect(ev.timestamp).toBe("2026-01-15T00:00:00Z");
  });

  it("caps at 1000 events", () => {
    for (let i = 0; i < 1050; i++) {
      store.record("start", `event-${i}`, "info");
    }
    expect(store.all().length).toBe(1000);
    expect(store.all()[0].message).toBe("event-50");
  });

  it("clear removes all events", () => {
    store.record("start", "a", "info");
    store.record("stop", "b", "info");
    store.clear();
    expect(store.all()).toEqual([]);
  });
});

describe("GET /api/system/events handler", () => {
  let store: SystemEventStore;

  beforeEach(() => {
    store = new SystemEventStore();
  });

  it("returns empty list when no events", () => {
    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().events).toEqual([]);
    expect(getBody().total).toBe(0);
    expect(getBody().limit).toBe(100);
  });

  it("returns events sorted newest first", () => {
    store.recordWithTimestamp("start", "first", "info", "2026-01-01T00:00:00Z");
    store.recordWithTimestamp("stop", "second", "info", "2026-01-03T00:00:00Z");
    store.recordWithTimestamp("error", "third", "error", "2026-01-02T00:00:00Z");

    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);

    const events = getBody().events;
    expect(events.length).toBe(3);
    expect(events[0].message).toBe("second");
    expect(events[1].message).toBe("third");
    expect(events[2].message).toBe("first");
  });

  it("respects limit param", () => {
    store.recordWithTimestamp("start", "a", "info", "2026-01-01T00:00:00Z");
    store.recordWithTimestamp("stop", "b", "info", "2026-01-02T00:00:00Z");
    store.recordWithTimestamp("restart", "c", "warn", "2026-01-03T00:00:00Z");

    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ limit: "2" }), res);

    expect(getBody().events.length).toBe(2);
    expect(getBody().total).toBe(3);
    expect(getBody().limit).toBe(2);
  });

  it("clamps limit to max 500", () => {
    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ limit: "9999" }), res);
    expect(getBody().limit).toBe(500);
  });

  it("defaults limit to 100 for non-numeric input", () => {
    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ limit: "abc" }), res);
    expect(getBody().limit).toBe(100);
  });

  it("filters by type=start", () => {
    store.record("start", "started", "info", "binance");
    store.record("stop", "stopped", "info", "binance");
    store.record("start", "started again", "info", "coinbase");

    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "start" }), res);

    expect(getBody().events.length).toBe(2);
    expect(getBody().total).toBe(2);
    getBody().events.forEach((e: any) => expect(e.type).toBe("start"));
  });

  it("filters by type=error", () => {
    store.record("error", "OOM", "error");
    store.record("start", "started", "info", "okx");
    store.record("error", "timeout", "error", "bybit");

    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "error" }), res);

    expect(getBody().events.length).toBe(2);
    getBody().events.forEach((e: any) => expect(e.type).toBe("error"));
  });

  it("filters by type=config_change", () => {
    store.record("config_change", "updated threshold", "info", "binance");
    store.record("start", "started", "info");

    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "config_change" }), res);

    expect(getBody().events.length).toBe(1);
    expect(getBody().events[0].type).toBe("config_change");
  });

  it("ignores invalid type filter and returns all events", () => {
    store.record("start", "a", "info");
    store.record("stop", "b", "info");

    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "invalid_type" }), res);

    expect(getBody().events.length).toBe(2);
  });

  it("combines limit and type filter", () => {
    store.recordWithTimestamp("error", "e1", "error", "2026-01-01T00:00:00Z");
    store.recordWithTimestamp("error", "e2", "error", "2026-01-02T00:00:00Z");
    store.recordWithTimestamp("error", "e3", "error", "2026-01-03T00:00:00Z");
    store.recordWithTimestamp("start", "s1", "info", "2026-01-04T00:00:00Z");

    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "error", limit: "2" }), res);

    expect(getBody().events.length).toBe(2);
    expect(getBody().total).toBe(3);
    expect(getBody().events[0].message).toBe("e3");
    expect(getBody().events[1].message).toBe("e2");
  });

  it("includes all required fields per event", () => {
    store.record("restart", "restarted", "warn", "gemini");

    const handler = getSystemEvents({ eventStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);

    const ev = getBody().events[0];
    expect(ev).toHaveProperty("timestamp");
    expect(ev).toHaveProperty("type");
    expect(ev).toHaveProperty("module");
    expect(ev).toHaveProperty("message");
    expect(ev).toHaveProperty("severity");
  });
});
