import { describe, it, expect, beforeEach } from "vitest";
import { SubscriptionStore, getModuleSubscriptions } from "../moduleSubscriptions.js";

function makeReq(name: string) {
  return { params: { name } } as any;
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

describe("GET /api/modules/:name/subscriptions", () => {
  let store: SubscriptionStore;
  let now: number;

  beforeEach(() => {
    now = 1700000000000;
    store = new SubscriptionStore(() => now);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape", () => {
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("subscriptions");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.subscriptions)).toBe(true);
  });

  it("returns empty subscriptions when no data", () => {
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    expect(getBody().subscriptions).toHaveLength(0);
    expect(getBody().total).toBe(0);
  });

  it("returns subscription with correct fields", () => {
    store.recordMessage("binance", "feedeater.binance.trades");
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const sub = getBody().subscriptions[0];
    expect(sub).toHaveProperty("subject", "feedeater.binance.trades");
    expect(sub).toHaveProperty("status");
    expect(sub).toHaveProperty("messages_received");
    expect(sub).toHaveProperty("last_message_at");
  });

  it("tracks messages_received count", () => {
    store.recordMessage("bybit", "feedeater.bybit.trades");
    store.recordMessage("bybit", "feedeater.bybit.trades");
    store.recordMessage("bybit", "feedeater.bybit.trades");
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().subscriptions[0].messages_received).toBe(3);
  });

  it("status is active when recent message", () => {
    store.recordMessage("gemini", "feedeater.gemini.trades");
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().subscriptions[0].status).toBe("active");
  });

  it("status is stale when no messages received", () => {
    store.addSubscription("okx", "feedeater.okx.trades");
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    expect(getBody().subscriptions[0].status).toBe("stale");
    expect(getBody().subscriptions[0].last_message_at).toBeNull();
  });

  it("status is stale when message older than staleness threshold", () => {
    store.recordMessage("bitstamp", "feedeater.bitstamp.trades");
    now += 6 * 60 * 1000;
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    expect(getBody().subscriptions[0].status).toBe("stale");
  });

  it("last_message_at is valid ISO timestamp", () => {
    store.recordMessage("kalshi", "feedeater.kalshi.markets");
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    const ts = getBody().subscriptions[0].last_message_at;
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("last_message_at is null when no messages", () => {
    store.addSubscription("polymarket", "feedeater.polymarket.events");
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    expect(getBody().subscriptions[0].last_message_at).toBeNull();
  });

  it("total counts distinct subscriptions for module", () => {
    store.recordMessage("binance", "feedeater.binance.trades");
    store.recordMessage("binance", "feedeater.binance.orderbook");
    store.recordMessage("binance", "feedeater.binance.ticker");
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().total).toBe(3);
  });

  it("subscriptions are sorted alphabetically by subject", () => {
    store.recordMessage("coinbase", "feedeater.coinbase.ticker");
    store.recordMessage("coinbase", "feedeater.coinbase.book");
    store.recordMessage("coinbase", "feedeater.coinbase.trades");
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const subjects = getBody().subscriptions.map((s: any) => s.subject);
    const sorted = [...subjects].sort();
    expect(subjects).toEqual(sorted);
  });

  it("does not leak subscriptions between modules", () => {
    store.recordMessage("binance", "feedeater.binance.trades");
    store.recordMessage("coinbase", "feedeater.coinbase.trades");
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().total).toBe(1);
    expect(getBody().subscriptions[0].subject).toBe("feedeater.binance.trades");
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleSubscriptions({ subscriptionStore: store, nowFn: () => now });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});
