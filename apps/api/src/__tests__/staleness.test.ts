import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { StalenessTracker, getStaleness } from "../staleness.js";

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

describe("StalenessTracker", () => {
  it("returns empty array when no modules seen", () => {
    const tracker = new StalenessTracker();
    expect(tracker.getStalenessSummary()).toEqual([]);
  });

  it("tracks a single module as fresh", () => {
    const now = 1000000;
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("binance");
    const summary = tracker.getStalenessSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].module).toBe("binance");
    expect(summary[0].lastSeenMs).toBe(now);
    expect(summary[0].ageSeconds).toBe(0);
    expect(summary[0].stale).toBe(false);
  });

  it("returns stale=true when age exceeds threshold", () => {
    let now = 1000000;
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("coinbase");
    now += 61_000;
    const summary = tracker.getStalenessSummary();
    expect(summary[0].stale).toBe(true);
    expect(summary[0].ageSeconds).toBe(61);
  });

  it("returns stale=false when age is exactly at threshold", () => {
    let now = 1000000;
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("okx");
    now += 60_000;
    const summary = tracker.getStalenessSummary();
    expect(summary[0].stale).toBe(false);
    expect(summary[0].ageSeconds).toBe(60);
  });

  it("returns stale=false when age is below threshold", () => {
    let now = 1000000;
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("gemini");
    now += 30_000;
    const summary = tracker.getStalenessSummary();
    expect(summary[0].stale).toBe(false);
    expect(summary[0].ageSeconds).toBe(30);
  });

  it("tracks multiple modules independently", () => {
    let now = 1000000;
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("binance");
    now += 10_000;
    tracker.updateModuleSeen("coinbase");
    now += 55_000;
    const summary = tracker.getStalenessSummary();
    const binance = summary.find((s) => s.module === "binance");
    const coinbase = summary.find((s) => s.module === "coinbase");
    expect(binance?.stale).toBe(true);
    expect(binance?.ageSeconds).toBe(65);
    expect(coinbase?.stale).toBe(false);
    expect(coinbase?.ageSeconds).toBe(55);
  });

  it("sorts modules alphabetically", () => {
    const tracker = new StalenessTracker(() => 1000000);
    tracker.updateModuleSeen("okx");
    tracker.updateModuleSeen("binance");
    tracker.updateModuleSeen("coinbase");
    const names = tracker.getStalenessSummary().map((s) => s.module);
    expect(names).toEqual(["binance", "coinbase", "okx"]);
  });

  it("updates lastSeenMs on repeated calls", () => {
    let now = 1000000;
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("bybit");
    now += 50_000;
    tracker.updateModuleSeen("bybit");
    const summary = tracker.getStalenessSummary();
    expect(summary[0].lastSeenMs).toBe(1050000);
    expect(summary[0].ageSeconds).toBe(0);
    expect(summary[0].stale).toBe(false);
  });

  it("module becomes fresh again after update", () => {
    let now = 1000000;
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("bitstamp");
    now += 61_000;
    expect(tracker.getStalenessSummary()[0].stale).toBe(true);
    tracker.updateModuleSeen("bitstamp");
    expect(tracker.getStalenessSummary()[0].stale).toBe(false);
  });

  it("respects STALENESS_THRESHOLD_SECONDS env var", () => {
    const orig = process.env.STALENESS_THRESHOLD_SECONDS;
    process.env.STALENESS_THRESHOLD_SECONDS = "10";
    try {
      let now = 1000000;
      const tracker = new StalenessTracker(() => now);
      tracker.updateModuleSeen("binance");
      now += 11_000;
      const summary = tracker.getStalenessSummary();
      expect(summary[0].stale).toBe(true);
      expect(summary[0].ageSeconds).toBe(11);
    } finally {
      if (orig === undefined) delete process.env.STALENESS_THRESHOLD_SECONDS;
      else process.env.STALENESS_THRESHOLD_SECONDS = orig;
    }
  });

  it("uses default threshold when env var is invalid", () => {
    const orig = process.env.STALENESS_THRESHOLD_SECONDS;
    process.env.STALENESS_THRESHOLD_SECONDS = "not-a-number";
    try {
      let now = 1000000;
      const tracker = new StalenessTracker(() => now);
      tracker.updateModuleSeen("binance");
      now += 61_000;
      expect(tracker.getStalenessSummary()[0].stale).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.STALENESS_THRESHOLD_SECONDS;
      else process.env.STALENESS_THRESHOLD_SECONDS = orig;
    }
  });

  it("uses default threshold when env var is zero", () => {
    const orig = process.env.STALENESS_THRESHOLD_SECONDS;
    process.env.STALENESS_THRESHOLD_SECONDS = "0";
    try {
      let now = 1000000;
      const tracker = new StalenessTracker(() => now);
      tracker.updateModuleSeen("binance");
      now += 61_000;
      expect(tracker.getStalenessSummary()[0].stale).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.STALENESS_THRESHOLD_SECONDS;
      else process.env.STALENESS_THRESHOLD_SECONDS = orig;
    }
  });

  it("uses default threshold when env var is negative", () => {
    const orig = process.env.STALENESS_THRESHOLD_SECONDS;
    process.env.STALENESS_THRESHOLD_SECONDS = "-5";
    try {
      let now = 1000000;
      const tracker = new StalenessTracker(() => now);
      tracker.updateModuleSeen("binance");
      now += 61_000;
      expect(tracker.getStalenessSummary()[0].stale).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.STALENESS_THRESHOLD_SECONDS;
      else process.env.STALENESS_THRESHOLD_SECONDS = orig;
    }
  });

  it("returns correct ageSeconds for large intervals", () => {
    let now = 1000000;
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("kalshi");
    now += 3_600_000;
    const summary = tracker.getStalenessSummary();
    expect(summary[0].ageSeconds).toBe(3600);
    expect(summary[0].stale).toBe(true);
  });

  it("handles many modules without errors", () => {
    const tracker = new StalenessTracker(() => 1000000);
    for (let i = 0; i < 50; i++) {
      tracker.updateModuleSeen(`module-${String(i).padStart(3, "0")}`);
    }
    const summary = tracker.getStalenessSummary();
    expect(summary).toHaveLength(50);
    expect(summary[0].module).toBe("module-000");
    expect(summary[49].module).toBe("module-049");
  });
});

describe("GET /api/staleness handler", () => {
  it("returns empty array when no modules tracked", () => {
    const tracker = new StalenessTracker();
    const handler = getStaleness({ tracker });
    const res = makeRes();
    handler(makeReq(), res);
    expect(res.body).toEqual([]);
  });

  it("returns staleness summary with module data", () => {
    const now = 1000000;
    const tracker = new StalenessTracker(() => now);
    tracker.updateModuleSeen("binance");
    tracker.updateModuleSeen("coinbase");
    const handler = getStaleness({ tracker });
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as Array<{ module: string; lastSeenMs: number; ageSeconds: number; stale: boolean }>;
    expect(body).toHaveLength(2);
    expect(body[0].module).toBe("binance");
    expect(body[1].module).toBe("coinbase");
    expect(body[0].stale).toBe(false);
  });
});
