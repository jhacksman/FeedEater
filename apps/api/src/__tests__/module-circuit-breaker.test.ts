import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreakerStore, getModuleCircuitBreaker } from "../moduleCircuitBreaker.js";

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

describe("CircuitBreakerStore", () => {
  let store: CircuitBreakerStore;

  beforeEach(() => {
    store = new CircuitBreakerStore();
  });

  it("returns null for unconfigured module", () => {
    expect(store.get("binance")).toBeNull();
  });

  it("configure creates closed breaker with defaults", () => {
    store.configure("binance");
    const cb = store.get("binance")!;
    expect(cb.state).toBe("closed");
    expect(cb.trip_count).toBe(0);
    expect(cb.last_tripped_at).toBeNull();
    expect(cb.last_recovered_at).toBeNull();
    expect(cb.failure_threshold).toBe(5);
    expect(cb.recovery_timeout_seconds).toBe(30);
  });

  it("configure accepts custom thresholds", () => {
    store.configure("binance", 10, 60);
    const cb = store.get("binance")!;
    expect(cb.failure_threshold).toBe(10);
    expect(cb.recovery_timeout_seconds).toBe(60);
  });

  it("trip sets state to open and increments trip_count", () => {
    store.configure("binance");
    store.trip("binance", "2026-01-01T00:00:00Z");
    const cb = store.get("binance")!;
    expect(cb.state).toBe("open");
    expect(cb.trip_count).toBe(1);
    expect(cb.last_tripped_at).toBe("2026-01-01T00:00:00Z");
  });

  it("multiple trips increment trip_count", () => {
    store.configure("binance");
    store.trip("binance", "2026-01-01T00:00:00Z");
    store.trip("binance", "2026-01-01T00:01:00Z");
    expect(store.get("binance")!.trip_count).toBe(2);
  });

  it("halfOpen sets state to half-open", () => {
    store.configure("binance");
    store.trip("binance");
    store.halfOpen("binance");
    expect(store.get("binance")!.state).toBe("half-open");
  });

  it("recover sets state to closed", () => {
    store.configure("binance");
    store.trip("binance");
    store.recover("binance", "2026-01-01T00:05:00Z");
    const cb = store.get("binance")!;
    expect(cb.state).toBe("closed");
    expect(cb.last_recovered_at).toBe("2026-01-01T00:05:00Z");
  });

  it("trip/halfOpen/recover are no-ops for unconfigured module", () => {
    store.trip("binance");
    store.halfOpen("binance");
    store.recover("binance");
    expect(store.get("binance")).toBeNull();
  });

  it("clear removes all breakers", () => {
    store.configure("binance");
    store.configure("coinbase");
    store.clear();
    expect(store.get("binance")).toBeNull();
    expect(store.get("coinbase")).toBeNull();
  });
});

describe("GET /api/modules/:name/circuit-breaker", () => {
  let store: CircuitBreakerStore;

  beforeEach(() => {
    store = new CircuitBreakerStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleCircuitBreaker({ circuitStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("nonexistent"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns circuit_breaker: null when not configured", () => {
    const handler = getModuleCircuitBreaker({ circuitStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.circuit_breaker).toBeNull();
  });

  it("returns full circuit breaker state when configured", () => {
    store.configure("binance");
    const handler = getModuleCircuitBreaker({ circuitStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const cb = getBody().circuit_breaker;
    expect(cb.state).toBe("closed");
    expect(cb.trip_count).toBe(0);
    expect(cb.last_tripped_at).toBeNull();
    expect(cb.last_recovered_at).toBeNull();
    expect(cb.failure_threshold).toBe(5);
    expect(cb.recovery_timeout_seconds).toBe(30);
  });

  it("reflects tripped state", () => {
    store.configure("coinbase");
    store.trip("coinbase", "2026-02-01T00:00:00Z");
    const handler = getModuleCircuitBreaker({ circuitStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const cb = getBody().circuit_breaker;
    expect(cb.state).toBe("open");
    expect(cb.trip_count).toBe(1);
    expect(cb.last_tripped_at).toBe("2026-02-01T00:00:00Z");
  });

  it("reflects half-open state", () => {
    store.configure("bybit");
    store.trip("bybit");
    store.halfOpen("bybit");
    const handler = getModuleCircuitBreaker({ circuitStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("bybit"), res);
    expect(getBody().circuit_breaker.state).toBe("half-open");
  });

  it("reflects recovered state", () => {
    store.configure("gemini");
    store.trip("gemini");
    store.recover("gemini", "2026-03-01T00:00:00Z");
    const handler = getModuleCircuitBreaker({ circuitStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("gemini"), res);
    const cb = getBody().circuit_breaker;
    expect(cb.state).toBe("closed");
    expect(cb.last_recovered_at).toBe("2026-03-01T00:00:00Z");
    expect(cb.trip_count).toBe(1);
  });
});
