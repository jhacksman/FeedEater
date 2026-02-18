import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isISOTimestamp, clampPerPage, clampPage, rowsToCsv, getExport } from "../export.js";

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

describe("clampPerPage", () => {
  it("defaults to 100 when undefined", () => {
    expect(clampPerPage(undefined)).toBe(100);
  });

  it("defaults to 100 for non-numeric input", () => {
    expect(clampPerPage("abc")).toBe(100);
  });

  it("clamps to max 1000", () => {
    expect(clampPerPage("5000")).toBe(1000);
  });

  it("clamps to min 1", () => {
    expect(clampPerPage("-5")).toBe(1);
  });

  it("passes through valid values", () => {
    expect(clampPerPage("50")).toBe(50);
    expect(clampPerPage("1000")).toBe(1000);
  });
});

describe("clampPage", () => {
  it("defaults to 1 when undefined", () => {
    expect(clampPage(undefined)).toBe(1);
  });

  it("defaults to 1 for non-numeric input", () => {
    expect(clampPage("abc")).toBe(1);
  });

  it("clamps to min 1", () => {
    expect(clampPage("0")).toBe(1);
    expect(clampPage("-3")).toBe(1);
  });

  it("passes through valid values", () => {
    expect(clampPage("1")).toBe(1);
    expect(clampPage("5")).toBe(5);
    expect(clampPage("100")).toBe(100);
  });
});

describe("rowsToCsv", () => {
  it("returns header-only for empty array", () => {
    expect(rowsToCsv([])).toBe("timestamp,price,volume,side,source\n");
  });

  it("formats rows with all fields", () => {
    const rows = [
      { timestamp: "2025-01-15T12:00:00.000Z", price: "100.5", volume: "1.2", side: "buy", source: "binance" },
    ];
    const csv = rowsToCsv(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("timestamp,price,volume,side,source");
    expect(lines[1]).toBe("2025-01-15T12:00:00.000Z,100.5,1.2,buy,binance");
  });

  it("handles null fields as empty strings", () => {
    const rows = [
      { timestamp: "2025-01-15T12:00:00.000Z", price: null, volume: null, side: null, source: null },
    ];
    const csv = rowsToCsv(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines[1]).toBe("2025-01-15T12:00:00.000Z,,,,");
  });
});

describe("getExport", () => {
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

    await getExport(req, res);

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

    const { getExport: fresh } = await import("../export.js?v=market");
    await fresh(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("market");
  });

  it("returns 400 for invalid format param", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";

    const req = { query: { market: "feedeater.binance.trades", format: "xml" } } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    const { getExport: fresh } = await import("../export.js?v=format");
    await fresh(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("format");
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

    const { getExport: fresh } = await import("../export.js?v=start");
    await fresh(req, res);

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

    const { getExport: fresh } = await import("../export.js?v=end");
    await fresh(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("end");
  });
});
