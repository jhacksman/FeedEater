import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseSince, sinceToInterval, getHistory } from "../history.js";

describe("parseSince", () => {
  it("parses '1h' correctly", () => {
    expect(parseSince("1h")).toEqual({ value: 1, unit: "h" });
  });

  it("parses '30m' correctly", () => {
    expect(parseSince("30m")).toEqual({ value: 30, unit: "m" });
  });

  it("parses '2d' correctly", () => {
    expect(parseSince("2d")).toEqual({ value: 2, unit: "d" });
  });

  it("parses '45s' correctly", () => {
    expect(parseSince("45s")).toEqual({ value: 45, unit: "s" });
  });

  it("returns null for invalid input", () => {
    expect(parseSince("abc")).toBeNull();
    expect(parseSince("")).toBeNull();
    expect(parseSince("1x")).toBeNull();
    expect(parseSince("h1")).toBeNull();
  });
});

describe("sinceToInterval", () => {
  it("converts hours", () => {
    expect(sinceToInterval({ value: 1, unit: "h" })).toBe("1 hours");
  });

  it("converts minutes", () => {
    expect(sinceToInterval({ value: 30, unit: "m" })).toBe("30 minutes");
  });

  it("converts days", () => {
    expect(sinceToInterval({ value: 7, unit: "d" })).toBe("7 days");
  });

  it("converts seconds", () => {
    expect(sinceToInterval({ value: 90, unit: "s" })).toBe("90 seconds");
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

  it("returns 400 for invalid since param", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";

    const req = { query: { since: "invalid" } } as any;
    let statusCode = 0;
    let body: any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (data: any) => { body = data; },
    } as any;

    const { getHistory: freshGetHistory } = await import("../history.js?v=2");
    await freshGetHistory(req, res);

    expect(statusCode).toBe(400);
    expect(body.error).toContain("Invalid");
  });
});
