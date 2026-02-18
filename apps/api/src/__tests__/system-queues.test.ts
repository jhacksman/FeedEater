import { describe, it, expect, beforeEach } from "vitest";
import { QueueStatsStore, getSystemQueues } from "../systemQueues.js";

const NOW = new Date("2025-06-01T12:00:00.000Z").getTime();

function makeReq() {
  return {} as any;
}

function makeRes() {
  let body: any;
  const res = {
    json(data: any) { body = data; },
  } as any;
  return { res, getBody: () => body };
}

describe("GET /api/system/queues", () => {
  let store: QueueStatsStore;

  beforeEach(() => {
    store = new QueueStatsStore(() => NOW);
  });

  it("returns correct response shape with all fields", () => {
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("queues");
    expect(body).toHaveProperty("total_subjects");
    expect(body).toHaveProperty("total_rate");
    expect(body).toHaveProperty("timestamp");
    expect(Array.isArray(body.queues)).toBe(true);
  });

  it("returns empty queues when no data", () => {
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().queues).toHaveLength(0);
    expect(getBody().total_subjects).toBe(0);
    expect(getBody().total_rate).toBe(0);
  });

  it("returns queue entry with correct fields", () => {
    store.recordPublish("feedeater.binance.messageCreated", "binance");
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const q = getBody().queues[0];
    expect(q).toHaveProperty("subject", "feedeater.binance.messageCreated");
    expect(q).toHaveProperty("module", "binance");
    expect(q).toHaveProperty("messages_published", 1);
    expect(q).toHaveProperty("rate_per_sec");
    expect(q).toHaveProperty("last_published_at");
    expect(q).toHaveProperty("consumer_count");
  });

  it("tracks messages_published total", () => {
    store.recordPublish("feedeater.binance.messageCreated", "binance");
    store.recordPublish("feedeater.binance.messageCreated", "binance");
    store.recordPublish("feedeater.binance.messageCreated", "binance");
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().queues[0].messages_published).toBe(3);
  });

  it("computes rate_per_sec from last 60s", () => {
    for (let i = 0; i < 60; i++) {
      store.recordPublish("feedeater.coinbase.messageCreated", "coinbase");
    }
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().queues[0].rate_per_sec).toBe(1);
  });

  it("rate_per_sec excludes old messages", () => {
    const oldStore = new QueueStatsStore(() => NOW - 120_000);
    oldStore.recordPublish("feedeater.bybit.messageCreated", "bybit");
    const handler = getSystemQueues({ queueStore: oldStore, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().queues[0].rate_per_sec).toBe(0);
    expect(getBody().queues[0].messages_published).toBe(1);
  });

  it("last_published_at is valid ISO timestamp", () => {
    store.recordPublish("feedeater.gemini.messageCreated", "gemini");
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const ts = getBody().queues[0].last_published_at;
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("consumer_count defaults to 0", () => {
    store.recordPublish("feedeater.okx.messageCreated", "okx");
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().queues[0].consumer_count).toBe(0);
  });

  it("consumer_count reflects setConsumerCount", () => {
    store.recordPublish("feedeater.bitstamp.messageCreated", "bitstamp");
    store.setConsumerCount("feedeater.bitstamp.messageCreated", 3);
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().queues[0].consumer_count).toBe(3);
  });

  it("total_subjects counts distinct subjects", () => {
    store.recordPublish("feedeater.binance.messageCreated", "binance");
    store.recordPublish("feedeater.coinbase.messageCreated", "coinbase");
    store.recordPublish("feedeater.bybit.messageCreated", "bybit");
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total_subjects).toBe(3);
  });

  it("total_rate sums rate_per_sec across all subjects", () => {
    for (let i = 0; i < 30; i++) {
      store.recordPublish("feedeater.binance.messageCreated", "binance");
    }
    for (let i = 0; i < 30; i++) {
      store.recordPublish("feedeater.coinbase.messageCreated", "coinbase");
    }
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total_rate).toBe(1);
  });

  it("queues are sorted alphabetically by subject", () => {
    store.recordPublish("feedeater.okx.messageCreated", "okx");
    store.recordPublish("feedeater.binance.messageCreated", "binance");
    store.recordPublish("feedeater.coinbase.messageCreated", "coinbase");
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const subjects = getBody().queues.map((q: any) => q.subject);
    const sorted = [...subjects].sort();
    expect(subjects).toEqual(sorted);
  });

  it("timestamp is valid ISO string", () => {
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().timestamp).toBe("2025-06-01T12:00:00.000Z");
  });

  it("all numeric fields are numbers", () => {
    store.recordPublish("feedeater.kalshi.messageCreated", "kalshi");
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(typeof body.total_subjects).toBe("number");
    expect(typeof body.total_rate).toBe("number");
    const q = body.queues[0];
    expect(typeof q.messages_published).toBe("number");
    expect(typeof q.rate_per_sec).toBe("number");
    expect(typeof q.consumer_count).toBe("number");
  });

  it("handles multiple publishes to same subject", () => {
    for (let i = 0; i < 100; i++) {
      store.recordPublish("feedeater.polymarket.messageCreated", "polymarket");
    }
    const handler = getSystemQueues({ queueStore: store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().queues).toHaveLength(1);
    expect(getBody().queues[0].messages_published).toBe(100);
    expect(getBody().total_subjects).toBe(1);
  });
});
