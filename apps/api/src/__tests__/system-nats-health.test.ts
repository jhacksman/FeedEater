import { describe, it, expect, beforeEach } from "vitest";
import { NatsHealthStore, getSystemNatsHealth } from "../systemNatsHealth.js";

function makeReq() {
  return {} as any;
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

describe("NatsHealthStore", () => {
  let store: NatsHealthStore;

  beforeEach(() => {
    store = new NatsHealthStore();
  });

  it("starts with default disconnected state", () => {
    const state = store.getState();
    expect(state.connected).toBe(false);
    expect(state.server_url).toBeNull();
    expect(state.client_id).toBeNull();
    expect(state.subscriptions_count).toBe(0);
    expect(state.messages_published_total).toBe(0);
    expect(state.messages_received_total).toBe(0);
    expect(state.last_connected_at).toBeNull();
    expect(state.reconnect_count).toBe(0);
    expect(Object.keys(state.subjects)).toEqual([]);
  });

  it("setConnected updates connected and last_connected_at", () => {
    store.setConnected(true, "2026-01-01T00:00:00Z");
    const state = store.getState();
    expect(state.connected).toBe(true);
    expect(state.last_connected_at).toBe("2026-01-01T00:00:00Z");
  });

  it("setConnected(false) does not update last_connected_at", () => {
    store.setConnected(true, "2026-01-01T00:00:00Z");
    store.setConnected(false);
    const state = store.getState();
    expect(state.connected).toBe(false);
    expect(state.last_connected_at).toBe("2026-01-01T00:00:00Z");
  });

  it("setServerUrl and setClientId", () => {
    store.setServerUrl("nats://localhost:4222");
    store.setClientId("client-1");
    const state = store.getState();
    expect(state.server_url).toBe("nats://localhost:4222");
    expect(state.client_id).toBe("client-1");
  });

  it("setSubscriptionsCount updates count", () => {
    store.setSubscriptionsCount(5);
    expect(store.getState().subscriptions_count).toBe(5);
  });

  it("recordPublish increments total and tracks subject", () => {
    store.recordPublish("feedeater.data.binance", "2026-01-01T00:00:00Z");
    store.recordPublish("feedeater.data.binance", "2026-01-01T00:01:00Z");
    store.recordPublish("feedeater.control.restart.binance", "2026-01-01T00:02:00Z");
    const state = store.getState();
    expect(state.messages_published_total).toBe(3);
    expect(state.subjects["feedeater.data.binance"].publish_count).toBe(2);
    expect(state.subjects["feedeater.data.binance"].last_published_at).toBe("2026-01-01T00:01:00Z");
    expect(state.subjects["feedeater.control.restart.binance"].publish_count).toBe(1);
  });

  it("recordReceive increments total", () => {
    store.recordReceive();
    store.recordReceive();
    expect(store.getState().messages_received_total).toBe(2);
  });

  it("recordReconnect increments count and sets connected", () => {
    store.recordReconnect("2026-01-01T00:05:00Z");
    const state = store.getState();
    expect(state.reconnect_count).toBe(1);
    expect(state.connected).toBe(true);
    expect(state.last_connected_at).toBe("2026-01-01T00:05:00Z");
  });

  it("clear resets all state", () => {
    store.setConnected(true);
    store.setServerUrl("nats://localhost:4222");
    store.setClientId("client-1");
    store.setSubscriptionsCount(3);
    store.recordPublish("test.subject");
    store.recordReceive();
    store.recordReconnect();
    store.clear();
    const state = store.getState();
    expect(state.connected).toBe(false);
    expect(state.server_url).toBeNull();
    expect(state.messages_published_total).toBe(0);
    expect(state.reconnect_count).toBe(0);
    expect(Object.keys(state.subjects)).toEqual([]);
  });

  it("getState returns copies of subject stats", () => {
    store.recordPublish("test.subject", "2026-01-01T00:00:00Z");
    const state1 = store.getState();
    state1.subjects["test.subject"].publish_count = 999;
    const state2 = store.getState();
    expect(state2.subjects["test.subject"].publish_count).toBe(1);
  });
});

describe("GET /api/system/nats-health", () => {
  let store: NatsHealthStore;
  const fixedNow = 120_000;

  beforeEach(() => {
    store = new NatsHealthStore();
  });

  it("returns correct response shape", () => {
    const handler = getSystemNatsHealth({ natsHealthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("connected");
    expect(body).toHaveProperty("server_url");
    expect(body).toHaveProperty("client_id");
    expect(body).toHaveProperty("subscriptions_count");
    expect(body).toHaveProperty("messages_published_total");
    expect(body).toHaveProperty("messages_received_total");
    expect(body).toHaveProperty("last_connected_at");
    expect(body).toHaveProperty("reconnect_count");
    expect(body).toHaveProperty("subjects");
    expect(body).toHaveProperty("checked_at");
  });

  it("returns default disconnected state", () => {
    const handler = getSystemNatsHealth({ natsHealthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().connected).toBe(false);
    expect(getBody().messages_published_total).toBe(0);
  });

  it("reflects store state", () => {
    store.setConnected(true, "2026-01-01T00:00:00Z");
    store.setServerUrl("nats://prod:4222");
    store.recordPublish("feedeater.data.binance", "2026-01-01T00:01:00Z");
    const handler = getSystemNatsHealth({ natsHealthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.connected).toBe(true);
    expect(body.server_url).toBe("nats://prod:4222");
    expect(body.messages_published_total).toBe(1);
    expect(body.subjects["feedeater.data.binance"].publish_count).toBe(1);
  });

  it("returns checked_at as ISO timestamp", () => {
    const handler = getSystemNatsHealth({ natsHealthStore: store, nowFn: () => fixedNow });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const d = new Date(getBody().checked_at);
    expect(isNaN(d.getTime())).toBe(false);
  });
});
