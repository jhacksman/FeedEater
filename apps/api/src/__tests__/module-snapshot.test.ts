import { describe, it, expect, beforeEach } from "vitest";
import { SnapshotStore, getModuleSnapshot } from "../moduleSnapshot.js";

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

describe("GET /api/modules/:name/snapshot", () => {
  let store: SnapshotStore;
  let tick: number;

  beforeEach(() => {
    tick = 1000;
    store = new SnapshotStore(() => tick++);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape with no messages", () => {
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("subject", "feedeater.binance.messageCreated");
    expect(body).toHaveProperty("snapshot_at");
    expect(body).toHaveProperty("count", 0);
    expect(body).toHaveProperty("messages");
    expect(body.messages).toEqual([]);
  });

  it("returns recorded messages", () => {
    store.record("coinbase", "feedeater.coinbase.messageCreated", { price: 100 });
    store.record("coinbase", "feedeater.coinbase.messageCreated", { price: 101 });
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.count).toBe(2);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toHaveProperty("timestamp");
    expect(body.messages[0]).toHaveProperty("data");
    expect(body.messages[0].data).toEqual({ price: 100 });
    expect(body.messages[1].data).toEqual({ price: 101 });
  });

  it("defaults to 10 messages", () => {
    for (let i = 0; i < 15; i++) {
      store.record("bybit", "feedeater.bybit.messageCreated", { i });
    }
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().count).toBe(10);
    expect(getBody().messages).toHaveLength(10);
    expect(getBody().messages[0].data.i).toBe(5);
  });

  it("respects limit query parameter", () => {
    for (let i = 0; i < 10; i++) {
      store.record("gemini", "feedeater.gemini.messageCreated", { i });
    }
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini", { limit: "3" }), res);
    expect(getBody().count).toBe(3);
    expect(getBody().messages).toHaveLength(3);
    expect(getBody().messages[0].data.i).toBe(7);
  });

  it("clamps limit to max 100", () => {
    for (let i = 0; i < 5; i++) {
      store.record("okx", "feedeater.okx.messageCreated", { i });
    }
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("okx", { limit: "200" }), res);
    expect(getBody().count).toBe(5);
  });

  it("returns 400 for invalid limit", () => {
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res: r1, getStatus: gs1 } = makeRes();
    handler(makeReq("binance", { limit: "abc" }), r1);
    expect(gs1()).toBe(400);

    const { res: r2, getStatus: gs2 } = makeRes();
    handler(makeReq("binance", { limit: "0" }), r2);
    expect(gs2()).toBe(400);

    const { res: r3, getStatus: gs3 } = makeRes();
    handler(makeReq("binance", { limit: "-5" }), r3);
    expect(gs3()).toBe(400);

    const { res: r4, getStatus: gs4 } = makeRes();
    handler(makeReq("binance", { limit: "2.5" }), r4);
    expect(gs4()).toBe(400);
  });

  it("modules are isolated", () => {
    store.record("binance", "feedeater.binance.messageCreated", { a: 1 });
    store.record("coinbase", "feedeater.coinbase.messageCreated", { b: 2 });
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res: r1, getBody: gb1 } = makeRes();
    handler(makeReq("binance"), r1);
    expect(gb1().count).toBe(1);
    expect(gb1().messages[0].data).toEqual({ a: 1 });

    const { res: r2, getBody: gb2 } = makeRes();
    handler(makeReq("coinbase"), r2);
    expect(gb2().count).toBe(1);
    expect(gb2().messages[0].data).toEqual({ b: 2 });
  });

  it("buffer caps at 100 messages", () => {
    for (let i = 0; i < 120; i++) {
      store.record("bitstamp", "feedeater.bitstamp.messageCreated", { i });
    }
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp", { limit: "100" }), res);
    expect(getBody().count).toBe(100);
    expect(getBody().messages[0].data.i).toBe(20);
  });

  it("snapshot_at is ISO string", () => {
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 1700000000000 });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    expect(getBody().snapshot_at).toBe(new Date(1700000000000).toISOString());
  });

  it("message timestamps are ISO strings", () => {
    store.record("polymarket", "feedeater.polymarket.messageCreated", { x: 1 });
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    const ts = getBody().messages[0].timestamp;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });

  it("returns most recent messages when buffer is full", () => {
    for (let i = 0; i < 50; i++) {
      store.record("aerodrome-base", "feedeater.aerodrome-base.messageCreated", { seq: i });
    }
    const handler = getModuleSnapshot({ snapshotStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("aerodrome-base", { limit: "5" }), res);
    expect(getBody().count).toBe(5);
    expect(getBody().messages[0].data.seq).toBe(45);
    expect(getBody().messages[4].data.seq).toBe(49);
  });
});
