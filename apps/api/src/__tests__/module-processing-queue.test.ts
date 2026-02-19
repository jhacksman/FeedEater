import { describe, it, expect, beforeEach } from "vitest";
import { ProcessingQueueStore, getModuleProcessingQueue } from "../moduleProcessingQueue.js";

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

describe("GET /api/modules/:name/processing-queue", () => {
  let store: ProcessingQueueStore;
  let tick: number;

  beforeEach(() => {
    tick = 1700000000000;
    store = new ProcessingQueueStore(() => tick);
  });

  function handler() {
    return getModuleProcessingQueue({ queueStore: store, nowFn: () => tick });
  }

  it("returns 404 for unknown module", () => {
    const { res, getStatus, getBody } = makeRes();
    handler()(makeReq("nonexistent"), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", () => {
    const { res, getStatus, getBody } = makeRes();
    handler()(makeReq(""), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("returns zero state when no queue data exists", () => {
    const { res, getStatus, getBody } = makeRes();
    handler()(makeReq("binance"), res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      module: "binance",
      queue_depth: 0,
      oldest_queued_at: null,
      lag_seconds: 0,
      processing_rate_per_sec: 0,
      dropped_messages_count: 0,
    });
  });

  it("returns correct queue_depth after enqueue", () => {
    store.enqueue("binance", 5);
    store.enqueue("binance", 3);
    const { res, getBody } = makeRes();
    handler()(makeReq("binance"), res);
    expect(getBody().queue_depth).toBe(8);
  });

  it("returns oldest_queued_at as ISO timestamp", () => {
    const enqueueTime = tick - 10000;
    tick = enqueueTime;
    store.enqueue("coinbase", 2);
    tick = 1700000000000;
    const { res, getBody } = makeRes();
    handler()(makeReq("coinbase"), res);
    expect(getBody().oldest_queued_at).toBe(new Date(enqueueTime).toISOString());
  });

  it("computes lag_seconds from oldest entry to now", () => {
    tick = 1700000000000 - 30000;
    store.enqueue("bybit", 1);
    tick = 1700000000000;
    const { res, getBody } = makeRes();
    handler()(makeReq("bybit"), res);
    expect(getBody().lag_seconds).toBe(30);
  });

  it("returns processing_rate_per_sec within 60s window", () => {
    tick = 1700000000000 - 30000;
    store.enqueue("gemini", 60);
    tick = 1700000000000;
    const { res, getBody } = makeRes();
    handler()(makeReq("gemini"), res);
    expect(getBody().processing_rate_per_sec).toBe(1);
  });

  it("tracks dropped_messages_count", () => {
    store.recordDropped("okx", 5);
    store.recordDropped("okx", 3);
    const { res, getBody } = makeRes();
    handler()(makeReq("okx"), res);
    expect(getBody().dropped_messages_count).toBe(8);
  });

  it("returns dropped count even when queue is empty", () => {
    store.recordDropped("bitstamp", 10);
    const { res, getBody } = makeRes();
    handler()(makeReq("bitstamp"), res);
    expect(getBody().queue_depth).toBe(0);
    expect(getBody().dropped_messages_count).toBe(10);
  });

  it("dequeue reduces queue_depth", () => {
    store.enqueue("binance", 10);
    store.dequeue("binance", 4);
    const { res, getBody } = makeRes();
    handler()(makeReq("binance"), res);
    expect(getBody().queue_depth).toBe(6);
  });

  it("dequeue removes oldest entries first", () => {
    tick = 1700000000000 - 20000;
    store.enqueue("kalshi", 3);
    tick = 1700000000000 - 10000;
    store.enqueue("kalshi", 5);
    tick = 1700000000000;
    store.dequeue("kalshi", 3);
    const { res, getBody } = makeRes();
    handler()(makeReq("kalshi"), res);
    expect(getBody().queue_depth).toBe(5);
    expect(getBody().oldest_queued_at).toBe(new Date(1700000000000 - 10000).toISOString());
  });

  it("full dequeue returns zero state", () => {
    store.enqueue("polymarket", 5);
    store.dequeue("polymarket", 5);
    const { res, getBody } = makeRes();
    handler()(makeReq("polymarket"), res);
    expect(getBody().queue_depth).toBe(0);
    expect(getBody().lag_seconds).toBe(0);
    expect(getBody().oldest_queued_at).toBeNull();
  });

  it("isolates data between modules", () => {
    store.enqueue("binance", 10);
    store.recordDropped("binance", 2);
    const { res, getBody } = makeRes();
    handler()(makeReq("coinbase"), res);
    expect(getBody().queue_depth).toBe(0);
    expect(getBody().dropped_messages_count).toBe(0);
  });

  it("works for all known modules", () => {
    const modules = [
      "binance", "coinbase", "bybit", "gemini", "bitstamp",
      "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base",
    ];
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler()(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });

  it("evicts old entries when store exceeds 100k", () => {
    for (let i = 0; i < 100_001; i++) {
      store.enqueue("binance", 1);
    }
    expect(store.getDepth("binance")).toBe(100_000);
  });

  it("excludes entries outside 60s window from processing rate", () => {
    tick = 1700000000000 - 120000;
    store.enqueue("binance", 100);
    tick = 1700000000000 - 30000;
    store.enqueue("binance", 60);
    tick = 1700000000000;
    const { res, getBody } = makeRes();
    handler()(makeReq("binance"), res);
    expect(getBody().processing_rate_per_sec).toBe(1);
  });
});
