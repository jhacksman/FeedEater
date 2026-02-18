import { describe, it, expect, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { StalenessTracker } from "../staleness.js";
import { getAlerts } from "../alerts.js";
import { recordReconnect, resetStore as resetReconnects } from "../reconnects.js";

beforeEach(() => {
  resetReconnects();
});

function makeReq(): Request {
  return { params: {}, body: {}, headers: {}, query: {} } as unknown as Request;
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

function makeDeps(overrides: Partial<Parameters<typeof getAlerts>[0]> = {}) {
  const stalenessTracker = new StalenessTracker();
  const disabledModules = new Set<string>();
  return {
    stalenessTracker,
    disabledModules,
    ...overrides,
  };
}

describe("GET /api/alerts", () => {
  it("returns all required top-level fields", () => {
    const handler = getAlerts(makeDeps());
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("alerts");
    expect(body).toHaveProperty("count");
    expect(body).toHaveProperty("critical");
    expect(body).toHaveProperty("warning");
  });

  it("returns empty alerts when everything is healthy", () => {
    const handler = getAlerts(makeDeps());
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: unknown[]; count: number; critical: number; warning: number };
    expect(body.alerts).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.critical).toBe(0);
    expect(body.warning).toBe(0);
  });

  it("detects stale modules with warning severity", () => {
    const tracker = new StalenessTracker(() => 100_000);
    tracker.updateModuleSeen("binance");
    Object.assign(tracker, { nowFn: () => 200_000 });
    const handler = getAlerts(makeDeps({ stalenessTracker: tracker }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ module: string; type: string; severity: string; message: string; since: string }> };
    const staleAlert = body.alerts.find((a) => a.module === "binance" && a.type === "stale");
    expect(staleAlert).toBeDefined();
    expect(staleAlert!.severity).toBe("warning");
    expect(staleAlert!.message).toContain("100s");
  });

  it("stale modules get critical severity when age exceeds 300s", () => {
    const tracker = new StalenessTracker(() => 100_000);
    tracker.updateModuleSeen("coinbase");
    Object.assign(tracker, { nowFn: () => 500_000 });
    const handler = getAlerts(makeDeps({ stalenessTracker: tracker }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ module: string; type: string; severity: string }> };
    const staleAlert = body.alerts.find((a) => a.module === "coinbase" && a.type === "stale");
    expect(staleAlert).toBeDefined();
    expect(staleAlert!.severity).toBe("critical");
  });

  it("detects disconnected modules with recent reconnects", () => {
    const now = Date.now();
    recordReconnect("okx");
    recordReconnect("okx");
    const handler = getAlerts(makeDeps({ nowFn: () => now }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ module: string; type: string; severity: string; message: string }> };
    const disconnected = body.alerts.find((a) => a.module === "okx" && a.type === "disconnected");
    expect(disconnected).toBeDefined();
    expect(disconnected!.severity).toBe("warning");
    expect(disconnected!.message).toContain("2 reconnect");
  });

  it("disconnected modules get critical severity at 5+ reconnects", () => {
    const now = Date.now();
    for (let i = 0; i < 6; i++) recordReconnect("gemini");
    const handler = getAlerts(makeDeps({ nowFn: () => now }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ module: string; type: string; severity: string }> };
    const disconnected = body.alerts.find((a) => a.module === "gemini" && a.type === "disconnected");
    expect(disconnected).toBeDefined();
    expect(disconnected!.severity).toBe("critical");
  });

  it("does not flag reconnects older than one hour", () => {
    const now = Date.now();
    recordReconnect("bybit");
    const twoHoursLater = now + 2 * 60 * 60 * 1000;
    const handler = getAlerts(makeDeps({ nowFn: () => twoHoursLater }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ module: string; type: string }> };
    const disconnected = body.alerts.find((a) => a.module === "bybit" && a.type === "disconnected");
    expect(disconnected).toBeUndefined();
  });

  it("detects disabled modules", () => {
    const disabled = new Set(["binance", "okx"]);
    const handler = getAlerts(makeDeps({ disabledModules: disabled }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ module: string; type: string; severity: string; message: string }> };
    const disabledAlerts = body.alerts.filter((a) => a.type === "disabled");
    expect(disabledAlerts).toHaveLength(2);
    expect(disabledAlerts[0]!.severity).toBe("warning");
    expect(disabledAlerts[0]!.message).toContain("disabled");
  });

  it("each alert has module, type, severity, message, since fields", () => {
    const disabled = new Set(["bitstamp"]);
    const handler = getAlerts(makeDeps({ disabledModules: disabled }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<Record<string, unknown>> };
    const alert = body.alerts[0];
    expect(alert).toHaveProperty("module");
    expect(alert).toHaveProperty("type");
    expect(alert).toHaveProperty("severity");
    expect(alert).toHaveProperty("message");
    expect(alert).toHaveProperty("since");
  });

  it("since field is a valid ISO string", () => {
    const disabled = new Set(["kalshi"]);
    const handler = getAlerts(makeDeps({ disabledModules: disabled }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ since: string }> };
    const since = body.alerts[0]!.since;
    expect(new Date(since).toISOString()).toBe(since);
  });

  it("counts critical and warning separately", () => {
    const tracker = new StalenessTracker(() => 100_000);
    tracker.updateModuleSeen("binance");
    Object.assign(tracker, { nowFn: () => 500_000 });
    const disabled = new Set(["okx"]);
    const handler = getAlerts(makeDeps({ stalenessTracker: tracker, disabledModules: disabled }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { count: number; critical: number; warning: number };
    expect(body.critical).toBeGreaterThanOrEqual(1);
    expect(body.warning).toBeGreaterThanOrEqual(1);
    expect(body.count).toBe(body.critical + body.warning);
  });

  it("can produce multiple alert types for the same module", () => {
    const now = Date.now();
    const tracker = new StalenessTracker(() => now - 200_000);
    tracker.updateModuleSeen("binance");
    Object.assign(tracker, { nowFn: () => now });
    recordReconnect("binance");
    const disabled = new Set(["binance"]);
    const handler = getAlerts(makeDeps({ stalenessTracker: tracker, disabledModules: disabled, nowFn: () => now }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ module: string; type: string }> };
    const binanceAlerts = body.alerts.filter((a) => a.module === "binance");
    const types = binanceAlerts.map((a) => a.type);
    expect(types).toContain("stale");
    expect(types).toContain("disconnected");
    expect(types).toContain("disabled");
  });

  it("severity is always warning or critical", () => {
    const tracker = new StalenessTracker(() => 100_000);
    tracker.updateModuleSeen("binance");
    Object.assign(tracker, { nowFn: () => 500_000 });
    recordReconnect("okx");
    const disabled = new Set(["gemini"]);
    const handler = getAlerts(makeDeps({ stalenessTracker: tracker, disabledModules: disabled }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ severity: string }> };
    for (const alert of body.alerts) {
      expect(["warning", "critical"]).toContain(alert.severity);
    }
  });

  it("type is always stale, disconnected, disabled, or error", () => {
    const tracker = new StalenessTracker(() => 100_000);
    tracker.updateModuleSeen("coinbase");
    Object.assign(tracker, { nowFn: () => 500_000 });
    recordReconnect("bybit");
    const disabled = new Set(["kalshi"]);
    const handler = getAlerts(makeDeps({ stalenessTracker: tracker, disabledModules: disabled }));
    const res = makeRes();
    handler(makeReq(), res);
    const body = res.body as { alerts: Array<{ type: string }> };
    for (const alert of body.alerts) {
      expect(["stale", "disconnected", "disabled", "error"]).toContain(alert.type);
    }
  });
});
