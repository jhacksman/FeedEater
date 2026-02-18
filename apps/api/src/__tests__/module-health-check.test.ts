import { describe, it, expect } from "vitest";
import { ModuleHealthStore } from "../moduleHealth.js";
import { getModuleHealthCheck } from "../moduleHealthCheck.js";

function makeReq(name: string) {
  return { params: { name } } as any;
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

const NOW = Date.now();
const STARTED_AT = NOW - 60_000;

function makeDeps(opts: { disabled?: string[]; messages?: Array<{ module: string; agoMs: number }> } = {}) {
  const store = new ModuleHealthStore();
  const disabledModules = new Set(opts.disabled ?? []);

  if (opts.messages) {
    for (const m of opts.messages) {
      (store as any).entries.set(m.module, {
        lastMessage: new Date(NOW - m.agoMs).toISOString(),
        messageCount: 1,
      });
    }
  }

  return { healthStore: store, disabledModules, startedAt: STARTED_AT, nowFn: () => NOW };
}

describe("GET /api/modules/:name/health", () => {
  it("returns 404 for unknown module", () => {
    const handler = getModuleHealthCheck(makeDeps());
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("unknown-xyz"), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("returns correct response shape", () => {
    const handler = getModuleHealthCheck(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("disabled");
    expect(body).toHaveProperty("last_heartbeat");
    expect(body).toHaveProperty("message_count");
    expect(body).toHaveProperty("consecutive_errors");
    expect(body).toHaveProperty("uptime_seconds");
  });

  it("returns error status when no heartbeat received", () => {
    const handler = getModuleHealthCheck(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().status).toBe("error");
    expect(getBody().last_heartbeat).toBeNull();
  });

  it("returns healthy when recent heartbeat", () => {
    const handler = getModuleHealthCheck(makeDeps({
      messages: [{ module: "binance", agoMs: 60_000 }],
    }));
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().status).toBe("healthy");
    expect(getBody().consecutive_errors).toBe(0);
  });

  it("returns degraded when heartbeat is stale (>5min, <30min)", () => {
    const handler = getModuleHealthCheck(makeDeps({
      messages: [{ module: "coinbase", agoMs: 10 * 60 * 1000 }],
    }));
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    expect(getBody().status).toBe("degraded");
    expect(getBody().consecutive_errors).toBeGreaterThan(0);
  });

  it("returns error when heartbeat is very old (>30min)", () => {
    const handler = getModuleHealthCheck(makeDeps({
      messages: [{ module: "bybit", agoMs: 60 * 60 * 1000 }],
    }));
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().status).toBe("error");
    expect(getBody().consecutive_errors).toBeGreaterThan(0);
  });

  it("returns error status for disabled module", () => {
    const handler = getModuleHealthCheck(makeDeps({
      disabled: ["gemini"],
      messages: [{ module: "gemini", agoMs: 30_000 }],
    }));
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    expect(getBody().status).toBe("error");
    expect(getBody().disabled).toBe(true);
  });

  it("disabled=false for enabled module", () => {
    const handler = getModuleHealthCheck(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    expect(getBody().disabled).toBe(false);
  });

  it("uptime_seconds reflects startedAt", () => {
    const handler = getModuleHealthCheck(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().uptime_seconds).toBe(60);
  });

  it("message_count is 0 when no messages", () => {
    const handler = getModuleHealthCheck(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    expect(getBody().message_count).toBe(0);
  });

  it("message_count reflects store data", () => {
    const handler = getModuleHealthCheck(makeDeps({
      messages: [{ module: "polymarket", agoMs: 1000 }],
    }));
    const { res, getBody } = makeRes();
    handler(makeReq("polymarket"), res);
    expect(getBody().message_count).toBe(1);
  });

  it("last_heartbeat is valid ISO when present", () => {
    const handler = getModuleHealthCheck(makeDeps({
      messages: [{ module: "binance", agoMs: 5000 }],
    }));
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const ts = getBody().last_heartbeat;
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("works for all known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleHealthCheck(makeDeps());
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});
