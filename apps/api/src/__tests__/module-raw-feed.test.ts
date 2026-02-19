import { describe, it, expect, beforeEach } from "vitest";
import { RawFeedStore, getModuleRawFeed } from "../moduleRawFeed.js";

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

describe("GET /api/modules/:name/raw-feed", () => {
  let store: RawFeedStore;
  let tick: number;

  beforeEach(() => {
    tick = 1000;
    store = new RawFeedStore(() => tick++);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape with no messages", () => {
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("messages");
    expect(body.messages).toEqual([]);
    expect(body).toHaveProperty("total", 0);
  });

  it("returns recorded messages with correct fields", () => {
    store.record("coinbase", { price: 100, pair: "BTC-USD" });
    store.record("coinbase", { price: 101, pair: "BTC-USD" });
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.total).toBe(2);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toHaveProperty("received_at");
    expect(body.messages[0]).toHaveProperty("raw_data");
    expect(body.messages[0]).toHaveProperty("size_bytes");
    expect(body.messages[0].raw_data).toEqual({ price: 100, pair: "BTC-USD" });
    expect(body.messages[1].raw_data).toEqual({ price: 101, pair: "BTC-USD" });
  });

  it("defaults to 50 messages", () => {
    for (let i = 0; i < 70; i++) {
      store.record("bybit", { i });
    }
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().messages).toHaveLength(50);
    expect(getBody().messages[0].raw_data.i).toBe(20);
  });

  it("respects limit query parameter", () => {
    for (let i = 0; i < 20; i++) {
      store.record("gemini", { i });
    }
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini", { limit: "5" }), res);
    expect(getBody().messages).toHaveLength(5);
    expect(getBody().messages[0].raw_data.i).toBe(15);
  });

  it("clamps limit to max 500", () => {
    for (let i = 0; i < 10; i++) {
      store.record("okx", { i });
    }
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("okx", { limit: "999" }), res);
    expect(getBody().messages).toHaveLength(10);
  });

  it("returns 400 for invalid limit", () => {
    const handler = getModuleRawFeed({ rawFeedStore: store });

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

  it("filters by since timestamp", () => {
    tick = 1000;
    store.record("kalshi", { a: 1 });
    tick = 2000;
    store.record("kalshi", { b: 2 });
    tick = 3000;
    store.record("kalshi", { c: 3 });

    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi", { since: new Date(2000).toISOString() }), res);
    const body = getBody();
    expect(body.messages).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.messages[0].raw_data).toEqual({ b: 2 });
    expect(body.messages[1].raw_data).toEqual({ c: 3 });
  });

  it("returns 400 for invalid since timestamp", () => {
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", { since: "not-a-date" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toMatch(/since/);
  });

  it("received_at is ISO string", () => {
    tick = 1700000000000;
    store.record("polymarket", { x: 1 });
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    expect(getBody().messages[0].received_at).toBe(new Date(1700000000000).toISOString());
  });

  it("size_bytes reflects raw_data serialized size", () => {
    const data = { key: "value" };
    store.record("bitstamp", data);
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    const expectedSize = Buffer.byteLength(JSON.stringify(data), "utf8");
    expect(getBody().messages[0].size_bytes).toBe(expectedSize);
  });

  it("modules are isolated", () => {
    store.record("binance", { a: 1 });
    store.record("coinbase", { b: 2 });
    const handler = getModuleRawFeed({ rawFeedStore: store });

    const { res: r1, getBody: gb1 } = makeRes();
    handler(makeReq("binance"), r1);
    expect(gb1().total).toBe(1);
    expect(gb1().messages[0].raw_data).toEqual({ a: 1 });

    const { res: r2, getBody: gb2 } = makeRes();
    handler(makeReq("coinbase"), r2);
    expect(gb2().total).toBe(1);
    expect(gb2().messages[0].raw_data).toEqual({ b: 2 });
  });

  it("buffer caps at 500 messages", () => {
    for (let i = 0; i < 550; i++) {
      store.record("aerodrome-base", { i });
    }
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("aerodrome-base", { limit: "500" }), res);
    expect(getBody().messages).toHaveLength(500);
    expect(getBody().messages[0].raw_data.i).toBe(50);
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleRawFeed({ rawFeedStore: store });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });

  it("returns most recent messages when buffer is full", () => {
    for (let i = 0; i < 100; i++) {
      store.record("uniswap-base", { seq: i });
    }
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("uniswap-base", { limit: "5" }), res);
    expect(getBody().messages).toHaveLength(5);
    expect(getBody().messages[0].raw_data.seq).toBe(95);
    expect(getBody().messages[4].raw_data.seq).toBe(99);
  });

  it("since with limit works together", () => {
    tick = 1000;
    for (let i = 0; i < 10; i++) {
      tick = 1000 + i * 1000;
      store.record("gemini", { i });
    }
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini", { since: new Date(5000).toISOString(), limit: "3" }), res);
    const body = getBody();
    expect(body.total).toBe(6);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].raw_data.i).toBe(7);
  });

  it("total reflects count before limit is applied", () => {
    for (let i = 0; i < 20; i++) {
      store.record("okx", { i });
    }
    const handler = getModuleRawFeed({ rawFeedStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("okx", { limit: "5" }), res);
    expect(getBody().total).toBe(20);
    expect(getBody().messages).toHaveLength(5);
  });
});
