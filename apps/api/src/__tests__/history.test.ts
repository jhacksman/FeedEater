import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isISOTimestamp, clampLimit, getHistory } from "../history.js";

describe("isISOTimestamp", () => {
  it("accepts valid ISO timestamps", () => {
    expect(isISOTimestamp("2025-01-15T12:00:00Z")).toBe(true);
    expect(isISOTimestamp("2025-06-01T00:00:00.000Z")).toBe(true);
  });

  it("rejects invalid strings", () => {
    expect(isISOTimestamp("not-a-date")).toBe(false);
    expect(isISOTimestamp("")).toBe(false);
  });
});

describe("clampLimit", () => {
  it("defaults to 100 when undefined", () => {
    expect(clampLimit(undefined)).toBe(100);
  });

  it("defaults to 100 for non-numeric input", () => {
    expect(clampLimit("abc")).toBe(100);
  });

  it("clamps to max 1000", () => {
    expect(clampLimit("5000")).toBe(1000);
  });

  it("clamps to min 1", () => {
    expect(clampLimit("0")).toBe(100);
    expect(clampLimit("-5")).toBe(1);
  });

  it("passes through valid values", () => {
    expect(clampLimit("50")).toBe(50);
    expect(clampLimit("1000")).toBe(1000);
  });
});

describe("getHistory", () => {
  const originalEnv = process.env.POSTGRES_URL;

  beforeEach(() => {
    delete process.env.POSTGRES_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.POSTGRES_URL = originalEnv;
    } else {
      delete process.env.POSTGRES_URL;
    }
  });

  it("returns 503 when POSTGRES_URL is not set", async () => {
    const req = { query: {} } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    await getHistory(req, res);

    expect(statusCode).toBe(503);
    expect(body).toEqual({ error: "Postgres not configured" });
  });

  it("returns 400 when market param is missing", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";

    const req = { query: {} } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    const { getHistory: freshGetHistory } = await import("../history.js?v=market");
    await freshGetHistory(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("market");
  });

  it("returns 400 for invalid start timestamp", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";

    const req = { query: { market: "feedeater.binance.trades", start: "not-a-date" } } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    const { getHistory: freshGetHistory } = await import("../history.js?v=start");
    await freshGetHistory(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("start");
  });

  it("returns 400 for invalid end timestamp", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";

    const req = { query: { market: "feedeater.binance.trades", end: "bad" } } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    const { getHistory: freshGetHistory } = await import("../history.js?v=end");
    await freshGetHistory(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("end");
  });
});
