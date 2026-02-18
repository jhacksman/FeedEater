import { describe, it, expect, beforeEach } from "vitest";
import { AlertHistoryStore, getAlertHistory } from "../alertHistory.js";

function makeReq(query: Record<string, string> = {}) {
  return { query } as any;
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

describe("AlertHistoryStore", () => {
  let store: AlertHistoryStore;

  beforeEach(() => {
    store = new AlertHistoryStore();
  });

  it("starts empty", () => {
    expect(store.all()).toEqual([]);
  });

  it("records an alert and assigns an id", () => {
    const rec = store.record("binance", "warning", "No data for 60s");
    expect(rec.alert_id).toBe("ah-1");
    expect(rec.module_name).toBe("binance");
    expect(rec.severity).toBe("warning");
    expect(rec.message).toBe("No data for 60s");
    expect(rec.created_at).toBeDefined();
    expect(rec.resolved_at).toBeNull();
    expect(rec.acknowledged_at).toBeNull();
    expect(rec.acknowledged_by).toBeNull();
  });

  it("increments alert_id", () => {
    store.record("binance", "warning", "a");
    const second = store.record("coinbase", "critical", "b");
    expect(second.alert_id).toBe("ah-2");
  });

  it("records with optional resolved_at and acknowledged_at", () => {
    const rec = store.record("okx", "critical", "down", {
      resolved_at: "2026-01-01T00:00:00Z",
      acknowledged_at: "2026-01-01T00:01:00Z",
      acknowledged_by: "admin",
    });
    expect(rec.resolved_at).toBe("2026-01-01T00:00:00Z");
    expect(rec.acknowledged_at).toBe("2026-01-01T00:01:00Z");
    expect(rec.acknowledged_by).toBe("admin");
  });

  it("markResolved sets resolved_at", () => {
    const rec = store.record("binance", "warning", "stale");
    expect(rec.resolved_at).toBeNull();
    const ok = store.markResolved(rec.alert_id, "2026-02-01T00:00:00Z");
    expect(ok).toBe(true);
    expect(store.all()[0].resolved_at).toBe("2026-02-01T00:00:00Z");
  });

  it("markResolved returns false for unknown id", () => {
    expect(store.markResolved("ah-999")).toBe(false);
  });

  it("markAcknowledged sets acknowledged_at and acknowledged_by", () => {
    const rec = store.record("coinbase", "critical", "error");
    const ok = store.markAcknowledged(rec.alert_id, "admin", "2026-02-01T12:00:00Z");
    expect(ok).toBe(true);
    expect(store.all()[0].acknowledged_at).toBe("2026-02-01T12:00:00Z");
    expect(store.all()[0].acknowledged_by).toBe("admin");
  });

  it("markAcknowledged returns false for unknown id", () => {
    expect(store.markAcknowledged("ah-999")).toBe(false);
  });

  it("clear empties the store and resets ids", () => {
    store.record("a", "info", "x");
    store.record("b", "info", "y");
    store.clear();
    expect(store.all()).toEqual([]);
    const rec = store.record("c", "info", "z");
    expect(rec.alert_id).toBe("ah-1");
  });
});

describe("GET /api/alerts/history", () => {
  let store: AlertHistoryStore;

  beforeEach(() => {
    store = new AlertHistoryStore();
  });

  it("returns empty list when no alerts", () => {
    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().alerts).toEqual([]);
    expect(getBody().total).toBe(0);
    expect(getBody().limit).toBe(50);
    expect(getBody().offset).toBe(0);
  });

  it("returns alerts sorted newest first", () => {
    store.record("binance", "warning", "a", { created_at: "2026-01-01T00:00:00Z" });
    store.record("coinbase", "critical", "b", { created_at: "2026-01-03T00:00:00Z" });
    store.record("okx", "info", "c", { created_at: "2026-01-02T00:00:00Z" });

    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);

    const alerts = getBody().alerts;
    expect(alerts.length).toBe(3);
    expect(alerts[0].module_name).toBe("coinbase");
    expect(alerts[1].module_name).toBe("okx");
    expect(alerts[2].module_name).toBe("binance");
  });

  it("respects limit param", () => {
    store.record("a", "info", "1", { created_at: "2026-01-01T00:00:00Z" });
    store.record("b", "info", "2", { created_at: "2026-01-02T00:00:00Z" });
    store.record("c", "info", "3", { created_at: "2026-01-03T00:00:00Z" });

    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ limit: "2" }), res);

    expect(getBody().alerts.length).toBe(2);
    expect(getBody().total).toBe(3);
    expect(getBody().limit).toBe(2);
  });

  it("respects offset param", () => {
    store.record("a", "info", "1", { created_at: "2026-01-01T00:00:00Z" });
    store.record("b", "info", "2", { created_at: "2026-01-02T00:00:00Z" });
    store.record("c", "info", "3", { created_at: "2026-01-03T00:00:00Z" });

    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ offset: "1" }), res);

    expect(getBody().alerts.length).toBe(2);
    expect(getBody().alerts[0].module_name).toBe("b");
    expect(getBody().offset).toBe(1);
  });

  it("filters by module", () => {
    store.record("binance", "warning", "a");
    store.record("coinbase", "critical", "b");
    store.record("binance", "info", "c");

    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ module: "binance" }), res);

    expect(getBody().alerts.length).toBe(2);
    expect(getBody().total).toBe(2);
    getBody().alerts.forEach((a: any) => expect(a.module_name).toBe("binance"));
  });

  it("filters by severity", () => {
    store.record("binance", "warning", "a");
    store.record("coinbase", "critical", "b");
    store.record("okx", "critical", "c");

    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ severity: "critical" }), res);

    expect(getBody().alerts.length).toBe(2);
    expect(getBody().total).toBe(2);
    getBody().alerts.forEach((a: any) => expect(a.severity).toBe("critical"));
  });

  it("combines module and severity filters", () => {
    store.record("binance", "warning", "a");
    store.record("binance", "critical", "b");
    store.record("coinbase", "critical", "c");

    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ module: "binance", severity: "critical" }), res);

    expect(getBody().alerts.length).toBe(1);
    expect(getBody().alerts[0].module_name).toBe("binance");
    expect(getBody().alerts[0].severity).toBe("critical");
  });

  it("clamps limit to max 500", () => {
    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ limit: "9999" }), res);
    expect(getBody().limit).toBe(500);
  });

  it("defaults limit to 50 for non-numeric input", () => {
    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ limit: "abc" }), res);
    expect(getBody().limit).toBe(50);
  });

  it("ignores negative offset", () => {
    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ offset: "-5" }), res);
    expect(getBody().offset).toBe(0);
  });

  it("returns resolved and acknowledged fields", () => {
    store.record("binance", "warning", "stale", {
      resolved_at: "2026-01-02T00:00:00Z",
      acknowledged_at: "2026-01-01T12:00:00Z",
      acknowledged_by: "admin",
    });

    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);

    const alert = getBody().alerts[0];
    expect(alert.resolved_at).toBe("2026-01-02T00:00:00Z");
    expect(alert.acknowledged_at).toBe("2026-01-01T12:00:00Z");
    expect(alert.acknowledged_by).toBe("admin");
  });

  it("offset beyond total returns empty page", () => {
    store.record("a", "info", "x");

    const handler = getAlertHistory({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ offset: "100" }), res);

    expect(getBody().alerts).toEqual([]);
    expect(getBody().total).toBe(1);
  });
});
