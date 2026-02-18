import { describe, it, expect, beforeEach } from "vitest";
import { AlertConfigStore, getModuleAlertConfig, patchModuleAlertConfig } from "../moduleAlertConfig.js";

function makeReq(name: string, body?: any) {
  return { params: { name }, body } as any;
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

describe("GET /api/modules/:name/alert-config", () => {
  let store: AlertConfigStore;

  beforeEach(() => {
    store = new AlertConfigStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleAlertConfig({ configStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleAlertConfig({ configStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape with defaults", () => {
    const handler = getModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("enabled", true);
    expect(body).toHaveProperty("error_rate_threshold", 0.05);
    expect(body).toHaveProperty("latency_threshold_ms", 5000);
    expect(body).toHaveProperty("reconnect_threshold", 3);
    expect(body).toHaveProperty("severity", "warning");
    expect(body).toHaveProperty("cooldown_seconds", 300);
    expect(body).toHaveProperty("channels");
    expect(body.channels).toEqual(["webhook"]);
  });

  it("returns updated config after PATCH", () => {
    store.update("coinbase", { enabled: false, severity: "critical" });
    const handler = getModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.enabled).toBe(false);
    expect(body.severity).toBe("critical");
    expect(body.error_rate_threshold).toBe(0.05);
  });

  it("modules are isolated from each other", () => {
    store.update("binance", { severity: "critical" });
    const handler = getModuleAlertConfig({ configStore: store });
    const { res: res1, getBody: getBody1 } = makeRes();
    handler(makeReq("binance"), res1);
    expect(getBody1().severity).toBe("critical");
    const { res: res2, getBody: getBody2 } = makeRes();
    handler(makeReq("coinbase"), res2);
    expect(getBody2().severity).toBe("warning");
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleAlertConfig({ configStore: store });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});

describe("PATCH /api/modules/:name/alert-config", () => {
  let store: AlertConfigStore;

  beforeEach(() => {
    store = new AlertConfigStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module", { enabled: false }), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq("", { enabled: false }), res);
    expect(getStatus()).toBe(404);
  });

  it("returns 400 for missing body", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", undefined), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toMatch(/body/i);
  });

  it("returns 400 for array body", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq("binance", [1, 2]), res);
    expect(getStatus()).toBe(400);
  });

  it("returns 400 for empty object (no valid fields)", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", {}), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toMatch(/no valid/i);
  });

  it("updates enabled field", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance", { enabled: false }), res);
    expect(getBody().enabled).toBe(false);
    expect(getBody().module).toBe("binance");
  });

  it("rejects non-boolean enabled", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance", { enabled: "yes" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toMatch(/enabled/);
  });

  it("updates error_rate_threshold", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit", { error_rate_threshold: 0.1 }), res);
    expect(getBody().error_rate_threshold).toBe(0.1);
  });

  it("rejects error_rate_threshold out of range", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res: res1, getStatus: gs1 } = makeRes();
    handler(makeReq("bybit", { error_rate_threshold: -0.1 }), res1);
    expect(gs1()).toBe(400);
    const { res: res2, getStatus: gs2 } = makeRes();
    handler(makeReq("bybit", { error_rate_threshold: 1.5 }), res2);
    expect(gs2()).toBe(400);
  });

  it("updates latency_threshold_ms", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini", { latency_threshold_ms: 10000 }), res);
    expect(getBody().latency_threshold_ms).toBe(10000);
  });

  it("rejects negative latency_threshold_ms", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq("gemini", { latency_threshold_ms: -1 }), res);
    expect(getStatus()).toBe(400);
  });

  it("updates reconnect_threshold", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("okx", { reconnect_threshold: 5 }), res);
    expect(getBody().reconnect_threshold).toBe(5);
  });

  it("rejects non-integer reconnect_threshold", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq("okx", { reconnect_threshold: 2.5 }), res);
    expect(getStatus()).toBe(400);
  });

  it("updates severity", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bitstamp", { severity: "critical" }), res);
    expect(getBody().severity).toBe("critical");
  });

  it("rejects invalid severity", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq("bitstamp", { severity: "urgent" }), res);
    expect(getStatus()).toBe(400);
  });

  it("updates cooldown_seconds", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi", { cooldown_seconds: 600 }), res);
    expect(getBody().cooldown_seconds).toBe(600);
  });

  it("rejects negative cooldown_seconds", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq("kalshi", { cooldown_seconds: -10 }), res);
    expect(getStatus()).toBe(400);
  });

  it("updates channels", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket", { channels: ["webhook", "slack"] }), res);
    expect(getBody().channels).toEqual(["webhook", "slack"]);
  });

  it("rejects invalid channels", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq("polymarket", { channels: ["sms"] }), res);
    expect(getStatus()).toBe(400);
  });

  it("updates multiple fields at once", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance", {
      enabled: false,
      severity: "critical",
      cooldown_seconds: 60,
      channels: ["email", "slack"],
    }), res);
    const body = getBody();
    expect(body.enabled).toBe(false);
    expect(body.severity).toBe("critical");
    expect(body.cooldown_seconds).toBe(60);
    expect(body.channels).toEqual(["email", "slack"]);
    expect(body.error_rate_threshold).toBe(0.05);
  });

  it("persists updates across GET calls", () => {
    const patchHandler = patchModuleAlertConfig({ configStore: store });
    const getHandler = getModuleAlertConfig({ configStore: store });
    const { res: pRes } = makeRes();
    patchHandler(makeReq("aerodrome-base", { severity: "info", cooldown_seconds: 120 }), pRes);
    const { res: gRes, getBody } = makeRes();
    getHandler(makeReq("aerodrome-base"), gRes);
    expect(getBody().severity).toBe("info");
    expect(getBody().cooldown_seconds).toBe(120);
  });

  it("does not affect other modules when updating one", () => {
    const handler = patchModuleAlertConfig({ configStore: store });
    const { res } = makeRes();
    handler(makeReq("uniswap-base", { enabled: false }), res);
    const getHandler = getModuleAlertConfig({ configStore: store });
    const { res: gRes, getBody } = makeRes();
    getHandler(makeReq("binance"), gRes);
    expect(getBody().enabled).toBe(true);
  });
});
