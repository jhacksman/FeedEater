import { describe, it, expect, beforeEach } from "vitest";
import { AcknowledgedAlerts, postAcknowledgeAlert, listAcknowledgedAlerts, deleteAcknowledgedAlert } from "../alertAcknowledge.js";

function makeReq(body: Record<string, unknown> = {}) {
  return { body } as any;
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

describe("POST /api/alerts/acknowledge", () => {
  let store: AcknowledgedAlerts;

  beforeEach(() => {
    store = new AcknowledgedAlerts();
  });

  it("returns 400 when module is missing", () => {
    const handler = postAcknowledgeAlert({ store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ type: "stale" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("module");
  });

  it("returns 400 when type is missing", () => {
    const handler = postAcknowledgeAlert({ store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ module: "binance" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("type");
  });

  it("returns 400 for invalid alert type", () => {
    const handler = postAcknowledgeAlert({ store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ module: "binance", type: "invalid" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("Invalid alert type");
  });

  it("acknowledges a valid alert", () => {
    const handler = postAcknowledgeAlert({ store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ module: "binance", type: "stale" }), res);
    expect(getStatus()).toBe(200);
    expect(getBody().success).toBe(true);
    expect(getBody().module).toBe("binance");
    expect(getBody().type).toBe("stale");
    expect(getBody().acknowledged_at).toBeDefined();
  });

  it("includes acknowledged_by when provided", () => {
    const handler = postAcknowledgeAlert({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ module: "coinbase", type: "disconnected", acknowledged_by: "admin" }), res);
    expect(getBody().acknowledged_by).toBe("admin");
  });

  it("acknowledged_by is null when not provided", () => {
    const handler = postAcknowledgeAlert({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ module: "bybit", type: "error" }), res);
    expect(getBody().acknowledged_by).toBeNull();
  });

  it("accepts all valid alert types", () => {
    const handler = postAcknowledgeAlert({ store });
    for (const type of ["stale", "disconnected", "disabled", "error"]) {
      const { res, getStatus } = makeRes();
      handler(makeReq({ module: "binance", type }), res);
      expect(getStatus()).toBe(200);
    }
  });

  it("re-acknowledging updates the timestamp", () => {
    const handler = postAcknowledgeAlert({ store });
    const { res: res1, getBody: getBody1 } = makeRes();
    handler(makeReq({ module: "okx", type: "stale" }), res1);
    const first = getBody1().acknowledged_at;

    const { res: res2, getBody: getBody2 } = makeRes();
    handler(makeReq({ module: "okx", type: "stale" }), res2);
    expect(getBody2().acknowledged_at).toBeDefined();
    expect(typeof getBody2().acknowledged_at).toBe("string");
  });
});

describe("GET /api/alerts/acknowledged", () => {
  let store: AcknowledgedAlerts;

  beforeEach(() => {
    store = new AcknowledgedAlerts();
  });

  it("returns empty list when nothing acknowledged", () => {
    const handler = listAcknowledgedAlerts({ store });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    expect(getBody().acknowledged).toEqual([]);
    expect(getBody().count).toBe(0);
  });

  it("returns acknowledged alerts", () => {
    store.acknowledge("binance", "stale", "admin");
    store.acknowledge("coinbase", "error");
    const handler = listAcknowledgedAlerts({ store });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    expect(getBody().count).toBe(2);
    expect(getBody().acknowledged[0]).toHaveProperty("module");
    expect(getBody().acknowledged[0]).toHaveProperty("type");
    expect(getBody().acknowledged[0]).toHaveProperty("acknowledged_at");
    expect(getBody().acknowledged[0]).toHaveProperty("acknowledged_by");
  });
});

describe("DELETE /api/alerts/acknowledge", () => {
  let store: AcknowledgedAlerts;

  beforeEach(() => {
    store = new AcknowledgedAlerts();
  });

  it("returns 400 when module missing", () => {
    const handler = deleteAcknowledgedAlert({ store });
    const { res, getStatus } = makeRes();
    handler(makeReq({ type: "stale" }), res);
    expect(getStatus()).toBe(400);
  });

  it("returns 404 when alert not acknowledged", () => {
    const handler = deleteAcknowledgedAlert({ store });
    const { res, getStatus } = makeRes();
    handler(makeReq({ module: "binance", type: "stale" }), res);
    expect(getStatus()).toBe(404);
  });

  it("removes an acknowledged alert", () => {
    store.acknowledge("binance", "stale");
    const handler = deleteAcknowledgedAlert({ store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ module: "binance", type: "stale" }), res);
    expect(getStatus()).toBe(200);
    expect(getBody().success).toBe(true);
    expect(store.isAcknowledged("binance", "stale")).toBe(false);
  });
});

describe("AcknowledgedAlerts store", () => {
  it("isAcknowledged returns false before ack", () => {
    const store = new AcknowledgedAlerts();
    expect(store.isAcknowledged("binance", "stale")).toBe(false);
  });

  it("isAcknowledged returns true after ack", () => {
    const store = new AcknowledgedAlerts();
    store.acknowledge("binance", "stale");
    expect(store.isAcknowledged("binance", "stale")).toBe(true);
  });

  it("clear removes all acks", () => {
    const store = new AcknowledgedAlerts();
    store.acknowledge("binance", "stale");
    store.acknowledge("coinbase", "error");
    store.clear();
    expect(store.listAll()).toEqual([]);
  });
});
