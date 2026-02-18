import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isISOTimestamp, clampLimit, encodeCursor, decodeCursor, getHistory } from "../history.js";

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

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a valid timestamp and id", () => {
    const ts = "2025-06-01T12:00:00.000Z";
    const id = "42";
    const cursor = encodeCursor(ts, id);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ timestamp: ts, id });
  });

  it("produces a base64 string", () => {
    const cursor = encodeCursor("2025-01-01T00:00:00Z", "1");
    expect(typeof cursor).toBe("string");
    expect(cursor).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("returns null for garbage input", () => {
    expect(decodeCursor("not-base64!!!")).toBeNull();
  });

  it("returns null for base64 without colon separator", () => {
    const bad = Buffer.from("nocolon").toString("base64");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for base64 with invalid timestamp", () => {
    const bad = Buffer.from("not-a-date:42").toString("base64");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for empty id after colon", () => {
    const bad = Buffer.from("2025-01-01T00:00:00Z:").toString("base64");
    expect(decodeCursor(bad)).toBeNull();
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

  it("returns 400 for invalid cursor", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";

    const req = { query: { market: "feedeater.binance.trades", cursor: "garbage!!!" } } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    const { getHistory: freshGetHistory } = await import("../history.js?v=badcursor");
    await freshGetHistory(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("cursor");
  });

  it("returns 400 for cursor with invalid timestamp inside", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";

    const badCursor = Buffer.from("not-a-date:99").toString("base64");
    const req = { query: { market: "feedeater.binance.trades", cursor: badCursor } } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    const { getHistory: freshGetHistory } = await import("../history.js?v=badcursor2");
    await freshGetHistory(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("cursor");
  });

  it("returns 400 for cursor with empty id", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";

    const badCursor = Buffer.from("2025-01-01T00:00:00Z:").toString("base64");
    const req = { query: { market: "feedeater.binance.trades", cursor: badCursor } } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    const { getHistory: freshGetHistory } = await import("../history.js?v=badcursor3");
    await freshGetHistory(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("cursor");
  });

  it("accepts a valid cursor without returning 400 (query may fail but validates)", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";

    const validCursor = encodeCursor("2025-06-01T12:00:00.000Z", "100");
    const req = { query: { market: "feedeater.binance.trades", cursor: validCursor } } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    const { getHistory: freshGetHistory } = await import("../history.js?v=goodcursor");
    await freshGetHistory(req, res);

    expect(statusCode).not.toBe(400);
  });

  it("cursor is opaque base64 (clients cannot parse internals)", () => {
    const cursor = encodeCursor("2025-06-01T12:00:00.000Z", "55");
    expect(cursor).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(cursor).not.toContain("2025-06-01");
    expect(cursor).not.toContain("55");
  });

  it("decoded cursor matches what was encoded", () => {
    const ts = "2025-03-15T08:30:00.000Z";
    const id = "12345";
    const cursor = encodeCursor(ts, id);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ timestamp: ts, id });
  });
});
