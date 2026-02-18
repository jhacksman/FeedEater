import { describe, it, expect, beforeEach } from "vitest";
import { DataQualityHistoryStore, getModuleDataQualityHistory } from "../moduleDataQualityHistory.js";

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

describe("GET /api/modules/:name/data-quality-history", () => {
  let store: DataQualityHistoryStore;
  let now: number;

  beforeEach(() => {
    now = 1700000000000;
    store = new DataQualityHistoryStore(() => now);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape", () => {
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("history");
    expect(body).toHaveProperty("avg_score_24h");
    expect(body).toHaveProperty("min_score_24h");
    expect(Array.isArray(body.history)).toBe(true);
    expect(typeof body.avg_score_24h).toBe("number");
    expect(typeof body.min_score_24h).toBe("number");
  });

  it("returns empty history when no data", () => {
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.history).toEqual([]);
    expect(body.avg_score_24h).toBe(0);
    expect(body.min_score_24h).toBe(0);
  });

  it("records messages into correct hour bucket", () => {
    store.recordMessage("binance");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.history.length).toBe(1);
    expect(body.history[0].message_count).toBe(1);
  });

  it("counts multiple messages in same hour", () => {
    for (let i = 0; i < 10; i++) {
      store.recordMessage("bybit");
    }
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().history[0].message_count).toBe(10);
  });

  it("records errors in correct hour bucket", () => {
    store.recordMessage("gemini");
    store.recordError("gemini");
    store.recordError("gemini");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().history[0].error_count).toBe(2);
  });

  it("separates data into different hour buckets", () => {
    store.recordMessage("okx");
    now += 3_600_000;
    store.recordMessage("okx");
    store.recordMessage("okx");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    const body = getBody();
    expect(body.history.length).toBe(2);
    expect(body.history[0].message_count).toBe(1);
    expect(body.history[1].message_count).toBe(2);
  });

  it("excludes buckets older than 24h", () => {
    store.recordMessage("bitstamp");
    now += 25 * 3_600_000;
    store.recordMessage("bitstamp");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    expect(getBody().history.length).toBe(1);
  });

  it("detects gap when timestamps are > 5 min apart", () => {
    store.recordMessage("kalshi");
    now += 6 * 60 * 1000;
    store.recordMessage("kalshi");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    const entry = getBody().history[0];
    expect(entry.gap_detected).toBe(true);
  });

  it("no gap when timestamps are close together", () => {
    store.recordMessage("polymarket");
    now += 1000;
    store.recordMessage("polymarket");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    expect(getBody().history[0].gap_detected).toBe(false);
  });

  it("no gap when only one message in bucket", () => {
    store.recordMessage("aerodrome-base");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("aerodrome-base"), res);
    expect(getBody().history[0].gap_detected).toBe(false);
  });

  it("quality_score is 100 for healthy bucket (messages, no errors, no gap)", () => {
    for (let i = 0; i < 5; i++) {
      now += 1000;
      store.recordMessage("binance");
    }
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().history[0].quality_score).toBe(100);
  });

  it("quality_score penalizes errors", () => {
    store.recordMessage("coinbase");
    for (let i = 0; i < 3; i++) store.recordError("coinbase");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    expect(getBody().history[0].quality_score).toBeLessThan(100);
    expect(getBody().history[0].quality_score).toBe(85);
  });

  it("quality_score penalizes gap", () => {
    store.recordMessage("bybit");
    now += 6 * 60 * 1000;
    store.recordMessage("bybit");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().history[0].quality_score).toBe(80);
  });

  it("quality_score is 50 for bucket with zero messages", () => {
    store.recordError("gemini");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().history[0].quality_score).toBe(45);
  });

  it("quality_score is clamped 0-100", () => {
    for (let i = 0; i < 30; i++) store.recordError("okx");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    const score = getBody().history[0].quality_score;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("avg_score_24h is average of all bucket scores", () => {
    for (let i = 0; i < 5; i++) {
      now += 1000;
      store.recordMessage("bitstamp");
    }
    now += 3_600_000;
    store.recordMessage("bitstamp");
    for (let i = 0; i < 3; i++) store.recordError("bitstamp");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp"), res);
    const body = getBody();
    const scores = body.history.map((h: any) => h.quality_score);
    const expected = +(scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(1);
    expect(body.avg_score_24h).toBe(expected);
  });

  it("min_score_24h is minimum of all bucket scores", () => {
    for (let i = 0; i < 5; i++) {
      now += 1000;
      store.recordMessage("kalshi");
    }
    now += 3_600_000;
    for (let i = 0; i < 6; i++) store.recordError("kalshi");
    store.recordMessage("kalshi");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    const body = getBody();
    const scores = body.history.map((h: any) => h.quality_score);
    expect(body.min_score_24h).toBe(Math.min(...scores));
  });

  it("history entries have ISO timestamp", () => {
    store.recordMessage("binance");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const ts = getBody().history[0].timestamp;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("history is sorted by timestamp ascending", () => {
    store.recordMessage("polymarket");
    now += 3_600_000;
    store.recordMessage("polymarket");
    now += 3_600_000;
    store.recordMessage("polymarket");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    const timestamps = getBody().history.map((h: any) => h.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] > timestamps[i - 1]).toBe(true);
    }
  });

  it("modules are isolated from each other", () => {
    store.recordMessage("binance");
    store.recordMessage("binance");
    store.recordMessage("coinbase");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res: res1, getBody: getBody1 } = makeRes();
    handler(makeReq("binance"), res1);
    expect(getBody1().history[0].message_count).toBe(2);
    const { res: res2, getBody: getBody2 } = makeRes();
    handler(makeReq("coinbase"), res2);
    expect(getBody2().history[0].message_count).toBe(1);
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });

  it("each history entry has all required fields", () => {
    store.recordMessage("binance");
    store.recordError("binance");
    const handler = getModuleDataQualityHistory({ historyStore: store, nowFn: () => now });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const entry = getBody().history[0];
    expect(entry).toHaveProperty("timestamp");
    expect(entry).toHaveProperty("quality_score");
    expect(entry).toHaveProperty("message_count");
    expect(entry).toHaveProperty("error_count");
    expect(entry).toHaveProperty("gap_detected");
    expect(typeof entry.quality_score).toBe("number");
    expect(typeof entry.message_count).toBe("number");
    expect(typeof entry.error_count).toBe("number");
    expect(typeof entry.gap_detected).toBe("boolean");
  });
});
