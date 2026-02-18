import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { rateLimit, _resetBuckets, FREE_LIMIT, STANDARD_LIMIT } from "../middleware/rateLimit.js";

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    path: "/api/modules",
    headers: {},
    ip: "127.0.0.1",
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: unknown) { body = data; return res; },
    setHeader(key: string, value: string) { headers[key] = value; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
    get headers() { return headers; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown; headers: Record<string, string> };
}

describe("rateLimit middleware", () => {
  beforeEach(() => {
    _resetBuckets();
  });

  describe("free tier (no API key)", () => {
    it("sets X-RateLimit-Limit to free tier limit", () => {
      const req = makeReq();
      const res = makeRes();
      const next = vi.fn();
      rateLimit(req, res, next);
      expect(res.headers["X-RateLimit-Limit"]).toBe(String(FREE_LIMIT));
      expect(next).toHaveBeenCalledOnce();
    });

    it("decrements X-RateLimit-Remaining on each request", () => {
      const next = vi.fn();
      for (let i = 0; i < 3; i++) {
        const req = makeReq();
        const res = makeRes();
        rateLimit(req, res, next);
        expect(res.headers["X-RateLimit-Remaining"]).toBe(String(FREE_LIMIT - 1 - i));
      }
    });

    it("returns 429 after exhausting free tier tokens", () => {
      const next = vi.fn();
      for (let i = 0; i < FREE_LIMIT; i++) {
        const req = makeReq();
        const res = makeRes();
        rateLimit(req, res, next);
      }
      expect(next).toHaveBeenCalledTimes(FREE_LIMIT);

      const req = makeReq();
      const res = makeRes();
      rateLimit(req, res, next);
      expect(next).toHaveBeenCalledTimes(FREE_LIMIT);
      expect(res.statusCode).toBe(429);
      expect(res.body).toEqual({ error: "Too Many Requests" });
      expect(res.headers["Retry-After"]).toBeDefined();
      expect(res.headers["X-RateLimit-Remaining"]).toBe("0");
    });
  });

  describe("standard tier (with API key)", () => {
    it("sets X-RateLimit-Limit to standard tier limit", () => {
      const req = makeReq({ headers: { authorization: "Bearer my-key" } } as Partial<Request>);
      const res = makeRes();
      const next = vi.fn();
      rateLimit(req, res, next);
      expect(res.headers["X-RateLimit-Limit"]).toBe(String(STANDARD_LIMIT));
      expect(next).toHaveBeenCalledOnce();
    });

    it("allows up to standard limit requests", () => {
      const next = vi.fn();
      for (let i = 0; i < STANDARD_LIMIT; i++) {
        const req = makeReq({ headers: { authorization: "Bearer my-key" } } as Partial<Request>);
        const res = makeRes();
        rateLimit(req, res, next);
      }
      expect(next).toHaveBeenCalledTimes(STANDARD_LIMIT);

      const req = makeReq({ headers: { authorization: "Bearer my-key" } } as Partial<Request>);
      const res = makeRes();
      rateLimit(req, res, next);
      expect(res.statusCode).toBe(429);
    });
  });

  describe("bucket isolation", () => {
    it("tracks different API keys separately", () => {
      const next = vi.fn();
      for (let i = 0; i < FREE_LIMIT; i++) {
        const req = makeReq();
        const res = makeRes();
        rateLimit(req, res, next);
      }

      const req = makeReq({ headers: { authorization: "Bearer key-a" } } as Partial<Request>);
      const res = makeRes();
      rateLimit(req, res, next);
      expect(next).toHaveBeenCalledTimes(FREE_LIMIT + 1);
      expect(res.headers["X-RateLimit-Limit"]).toBe(String(STANDARD_LIMIT));
    });
  });

  describe("token refill", () => {
    it("refills tokens after time passes", () => {
      const next = vi.fn();
      const realNow = Date.now;

      let now = 1000000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      for (let i = 0; i < FREE_LIMIT; i++) {
        const req = makeReq();
        const res = makeRes();
        rateLimit(req, res, next);
      }
      expect(next).toHaveBeenCalledTimes(FREE_LIMIT);

      const blockedReq = makeReq();
      const blockedRes = makeRes();
      rateLimit(blockedReq, blockedRes, next);
      expect(blockedRes.statusCode).toBe(429);

      now += 60_000;

      const req = makeReq();
      const res = makeRes();
      rateLimit(req, res, next);
      expect(next).toHaveBeenCalledTimes(FREE_LIMIT + 1);

      vi.spyOn(Date, "now").mockRestore();
    });
  });

  describe("429 response", () => {
    it("includes Retry-After header as positive integer", () => {
      const next = vi.fn();
      for (let i = 0; i < FREE_LIMIT; i++) {
        const req = makeReq();
        const res = makeRes();
        rateLimit(req, res, next);
      }

      const req = makeReq();
      const res = makeRes();
      rateLimit(req, res, next);
      const retryAfter = Number(res.headers["Retry-After"]);
      expect(retryAfter).toBeGreaterThan(0);
      expect(Number.isInteger(retryAfter)).toBe(true);
    });
  });
});
