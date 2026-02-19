import { describe, it, expect, beforeEach } from "vitest";
import { ReconnectTracker, postModuleReconnect } from "../moduleReconnect.js";

function makeReq(name: string) {
  return { params: { name }, headers: {} } as any;
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

function makeMockNats() {
  const published: Array<{ subject: string; data: string }> = [];
  const nc = {
    publish(subject: string, data: Uint8Array) {
      published.push({ subject, data: new TextDecoder().decode(data) });
    },
  };
  const getNatsConn = async () => nc as any;
  const sc = { encode: (s: string) => new TextEncoder().encode(s) } as any;
  return { getNatsConn, sc, published };
}

describe("ReconnectTracker", () => {
  let tracker: ReconnectTracker;

  beforeEach(() => {
    tracker = new ReconnectTracker();
  });

  it("returns unknown for untracked module", () => {
    expect(tracker.getState("binance")).toBe("unknown");
  });

  it("sets and gets state", () => {
    tracker.setState("binance", "connected");
    expect(tracker.getState("binance")).toBe("connected");
  });

  it("tracks reconnecting state", () => {
    tracker.markReconnecting("binance");
    expect(tracker.isReconnecting("binance")).toBe(true);
    expect(tracker.getState("binance")).toBe("reconnecting");
  });

  it("clears reconnecting flag", () => {
    tracker.markReconnecting("binance");
    tracker.clearReconnecting("binance");
    expect(tracker.isReconnecting("binance")).toBe(false);
  });

  it("setState clears pending when not reconnecting", () => {
    tracker.markReconnecting("binance");
    tracker.setState("binance", "connected");
    expect(tracker.isReconnecting("binance")).toBe(false);
  });

  it("clear resets all state", () => {
    tracker.setState("binance", "connected");
    tracker.markReconnecting("coinbase");
    tracker.clear();
    expect(tracker.getState("binance")).toBe("unknown");
    expect(tracker.isReconnecting("coinbase")).toBe(false);
  });
});

describe("POST /api/modules/:name/reconnect", () => {
  let tracker: ReconnectTracker;

  beforeEach(() => {
    tracker = new ReconnectTracker();
  });

  it("returns 404 for unknown module", async () => {
    const { getNatsConn, sc } = makeMockNats();
    const handler = postModuleReconnect({ getNatsConn, sc, tracker });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("nonexistent"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 409 if module is already reconnecting", async () => {
    tracker.markReconnecting("binance");
    const { getNatsConn, sc } = makeMockNats();
    const handler = postModuleReconnect({ getNatsConn, sc, tracker });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("binance"), res);
    expect(getStatus()).toBe(409);
    expect(getBody().error).toContain("already reconnecting");
  });

  it("returns success response with all fields", async () => {
    const { getNatsConn, sc } = makeMockNats();
    const fixedTime = new Date("2026-03-01T00:00:00Z").getTime();
    const handler = postModuleReconnect({ getNatsConn, sc, tracker, nowFn: () => fixedTime });
    const { res, getBody } = makeRes();
    await handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.reconnect_triggered).toBe(true);
    expect(body.previous_state).toBe("unknown");
    expect(body.triggered_at).toBe("2026-03-01T00:00:00.000Z");
  });

  it("returns previous_state from tracker", async () => {
    tracker.setState("coinbase", "connected");
    const { getNatsConn, sc } = makeMockNats();
    const handler = postModuleReconnect({ getNatsConn, sc, tracker });
    const { res, getBody } = makeRes();
    await handler(makeReq("coinbase"), res);
    expect(getBody().previous_state).toBe("connected");
  });

  it("publishes to correct NATS subject", async () => {
    const { getNatsConn, sc, published } = makeMockNats();
    const handler = postModuleReconnect({ getNatsConn, sc, tracker });
    const { res } = makeRes();
    await handler(makeReq("bybit"), res);
    expect(published.length).toBe(1);
    expect(published[0].subject).toBe("feedeater.control.reconnect.bybit");
  });

  it("publishes payload with correct fields", async () => {
    const { getNatsConn, sc, published } = makeMockNats();
    const handler = postModuleReconnect({ getNatsConn, sc, tracker });
    const { res } = makeRes();
    await handler(makeReq("gemini"), res);
    const payload = JSON.parse(published[0].data);
    expect(payload.module).toBe("gemini");
    expect(payload.action).toBe("reconnect");
    expect(payload).toHaveProperty("timestamp");
  });

  it("marks module as reconnecting after success", async () => {
    const { getNatsConn, sc } = makeMockNats();
    const handler = postModuleReconnect({ getNatsConn, sc, tracker });
    const { res } = makeRes();
    await handler(makeReq("binance"), res);
    expect(tracker.isReconnecting("binance")).toBe(true);
  });

  it("returns 500 if NATS publish fails", async () => {
    const getNatsConn = async () => { throw new Error("NATS down"); };
    const sc = { encode: (s: string) => new TextEncoder().encode(s) } as any;
    const handler = postModuleReconnect({ getNatsConn, sc, tracker });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("binance"), res);
    expect(getStatus()).toBe(500);
    expect(getBody().error).toBe("NATS down");
  });

  it("does not mark reconnecting on NATS failure", async () => {
    const getNatsConn = async () => { throw new Error("NATS down"); };
    const sc = { encode: (s: string) => new TextEncoder().encode(s) } as any;
    const handler = postModuleReconnect({ getNatsConn, sc, tracker });
    const { res } = makeRes();
    await handler(makeReq("binance"), res);
    expect(tracker.isReconnecting("binance")).toBe(false);
  });
});
