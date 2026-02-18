import { describe, it, expect } from "vitest";
import { LiveStatusStore } from "../status.js";
import { getMetrics } from "../metrics.js";

const CEX_MODULES = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx"];

function callHandler(store: LiveStatusStore) {
  let statusCode = 200;
  let body = "";
  let headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status: (code: number) => { statusCode = code; return res; },
    send: (data: string) => { body = data; },
    json: (data: any) => { body = JSON.stringify(data); },
  } as any;
  const req = {} as any;
  const handler = getMetrics({ store });
  return handler(req, res).then(() => ({ statusCode, body, headers }));
}

describe("GET /metrics — Prometheus exposition", () => {
  it("returns 200 with correct content-type", async () => {
    const store = new LiveStatusStore();
    const { statusCode, headers } = await callHandler(store);
    expect(statusCode).toBe(200);
    expect(headers["Content-Type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("contains feedeater_module_running gauge for each CEX module", async () => {
    const store = new LiveStatusStore();
    store.recordMessage("binance");
    const { body } = await callHandler(store);
    expect(body).toContain("# TYPE feedeater_module_running gauge");
    for (const mod of CEX_MODULES) {
      expect(body).toContain(`feedeater_module_running{module="${mod}"}`);
    }
  });

  it("contains feedeater_messages_total counter for each CEX module", async () => {
    const store = new LiveStatusStore();
    store.recordMessage("binance");
    store.recordMessage("binance");
    const { body } = await callHandler(store);
    expect(body).toContain("# TYPE feedeater_messages_total counter");
    expect(body).toContain('feedeater_messages_total{module="binance"} 2');
    for (const mod of CEX_MODULES) {
      expect(body).toContain(`feedeater_messages_total{module="${mod}"}`);
    }
  });

  it("contains feedeater_uptime_seconds gauge", async () => {
    const store = new LiveStatusStore();
    const { body } = await callHandler(store);
    expect(body).toContain("# TYPE feedeater_uptime_seconds gauge");
    expect(body).toMatch(/feedeater_uptime_seconds \d+/);
  });

  it("contains feedeater_errors_total counter with circuit_breaker label", async () => {
    const store = new LiveStatusStore();
    store.recordReconnect("bybit");
    store.recordReconnect("bybit");
    const { body } = await callHandler(store);
    expect(body).toContain("# TYPE feedeater_errors_total counter");
    expect(body).toContain('feedeater_errors_total{module="bybit",error="circuit_breaker"} 2');
    for (const mod of CEX_MODULES) {
      expect(body).toContain(`feedeater_errors_total{module="${mod}",error="circuit_breaker"}`);
    }
  });

  it("reports running=1 for healthy modules and running=0 for offline", async () => {
    const store = new LiveStatusStore();
    store.recordMessage("coinbase");
    const { body } = await callHandler(store);
    expect(body).toContain('feedeater_module_running{module="coinbase"} 1');
    expect(body).toContain('feedeater_module_running{module="gemini"} 0');
  });

  it("reports 0 counts for modules with no messages", async () => {
    const store = new LiveStatusStore();
    const { body } = await callHandler(store);
    for (const mod of CEX_MODULES) {
      expect(body).toContain(`feedeater_messages_total{module="${mod}"} 0`);
      expect(body).toContain(`feedeater_errors_total{module="${mod}",error="circuit_breaker"} 0`);
    }
  });
});
