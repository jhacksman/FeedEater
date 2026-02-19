import { describe, it, expect, beforeEach } from "vitest";
import { BackfillStore, getModuleBackfillStatus, postModuleBackfill } from "../moduleBackfill.js";

function makeReq(name: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) {
  return { params: { name }, body, query } as any;
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

describe("GET /api/modules/:name/backfill-status", () => {
  let store: BackfillStore;
  let tick: number;

  beforeEach(() => {
    tick = 1000;
    store = new BackfillStore(() => tick);
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleBackfillStatus({ backfillStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleBackfillStatus({ backfillStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns backfill_active false when no backfill started", () => {
    const handler = getModuleBackfillStatus({ backfillStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toEqual({ module: "binance", backfill_active: false });
  });

  it("returns full state when backfill is active", () => {
    store.start("coinbase", "2025-01-01T00:00:00Z", 1000);
    const handler = getModuleBackfillStatus({ backfillStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.module).toBe("coinbase");
    expect(body.backfill_active).toBe(true);
    expect(body.progress_pct).toBe(0);
    expect(body.records_backfilled).toBe(0);
    expect(body.records_total).toBe(1000);
    expect(body).toHaveProperty("started_at");
    expect(body).toHaveProperty("eta_seconds");
  });

  it("returns progress after updateProgress", () => {
    tick = 10000;
    store.start("bybit", "2025-01-01T00:00:00Z", 100);
    tick = 20000;
    store.updateProgress("bybit", 50);
    const handler = getModuleBackfillStatus({ backfillStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    const body = getBody();
    expect(body.backfill_active).toBe(true);
    expect(body.progress_pct).toBe(50);
    expect(body.records_backfilled).toBe(50);
    expect(body.eta_seconds).toBeTypeOf("number");
  });

  it("returns completed state after full progress", () => {
    store.start("gemini", "2025-01-01T00:00:00Z", 10);
    tick = 5000;
    store.updateProgress("gemini", 10);
    const handler = getModuleBackfillStatus({ backfillStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    const body = getBody();
    expect(body.backfill_active).toBe(false);
    expect(body.progress_pct).toBe(100);
    expect(body.records_backfilled).toBe(10);
    expect(body.eta_seconds).toBe(0);
  });

  it("started_at is ISO string", () => {
    tick = 1700000000000;
    store.start("okx", "2025-01-01T00:00:00Z", 100);
    const handler = getModuleBackfillStatus({ backfillStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    expect(getBody().started_at).toBe(new Date(1700000000000).toISOString());
  });

  it("modules are isolated", () => {
    store.start("binance", "2025-01-01T00:00:00Z", 100);
    const handler = getModuleBackfillStatus({ backfillStore: store });

    const { res: r1, getBody: gb1 } = makeRes();
    handler(makeReq("binance"), r1);
    expect(gb1().backfill_active).toBe(true);

    const { res: r2, getBody: gb2 } = makeRes();
    handler(makeReq("coinbase"), r2);
    expect(gb2()).toEqual({ module: "coinbase", backfill_active: false });
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleBackfillStatus({ backfillStore: store });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});

describe("POST /api/modules/:name/backfill", () => {
  let store: BackfillStore;
  let tick: number;

  beforeEach(() => {
    tick = 1000;
    store = new BackfillStore(() => tick);
  });

  it("returns 404 for unknown module", () => {
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module", { since: "2025-01-01T00:00:00Z" }), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });
    const { res, getStatus } = makeRes();
    handler(makeReq("", { since: "2025-01-01T00:00:00Z" }), res);
    expect(getStatus()).toBe(404);
  });

  it("returns 400 when since is missing", () => {
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toMatch(/since/);
  });

  it("returns 400 for invalid since timestamp", () => {
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", { since: "not-a-date" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toMatch(/since/);
  });

  it("returns 400 for invalid limit", () => {
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });

    const { res: r1, getStatus: gs1 } = makeRes();
    handler(makeReq("binance", { since: "2025-01-01T00:00:00Z", limit: "abc" }), r1);
    expect(gs1()).toBe(400);

    const { res: r2, getStatus: gs2 } = makeRes();
    handler(makeReq("binance", { since: "2025-01-01T00:00:00Z", limit: 0 }), r2);
    expect(gs2()).toBe(400);

    const { res: r3, getStatus: gs3 } = makeRes();
    handler(makeReq("binance", { since: "2025-01-01T00:00:00Z", limit: -5 }), r3);
    expect(gs3()).toBe(400);

    const { res: r4, getStatus: gs4 } = makeRes();
    handler(makeReq("binance", { since: "2025-01-01T00:00:00Z", limit: 2.5 }), r4);
    expect(gs4()).toBe(400);
  });

  it("returns 400 when limit exceeds max", () => {
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", { since: "2025-01-01T00:00:00Z", limit: 100001 }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toMatch(/100000/);
  });

  it("returns correct response shape on success", () => {
    tick = 5000;
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase", { since: "2025-01-01T00:00:00Z", limit: 500 }), res);
    const body = getBody();
    expect(body.module).toBe("coinbase");
    expect(body.backfill_active).toBe(true);
    expect(body.since).toBe("2025-01-01T00:00:00Z");
    expect(body.limit).toBe(500);
    expect(body.records_total).toBe(500);
    expect(body).toHaveProperty("started_at");
  });

  it("defaults limit to 1000", () => {
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit", { since: "2025-01-01T00:00:00Z" }), res);
    expect(getBody().limit).toBe(1000);
    expect(getBody().records_total).toBe(1000);
  });

  it("returns 409 if backfill already active", () => {
    store.start("kalshi", "2025-01-01T00:00:00Z", 100);
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("kalshi", { since: "2025-06-01T00:00:00Z" }), res);
    expect(getStatus()).toBe(409);
    expect(getBody().error).toMatch(/already/);
  });

  it("allows new backfill after previous completes", () => {
    store.start("bitstamp", "2025-01-01T00:00:00Z", 10);
    tick = 5000;
    store.updateProgress("bitstamp", 10);
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 6000 });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("bitstamp", { since: "2025-06-01T00:00:00Z", limit: 200 }), res);
    expect(getStatus()).toBe(200);
    expect(getBody().backfill_active).toBe(true);
    expect(getBody().limit).toBe(200);
  });

  it("started_at is ISO string", () => {
    tick = 1700000000000;
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 1700000000000 });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket", { since: "2025-01-01T00:00:00Z" }), res);
    expect(getBody().started_at).toBe(new Date(1700000000000).toISOString());
  });

  it("modules are isolated", () => {
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });

    const { res: r1, getBody: gb1 } = makeRes();
    handler(makeReq("binance", { since: "2025-01-01T00:00:00Z", limit: 100 }), r1);
    expect(gb1().module).toBe("binance");

    const { res: r2, getBody: gb2 } = makeRes();
    handler(makeReq("coinbase", { since: "2025-01-01T00:00:00Z", limit: 200 }), r2);
    expect(gb2().module).toBe("coinbase");
    expect(gb2().limit).toBe(200);
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = postModuleBackfill({ backfillStore: store, nowFn: () => 5000 });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod, { since: "2025-01-01T00:00:00Z" }), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});
