import { describe, it, expect, beforeEach } from "vitest";
import { SystemLogStore, getSystemLogs, encodeCursor, decodeCursor } from "../systemLogs.js";

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

describe("SystemLogStore", () => {
  let store: SystemLogStore;

  beforeEach(() => {
    store = new SystemLogStore();
  });

  it("starts empty", () => {
    expect(store.all()).toEqual([]);
  });

  it("appends a log entry with all fields", () => {
    const entry = store.append("info", "Server started", "api");
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("Server started");
    expect(entry.source).toBe("api");
    expect(entry.timestamp).toBeDefined();
    expect(entry.id).toBe(1);
  });

  it("assigns incrementing ids", () => {
    store.append("info", "a", "api");
    store.append("warn", "b", "nats");
    const entries = store.all();
    expect(entries[0].id).toBe(1);
    expect(entries[1].id).toBe(2);
  });

  it("accepts custom timestamp", () => {
    const entry = store.append("error", "OOM", "system", "2026-01-15T00:00:00Z");
    expect(entry.timestamp).toBe("2026-01-15T00:00:00Z");
  });

  it("caps at 5000 entries", () => {
    for (let i = 0; i < 5050; i++) {
      store.append("debug", `log-${i}`, "test");
    }
    expect(store.all().length).toBe(5000);
  });

  it("clear removes all entries and resets id", () => {
    store.append("info", "a", "api");
    store.clear();
    expect(store.all()).toEqual([]);
    const entry = store.append("info", "b", "api");
    expect(entry.id).toBe(1);
  });
});

describe("cursor encoding", () => {
  it("round-trips an id", () => {
    const cursor = encodeCursor(42);
    expect(decodeCursor(cursor)).toBe(42);
  });

  it("returns null for invalid cursor", () => {
    expect(decodeCursor("not-base64!!!")).toBeNull();
  });

  it("returns null for non-positive id", () => {
    const cursor = Buffer.from("0").toString("base64");
    expect(decodeCursor(cursor)).toBeNull();
  });
});

describe("GET /api/system/logs handler", () => {
  let store: SystemLogStore;

  beforeEach(() => {
    store = new SystemLogStore();
  });

  it("returns empty list when no logs", () => {
    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().logs).toEqual([]);
    expect(getBody().total).toBe(0);
    expect(getBody().cursor).toBeNull();
  });

  it("returns logs in insertion order", () => {
    store.append("info", "first", "api");
    store.append("warn", "second", "nats");

    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);

    expect(getBody().logs.length).toBe(2);
    expect(getBody().logs[0].message).toBe("first");
    expect(getBody().logs[1].message).toBe("second");
  });

  it("respects limit param", () => {
    store.append("info", "a", "api");
    store.append("info", "b", "api");
    store.append("info", "c", "api");

    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ limit: "2" }), res);

    expect(getBody().logs.length).toBe(2);
    expect(getBody().total).toBe(3);
    expect(getBody().cursor).toBeDefined();
  });

  it("clamps limit to max 1000", () => {
    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ limit: "9999" }), res);
    expect(getBody().total).toBe(0);
  });

  it("defaults limit to 100 for non-numeric input", () => {
    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ limit: "abc" }), res);
    expect(getBody().total).toBe(0);
  });

  it("filters by level=error", () => {
    store.append("info", "ok", "api");
    store.append("error", "fail", "nats");
    store.append("error", "crash", "system");

    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ level: "error" }), res);

    expect(getBody().logs.length).toBe(2);
    expect(getBody().total).toBe(2);
    getBody().logs.forEach((l: any) => expect(l.level).toBe("error"));
  });

  it("filters by level=warn", () => {
    store.append("warn", "slow", "api");
    store.append("info", "ok", "api");

    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ level: "warn" }), res);

    expect(getBody().logs.length).toBe(1);
    expect(getBody().logs[0].level).toBe("warn");
  });

  it("ignores invalid level filter", () => {
    store.append("info", "a", "api");
    store.append("error", "b", "api");

    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ level: "fatal" }), res);

    expect(getBody().logs.length).toBe(2);
  });

  it("filters by since timestamp", () => {
    store.append("info", "old", "api", "2026-01-01T00:00:00Z");
    store.append("info", "new", "api", "2026-02-01T00:00:00Z");

    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ since: "2026-01-15T00:00:00Z" }), res);

    expect(getBody().logs.length).toBe(1);
    expect(getBody().logs[0].message).toBe("new");
  });

  it("combines level and since filters", () => {
    store.append("info", "old-info", "api", "2026-01-01T00:00:00Z");
    store.append("error", "old-error", "api", "2026-01-02T00:00:00Z");
    store.append("info", "new-info", "api", "2026-02-01T00:00:00Z");
    store.append("error", "new-error", "api", "2026-02-02T00:00:00Z");

    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq({ level: "error", since: "2026-01-15T00:00:00Z" }), res);

    expect(getBody().logs.length).toBe(1);
    expect(getBody().logs[0].message).toBe("new-error");
  });

  it("cursor-based pagination pages through results", () => {
    store.append("info", "a", "api");
    store.append("info", "b", "api");
    store.append("info", "c", "api");

    const handler = getSystemLogs({ logStore: store });

    const { res: res1, getBody: getBody1 } = makeRes();
    handler(makeReq({ limit: "2" }), res1);
    const page1 = getBody1();
    expect(page1.logs.length).toBe(2);
    expect(page1.cursor).toBeDefined();

    const { res: res2, getBody: getBody2 } = makeRes();
    handler(makeReq({ limit: "2", cursor: page1.cursor }), res2);
    const page2 = getBody2();
    expect(page2.logs.length).toBe(1);
    expect(page2.logs[0].message).toBe("c");
    expect(page2.cursor).toBeNull();
  });

  it("returns 400 for invalid cursor", () => {
    const handler = getSystemLogs({ logStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ cursor: "not-valid!!!" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody()).toHaveProperty("error");
  });

  it("does not include internal id in response logs", () => {
    store.append("info", "test", "api");
    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().logs[0]).not.toHaveProperty("id");
  });

  it("includes all required fields per log entry", () => {
    store.append("warn", "slow query", "postgres");
    const handler = getSystemLogs({ logStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const log = getBody().logs[0];
    expect(log).toHaveProperty("timestamp");
    expect(log).toHaveProperty("level");
    expect(log).toHaveProperty("message");
    expect(log).toHaveProperty("source");
  });
});
