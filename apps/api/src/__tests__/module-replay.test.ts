import { describe, it, expect, beforeEach } from "vitest";
import { SnapshotStore } from "../moduleSnapshot.js";
import { postModuleReplay } from "../moduleReplay.js";

function makeReq(name: string, body: Record<string, unknown> = {}) {
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

function makeNats() {
  const published: { subject: string; data: string }[] = [];
  const sc = { encode: (s: string) => s, decode: (s: string) => s } as any;
  const nc = { publish: (subject: string, data: string) => { published.push({ subject, data }); } } as any;
  const getNatsConn = async () => nc;
  return { published, sc, getNatsConn };
}

describe("POST /api/modules/:name/replay", () => {
  let store: SnapshotStore;
  let tick: number;

  beforeEach(() => {
    tick = 1000;
    store = new SnapshotStore(() => tick++);
  });

  it("returns 404 for unknown module", async () => {
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", async () => {
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getStatus } = makeRes();
    await handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape with dry_run default", async () => {
    store.record("binance", "feedeater.binance.messageCreated", { price: 100 });
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    await handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("replayed", 1);
    expect(body).toHaveProperty("dry_run", true);
    expect(body).toHaveProperty("started_at");
  });

  it("dry_run defaults to true", async () => {
    store.record("coinbase", "feedeater.coinbase.messageCreated", { price: 100 });
    const { sc, getNatsConn, published } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    await handler(makeReq("coinbase"), res);
    expect(getBody().dry_run).toBe(true);
    expect(published).toHaveLength(0);
  });

  it("dry_run=true does not publish to NATS", async () => {
    store.record("bybit", "feedeater.bybit.messageCreated", { price: 200 });
    store.record("bybit", "feedeater.bybit.messageCreated", { price: 201 });
    const { sc, getNatsConn, published } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    await handler(makeReq("bybit", { dry_run: true }), res);
    expect(getBody().replayed).toBe(2);
    expect(published).toHaveLength(0);
  });

  it("dry_run=false publishes messages to NATS", async () => {
    store.record("gemini", "feedeater.gemini.messageCreated", { price: 300 });
    store.record("gemini", "feedeater.gemini.messageCreated", { price: 301 });
    const { sc, getNatsConn, published } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    await handler(makeReq("gemini", { dry_run: false }), res);
    expect(getBody().replayed).toBe(2);
    expect(getBody().dry_run).toBe(false);
    expect(published).toHaveLength(2);
    expect(published[0].subject).toBe("feedeater.gemini.messageCreated");
  });

  it("defaults to limit 50", async () => {
    for (let i = 0; i < 70; i++) {
      store.record("okx", "feedeater.okx.messageCreated", { i });
    }
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    await handler(makeReq("okx"), res);
    expect(getBody().replayed).toBe(50);
  });

  it("respects limit in body", async () => {
    for (let i = 0; i < 20; i++) {
      store.record("kalshi", "feedeater.kalshi.messageCreated", { i });
    }
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    await handler(makeReq("kalshi", { limit: 5 }), res);
    expect(getBody().replayed).toBe(5);
  });

  it("returns 400 if limit exceeds 500", async () => {
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("binance", { limit: 501 }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toMatch(/500/);
  });

  it("returns 400 for invalid limit", async () => {
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });

    const { res: r1, getStatus: gs1 } = makeRes();
    await handler(makeReq("binance", { limit: "abc" }), r1);
    expect(gs1()).toBe(400);

    const { res: r2, getStatus: gs2 } = makeRes();
    await handler(makeReq("binance", { limit: 0 }), r2);
    expect(gs2()).toBe(400);

    const { res: r3, getStatus: gs3 } = makeRes();
    await handler(makeReq("binance", { limit: -5 }), r3);
    expect(gs3()).toBe(400);

    const { res: r4, getStatus: gs4 } = makeRes();
    await handler(makeReq("binance", { limit: 2.5 }), r4);
    expect(gs4()).toBe(400);
  });

  it("returns 0 replayed when no messages stored", async () => {
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getBody } = makeRes();
    await handler(makeReq("bitstamp"), res);
    expect(getBody().replayed).toBe(0);
  });

  it("started_at is ISO string", async () => {
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 1700000000000 });
    const { res, getBody } = makeRes();
    await handler(makeReq("polymarket"), res);
    expect(getBody().started_at).toBe(new Date(1700000000000).toISOString());
  });

  it("returns 500 on NATS failure in non-dry_run", async () => {
    store.record("binance", "feedeater.binance.messageCreated", { x: 1 });
    const sc = { encode: (s: string) => s } as any;
    const getNatsConn = async () => { throw new Error("NATS down"); };
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("binance", { dry_run: false }), res);
    expect(getStatus()).toBe(500);
    expect(getBody().error).toMatch(/NATS/);
  });

  it("modules are isolated", async () => {
    store.record("binance", "feedeater.binance.messageCreated", { a: 1 });
    store.record("coinbase", "feedeater.coinbase.messageCreated", { b: 2 });
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });

    const { res: r1, getBody: gb1 } = makeRes();
    await handler(makeReq("binance"), r1);
    expect(gb1().replayed).toBe(1);

    const { res: r2, getBody: gb2 } = makeRes();
    await handler(makeReq("coinbase"), r2);
    expect(gb2().replayed).toBe(1);
  });

  it("works for all known modules", async () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const { sc, getNatsConn } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      await handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });

  it("publishes correct data for each message", async () => {
    store.record("bitstamp", "feedeater.bitstamp.messageCreated", { price: 1 });
    store.record("bitstamp", "feedeater.bitstamp.messageCreated", { price: 2 });
    const { sc, getNatsConn, published } = makeNats();
    const handler = postModuleReplay({ snapshotStore: store, getNatsConn, sc, nowFn: () => 5000 });
    const { res } = makeRes();
    await handler(makeReq("bitstamp", { dry_run: false }), res);
    expect(published).toHaveLength(2);
    expect(JSON.parse(published[0].data)).toEqual({ price: 1 });
    expect(JSON.parse(published[1].data)).toEqual({ price: 2 });
  });
});
