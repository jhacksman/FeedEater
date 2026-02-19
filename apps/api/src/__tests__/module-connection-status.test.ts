import { describe, it, expect, beforeEach } from "vitest";
import { ConnectionStatusStore, getModuleConnectionStatus } from "../moduleConnectionStatus.js";

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

describe("ConnectionStatusStore", () => {
  let store: ConnectionStatusStore;

  beforeEach(() => {
    store = new ConnectionStatusStore();
  });

  it("returns null for unknown module", () => {
    expect(store.get("binance")).toBeNull();
  });

  it("tracks connect", () => {
    store.connect("binance", "2026-01-01T00:00:00Z");
    const state = store.get("binance")!;
    expect(state.connected).toBe(true);
    expect(state.last_connected_at).toBe("2026-01-01T00:00:00Z");
  });

  it("tracks disconnect", () => {
    store.connect("binance", "2026-01-01T00:00:00Z");
    store.disconnect("binance", "2026-01-01T01:00:00Z");
    const state = store.get("binance")!;
    expect(state.connected).toBe(false);
    expect(state.last_disconnected_at).toBe("2026-01-01T01:00:00Z");
  });

  it("tracks reconnect count", () => {
    store.recordReconnect("binance", "2026-01-01T00:00:00Z");
    store.recordReconnect("binance", "2026-01-01T01:00:00Z");
    const state = store.get("binance")!;
    expect(state.reconnect_count).toBe(2);
    expect(state.connected).toBe(true);
  });

  it("tracks latency", () => {
    store.recordLatency("binance", 42);
    const state = store.get("binance")!;
    expect(state.latency_ms).toBe(42);
  });

  it("sets default endpoint_url for known modules", () => {
    store.connect("binance");
    const state = store.get("binance")!;
    expect(state.endpoint_url).toContain("binance");
  });

  it("clear removes all states", () => {
    store.connect("binance");
    store.connect("coinbase");
    store.clear();
    expect(store.get("binance")).toBeNull();
    expect(store.get("coinbase")).toBeNull();
  });
});

describe("GET /api/modules/:name/connection-status", () => {
  let store: ConnectionStatusStore;

  beforeEach(() => {
    store = new ConnectionStatusStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleConnectionStatus({ connectionStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("nonexistent"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns default state for known module with no data", () => {
    const handler = getModuleConnectionStatus({ connectionStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.connected).toBe(false);
    expect(body.last_connected_at).toBeNull();
    expect(body.last_disconnected_at).toBeNull();
    expect(body.reconnect_count).toBe(0);
    expect(body.latency_ms).toBeNull();
    expect(body.endpoint_url).toContain("binance");
  });

  it("returns all expected fields", () => {
    const handler = getModuleConnectionStatus({ connectionStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body).toHaveProperty("module");
    expect(body).toHaveProperty("connected");
    expect(body).toHaveProperty("last_connected_at");
    expect(body).toHaveProperty("last_disconnected_at");
    expect(body).toHaveProperty("reconnect_count");
    expect(body).toHaveProperty("latency_ms");
    expect(body).toHaveProperty("endpoint_url");
  });

  it("reflects connected state from store", () => {
    store.connect("binance", "2026-02-01T12:00:00Z");
    const handler = getModuleConnectionStatus({ connectionStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().connected).toBe(true);
    expect(getBody().last_connected_at).toBe("2026-02-01T12:00:00Z");
  });

  it("reflects disconnected state from store", () => {
    store.connect("binance", "2026-02-01T12:00:00Z");
    store.disconnect("binance", "2026-02-01T13:00:00Z");
    const handler = getModuleConnectionStatus({ connectionStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().connected).toBe(false);
    expect(getBody().last_disconnected_at).toBe("2026-02-01T13:00:00Z");
  });

  it("reflects reconnect count from store", () => {
    store.recordReconnect("coinbase");
    store.recordReconnect("coinbase");
    store.recordReconnect("coinbase");
    const handler = getModuleConnectionStatus({ connectionStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    expect(getBody().reconnect_count).toBe(3);
  });

  it("reflects latency from store", () => {
    store.recordLatency("bybit", 15);
    const handler = getModuleConnectionStatus({ connectionStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().latency_ms).toBe(15);
  });

  it("returns endpoint_url for each module type", () => {
    const handler = getModuleConnectionStatus({ connectionStore: store });

    for (const mod of ["binance", "coinbase", "kalshi", "polymarket", "uniswap-base"]) {
      const { res, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(typeof getBody().endpoint_url).toBe("string");
      expect(getBody().endpoint_url).not.toBe("unknown");
    }
  });
});
