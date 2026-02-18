import { describe, it, expect, beforeEach } from "vitest";
import { getActiveAlerts } from "../activeAlerts.js";
import { AcknowledgedAlerts } from "../alertAcknowledge.js";
import { StalenessTracker } from "../staleness.js";

const NOW = new Date("2025-06-01T12:00:00.000Z").getTime();

function makeReq() {
  return {} as any;
}

function makeRes() {
  let body: any;
  const res = {
    json(data: any) { body = data; },
  } as any;
  return { res, getBody: () => body };
}

function noReconnects() {
  return [];
}

describe("GET /api/alerts/active", () => {
  let stalenessTracker: StalenessTracker;
  let ackedAlerts: AcknowledgedAlerts;
  let disabledModules: Set<string>;

  beforeEach(() => {
    stalenessTracker = new StalenessTracker(() => NOW);
    ackedAlerts = new AcknowledgedAlerts();
    disabledModules = new Set();
  });

  it("returns correct response shape", () => {
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: noReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("alerts");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("critical");
    expect(body).toHaveProperty("warning");
    expect(body).toHaveProperty("info");
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it("returns empty alerts when no issues", () => {
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: noReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total).toBe(0);
    expect(getBody().alerts).toEqual([]);
  });

  it("includes stale module alert", () => {
    let currentTime = NOW;
    const staleTracker = new StalenessTracker(() => currentTime);
    staleTracker.updateModuleSeen("binance");
    currentTime = NOW + 120_000;

    const handler = getActiveAlerts({
      stalenessTracker: staleTracker,
      disabledModules,
      ackedAlerts,
      nowFn: () => currentTime,
      getReconnects: noReconnects,
    });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.total).toBe(1);
    expect(body.alerts[0].module).toBe("binance");
    expect(body.alerts[0].severity).toBe("warning");
    expect(body.alerts[0]).toHaveProperty("id");
    expect(body.alerts[0]).toHaveProperty("triggered_at");
    expect(body.alerts[0]).toHaveProperty("age_seconds");
    expect(body.alerts[0]).toHaveProperty("message");
  });

  it("critical stale alert when age > 300s", () => {
    let currentTime = NOW;
    const staleTracker = new StalenessTracker(() => currentTime);
    staleTracker.updateModuleSeen("coinbase");
    currentTime = NOW + 400_000;
    const handler = getActiveAlerts({
      stalenessTracker: staleTracker,
      disabledModules,
      ackedAlerts,
      nowFn: () => currentTime,
      getReconnects: noReconnects,
    });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().alerts[0].severity).toBe("critical");
    expect(getBody().critical).toBe(1);
  });

  it("includes disabled module as info severity", () => {
    disabledModules.add("bybit");
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: noReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total).toBe(1);
    expect(getBody().info).toBe(1);
    expect(getBody().alerts[0].severity).toBe("info");
    expect(getBody().alerts[0].module).toBe("bybit");
  });

  it("includes reconnect alert", () => {
    const fakeReconnects = () => [{ module: "okx", count: 3, lastReconnectMs: NOW - 30_000 }];
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: fakeReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total).toBe(1);
    expect(getBody().warning).toBe(1);
    expect(getBody().alerts[0].module).toBe("okx");
    expect(getBody().alerts[0].message).toContain("reconnect");
  });

  it("reconnect with count >= 5 is critical", () => {
    const fakeReconnects = () => [{ module: "binance", count: 7, lastReconnectMs: NOW - 10_000 }];
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: fakeReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().alerts[0].severity).toBe("critical");
    expect(getBody().critical).toBe(1);
  });

  it("excludes acknowledged stale alerts", () => {
    let currentTime = NOW;
    const staleTracker = new StalenessTracker(() => currentTime);
    staleTracker.updateModuleSeen("binance");
    currentTime = NOW + 120_000;
    ackedAlerts.acknowledge("binance", "stale");
    const handler = getActiveAlerts({
      stalenessTracker: staleTracker,
      disabledModules,
      ackedAlerts,
      nowFn: () => currentTime,
      getReconnects: noReconnects,
    });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total).toBe(0);
  });

  it("excludes acknowledged disconnected alerts", () => {
    const fakeReconnects = () => [{ module: "okx", count: 3, lastReconnectMs: NOW - 10_000 }];
    ackedAlerts.acknowledge("okx", "disconnected");
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: fakeReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total).toBe(0);
  });

  it("excludes acknowledged disabled alerts", () => {
    disabledModules.add("gemini");
    ackedAlerts.acknowledge("gemini", "disabled");
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: noReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total).toBe(0);
  });

  it("sorts critical before warning before info", () => {
    disabledModules.add("bybit");
    const fakeReconnects = () => [{ module: "okx", count: 2, lastReconnectMs: NOW - 10_000 }];
    let currentTime = NOW;
    const staleTracker = new StalenessTracker(() => currentTime);
    staleTracker.updateModuleSeen("binance");
    currentTime = NOW + 400_000;

    const handler = getActiveAlerts({
      stalenessTracker: staleTracker,
      disabledModules,
      ackedAlerts,
      nowFn: () => currentTime,
      getReconnects: fakeReconnects,
    });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const severities = getBody().alerts.map((a: any) => a.severity);
    const critIdx = severities.indexOf("critical");
    const warnIdx = severities.indexOf("warning");
    const infoIdx = severities.indexOf("info");
    if (critIdx >= 0 && warnIdx >= 0) expect(critIdx).toBeLessThan(warnIdx);
    if (warnIdx >= 0 && infoIdx >= 0) expect(warnIdx).toBeLessThan(infoIdx);
  });

  it("each alert has all required fields with correct types", () => {
    disabledModules.add("bybit");
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: noReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const alert = getBody().alerts[0];
    expect(typeof alert.id).toBe("string");
    expect(typeof alert.module).toBe("string");
    expect(["info", "warning", "critical"]).toContain(alert.severity);
    expect(typeof alert.message).toBe("string");
    expect(typeof alert.triggered_at).toBe("string");
    expect(new Date(alert.triggered_at).toISOString()).toBe(alert.triggered_at);
    expect(typeof alert.age_seconds).toBe("number");
    expect(alert.age_seconds).toBeGreaterThanOrEqual(0);
  });

  it("counts sum correctly", () => {
    disabledModules.add("bybit");
    const fakeReconnects = () => [
      { module: "okx", count: 7, lastReconnectMs: NOW - 10_000 },
      { module: "coinbase", count: 2, lastReconnectMs: NOW - 5_000 },
    ];
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: fakeReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.total).toBe(body.critical + body.warning + body.info);
  });

  it("does not include expired reconnect alerts (older than 1 hour)", () => {
    const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
    const fakeReconnects = () => [{ module: "okx", count: 3, lastReconnectMs: twoHoursAgo }];
    const handler = getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts, nowFn: () => NOW, getReconnects: fakeReconnects });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total).toBe(0);
  });
});
