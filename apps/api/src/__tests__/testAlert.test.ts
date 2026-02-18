import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { postTestAlert } from "../testAlert.js";
import type { Webhook } from "../webhooks.js";

function makeReq(params: Record<string, string> = {}, body: Record<string, unknown> = {}): Request {
  return { params, body } as unknown as Request;
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

function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: overrides.id ?? "wh-1",
    url: overrides.url ?? "https://example.com/hook",
    module: overrides.module ?? "binance",
    secret: overrides.secret ?? "test-secret",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

interface TestAlertResponse {
  delivered: number;
  failed: number;
  webhook_ids: string[];
  results?: Array<{
    webhook_id: string;
    status: "delivered" | "failed";
    httpStatus?: number;
    error?: string;
  }>;
  error?: string;
}

describe("POST /api/modules/:name/test-alert", () => {
  it("returns 404 for unknown module", async () => {
    const handler = postTestAlert({ webhooks: [] });
    const res = makeRes();
    await handler(makeReq({ name: "unknown-mod" }), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain("Unknown module");
  });

  it("returns 404 for missing name param", async () => {
    const handler = postTestAlert({ webhooks: [] });
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns zero counts when no webhooks registered", async () => {
    const handler = postTestAlert({ webhooks: [] });
    const res = makeRes();
    await handler(makeReq({ name: "binance" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.webhook_ids).toEqual([]);
  });

  it("returns zero counts when webhooks exist but for different module", async () => {
    const webhooks = [makeWebhook({ module: "coinbase" })];
    const handler = postTestAlert({ webhooks });
    const res = makeRes();
    await handler(makeReq({ name: "binance" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.webhook_ids).toEqual([]);
  });

  it("delivers to a single webhook successfully", async () => {
    const webhooks = [makeWebhook({ id: "wh-1", module: "binance" })];
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "binance" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.webhook_ids).toEqual(["wh-1"]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("sends correct payload shape to webhook", async () => {
    const webhooks = [makeWebhook({ module: "coinbase" })];
    let sentBody = "";
    const mockFetch = vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
      sentBody = opts.body;
      return Promise.resolve({ ok: true, status: 200 });
    });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "coinbase" }), res);
    const parsed = JSON.parse(sentBody);
    expect(parsed.module).toBe("coinbase");
    expect(parsed.data.type).toBe("test-alert");
    expect(parsed.data.message).toContain("coinbase");
    expect(parsed.timestamp).toBeTypeOf("string");
  });

  it("sends X-FeedEater-Signature header", async () => {
    const webhooks = [makeWebhook({ module: "bybit", secret: "my-secret" })];
    let headers: Record<string, string> = {};
    const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers: Record<string, string> }) => {
      headers = opts.headers;
      return Promise.resolve({ ok: true, status: 200 });
    });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "bybit" }), res);
    expect(headers["X-FeedEater-Signature"]).toBeTypeOf("string");
    expect(headers["X-FeedEater-Signature"].length).toBeGreaterThan(0);
  });

  it("reports failed delivery on HTTP error", async () => {
    const webhooks = [makeWebhook({ id: "wh-fail", module: "gemini" })];
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "gemini" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.webhook_ids).toEqual(["wh-fail"]);
    expect(body.results![0].error).toContain("HTTP 500");
  });

  it("reports failed delivery on network error", async () => {
    const webhooks = [makeWebhook({ id: "wh-net", module: "okx" })];
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "okx" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results![0].error).toBe("ECONNREFUSED");
  });

  it("delivers to multiple webhooks for the same module", async () => {
    const webhooks = [
      makeWebhook({ id: "wh-a", module: "bitstamp" }),
      makeWebhook({ id: "wh-b", module: "bitstamp" }),
      makeWebhook({ id: "wh-c", module: "bitstamp" }),
    ];
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "bitstamp" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(3);
    expect(body.failed).toBe(0);
    expect(body.webhook_ids).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles partial failure across multiple webhooks", async () => {
    const webhooks = [
      makeWebhook({ id: "wh-ok", module: "kalshi" }),
      makeWebhook({ id: "wh-bad", module: "kalshi" }),
    ];
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "kalshi" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.webhook_ids).toHaveLength(2);
  });

  it("only delivers to webhooks matching the module", async () => {
    const webhooks = [
      makeWebhook({ id: "wh-match", module: "polymarket" }),
      makeWebhook({ id: "wh-other", module: "binance" }),
    ];
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "polymarket" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(1);
    expect(body.webhook_ids).toEqual(["wh-match"]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("works with aerodrome-base module name", async () => {
    const webhooks = [makeWebhook({ id: "wh-aero", module: "aerodrome-base" })];
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "aerodrome-base" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(1);
  });

  it("works with uniswap-base module name", async () => {
    const webhooks = [makeWebhook({ id: "wh-uni", module: "uniswap-base" })];
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "uniswap-base" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.delivered).toBe(1);
  });

  it("includes results array with per-webhook detail", async () => {
    const webhooks = [makeWebhook({ id: "wh-detail", module: "binance" })];
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const handler = postTestAlert({ webhooks, fetchFn: mockFetch as unknown as typeof fetch });
    const res = makeRes();
    await handler(makeReq({ name: "binance" }), res);
    const body = res.body as TestAlertResponse;
    expect(body.results).toHaveLength(1);
    expect(body.results![0].webhook_id).toBe("wh-detail");
    expect(body.results![0].status).toBe("delivered");
    expect(body.results![0].httpStatus).toBe(200);
  });
});
