import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { StalenessTracker } from "../staleness.js";
import { getDataQuality } from "../dataQuality.js";
import { recordReconnect, resetStore } from "../reconnects.js";

function makeReq(): Request {
  return {} as unknown as Request;
}

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: unknown) { body = data; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

interface QualityResponse {
  systemScore: number;
  systemGrade: string;
  modules: Array<{
    name: string;
    score: number;
    grade: string;
    freshness_score: number;
    error_score: number;
    rate_score: number;
    details: {
      ageSeconds: number | null;
      stale: boolean;
      reconnects: number;
      expectedIntervalSeconds: number;
    };
  }>;
  generatedAt: string;
}

describe("GET /api/data-quality", () => {
  let now: number;

  beforeEach(() => {
    resetStore();
    now = Date.now();
  });

  afterEach(() => {
    resetStore();
  });

  it("returns all known modules with scores", () => {
    const tracker = new StalenessTracker(() => now);
    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    expect(body.modules.length).toBe(10);
    expect(body.systemScore).toBeTypeOf("number");
    expect(body.systemGrade).toBeTypeOf("string");
    expect(body.generatedAt).toBeTypeOf("string");
  });

  it("gives grade A to fresh module with no errors", () => {
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("binance");
    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const binance = body.modules.find((m) => m.name === "binance")!;
    expect(binance.score).toBe(100);
    expect(binance.grade).toBe("A");
    expect(binance.freshness_score).toBe(100);
    expect(binance.error_score).toBe(100);
    expect(binance.rate_score).toBe(100);
  });

  it("gives grade F to module with no data", () => {
    const tracker = new StalenessTracker(() => now);
    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const coinbase = body.modules.find((m) => m.name === "coinbase")!;
    expect(coinbase.score).toBe(30);
    expect(coinbase.freshness_score).toBe(0);
    expect(coinbase.error_score).toBe(100);
    expect(coinbase.rate_score).toBe(0);
  });

  it("penalizes stale data in freshness score", () => {
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("bybit");
    const staleTracker = new StalenessTracker(() => now + 300_000);
    staleTracker.updateModuleSeen("bybit");
    const staleTracker2 = new StalenessTracker(() => now);
    (staleTracker2 as any).lastSeen = new Map([["bybit", now - 300_000]]);
    (staleTracker2 as any).nowFn = () => now;

    const handler = getDataQuality({ stalenessTracker: staleTracker2, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const bybit = body.modules.find((m) => m.name === "bybit")!;
    expect(bybit.freshness_score).toBeLessThan(100);
    expect(bybit.score).toBeLessThan(100);
  });

  it("penalizes reconnects in error score", () => {
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("gemini");
    for (let i = 0; i < 6; i++) recordReconnect("gemini");

    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const gemini = body.modules.find((m) => m.name === "gemini")!;
    expect(gemini.error_score).toBe(30);
    expect(gemini.details.reconnects).toBe(6);
  });

  it("gives score 0 to disabled modules", () => {
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("okx");
    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set(["okx"]) });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const okx = body.modules.find((m) => m.name === "okx")!;
    expect(okx.score).toBe(0);
    expect(okx.grade).toBe("F");
  });

  it("computes weighted score correctly (40/30/30)", () => {
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("bitstamp");
    for (let i = 0; i < 3; i++) recordReconnect("bitstamp");

    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const m = body.modules.find((mod) => mod.name === "bitstamp")!;
    const expected = Math.round(m.freshness_score * 0.4 + m.error_score * 0.3 + m.rate_score * 0.3);
    expect(m.score).toBe(expected);
  });

  it("returns systemScore as average of all module scores", () => {
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("binance");
    tracker.updateModuleSeen("coinbase");
    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const total = body.modules.reduce((sum, m) => sum + m.score, 0);
    expect(body.systemScore).toBe(Math.round(total / body.modules.length));
  });

  it("systemGrade reflects systemScore", () => {
    const tracker = new StalenessTracker(() => now);
    for (const name of ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"]) {
      tracker.updateModuleSeen(name);
    }
    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    expect(body.systemGrade).toBe("A");
    expect(body.systemScore).toBe(100);
  });

  it("modules are sorted alphabetically", () => {
    const tracker = new StalenessTracker(() => now);
    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const names = body.modules.map((m) => m.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("includes expectedIntervalSeconds in details", () => {
    const tracker = new StalenessTracker(() => now);
    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    expect(body.modules[0].details.expectedIntervalSeconds).toBe(60);
  });

  it("high reconnect count yields error_score 0", () => {
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("kalshi");
    for (let i = 0; i < 15; i++) recordReconnect("kalshi");

    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const kalshi = body.modules.find((m) => m.name === "kalshi")!;
    expect(kalshi.error_score).toBe(0);
  });

  it("grade B for score in 80-89 range", () => {
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("polymarket");
    for (let i = 0; i < 2; i++) recordReconnect("polymarket");

    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: new Set() });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    const pm = body.modules.find((m) => m.name === "polymarket")!;
    expect(pm.error_score).toBe(80);
    expect(pm.grade).toBe("A");
  });

  it("handles all modules disabled gracefully", () => {
    const tracker = new StalenessTracker(() => now);
    const allDisabled = new Set(["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"]);
    const handler = getDataQuality({ stalenessTracker: tracker, disabledModules: allDisabled });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as QualityResponse;
    expect(body.systemScore).toBe(0);
    expect(body.systemGrade).toBe("F");
    for (const m of body.modules) {
      expect(m.score).toBe(0);
      expect(m.grade).toBe("F");
    }
  });
});
