import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { apiKeyAuth } from "../middleware/auth.js";

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    path: "/api/modules",
    headers: {},
    ...overrides,
  } as unknown as Request;
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

describe("apiKeyAuth middleware", () => {
  const originalEnv = process.env.API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = originalEnv;
    }
  });

  describe("when API_KEY is not set (dev mode)", () => {
    beforeEach(() => {
      delete process.env.API_KEY;
    });

    it("allows requests without any auth header", () => {
      const req = makeReq();
      const res = makeRes();
      const next = vi.fn();
      apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it("allows requests to any path", () => {
      const req = makeReq({ path: "/api/settings/binance" } as Partial<Request>);
      const res = makeRes();
      const next = vi.fn();
      apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe("when API_KEY is set", () => {
    beforeEach(() => {
      process.env.API_KEY = "test-secret-key";
    });

    it("allows requests to /api/health/modules without auth", () => {
      const req = makeReq({ path: "/api/health/modules" } as Partial<Request>);
      const res = makeRes();
      const next = vi.fn();
      apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it("returns 401 when Authorization header is missing", () => {
      const req = makeReq();
      const res = makeRes();
      const next = vi.fn();
      apiKeyAuth(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Missing or malformed Authorization header" });
    });

    it("returns 401 when Authorization header has wrong scheme", () => {
      const req = makeReq({ headers: { authorization: "Basic abc123" } } as Partial<Request>);
      const res = makeRes();
      const next = vi.fn();
      apiKeyAuth(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Missing or malformed Authorization header" });
    });

    it("returns 401 when API key is wrong", () => {
      const req = makeReq({ headers: { authorization: "Bearer wrong-key" } } as Partial<Request>);
      const res = makeRes();
      const next = vi.fn();
      apiKeyAuth(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Invalid API key" });
    });

    it("allows requests with correct Bearer token", () => {
      const req = makeReq({ headers: { authorization: "Bearer test-secret-key" } } as Partial<Request>);
      const res = makeRes();
      const next = vi.fn();
      apiKeyAuth(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it("returns 401 for protected paths without auth", () => {
      const paths = ["/api/modules", "/api/settings/binance", "/api/history", "/api/bus/stream", "/"];
      for (const path of paths) {
        const req = makeReq({ path } as Partial<Request>);
        const res = makeRes();
        const next = vi.fn();
        apiKeyAuth(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
      }
    });
  });
});
