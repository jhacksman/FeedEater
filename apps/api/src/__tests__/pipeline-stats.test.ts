import { describe, it, expect, beforeEach } from "vitest";
import { PipelineStatsStore, getModulePipelineStats } from "../pipelineStats.js";

function makeReq(name: string) {
  return { params: { name }, query: {} } as any;
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

describe("PipelineStatsStore", () => {
  let store: PipelineStatsStore;

  beforeEach(() => {
    store = new PipelineStatsStore();
  });

  it("returns null for unknown module", () => {
    expect(store.getStats("unknown")).toBeNull();
  });

  it("recordIn increments messages_in", () => {
    store.recordIn("binance");
    store.recordIn("binance");
    const stats = store.getStats("binance")!;
    expect(stats.messages_in).toBe(2);
    expect(stats.messages_out).toBe(0);
  });

  it("recordOut increments messages_out and sets last_processed_at", () => {
    store.recordOut("coinbase", 15);
    const stats = store.getStats("coinbase")!;
    expect(stats.messages_out).toBe(1);
    expect(stats.last_processed_at).toBeDefined();
  });

  it("recordOut tracks processing time for average", () => {
    store.recordOut("okx", 10);
    store.recordOut("okx", 20);
    store.recordOut("okx", 30);
    const stats = store.getStats("okx")!;
    expect(stats.processing_time_avg_ms).toBe(20);
  });

  it("recordDrop increments messages_dropped", () => {
    store.recordDrop("bybit");
    store.recordDrop("bybit");
    store.recordDrop("bybit");
    const stats = store.getStats("bybit")!;
    expect(stats.messages_dropped).toBe(3);
  });

  it("recordBackpressure increments backpressure_events", () => {
    store.recordBackpressure("gemini");
    const stats = store.getStats("gemini")!;
    expect(stats.backpressure_events).toBe(1);
  });

  it("processing_time_avg_ms is null when no times recorded", () => {
    store.recordIn("bitstamp");
    const stats = store.getStats("bitstamp")!;
    expect(stats.processing_time_avg_ms).toBeNull();
  });

  it("reset removes module data", () => {
    store.recordIn("kalshi");
    expect(store.reset("kalshi")).toBe(true);
    expect(store.getStats("kalshi")).toBeNull();
  });

  it("reset returns false for unknown module", () => {
    expect(store.reset("nonexistent")).toBe(false);
  });

  it("tracks multiple modules independently", () => {
    store.recordIn("binance");
    store.recordIn("binance");
    store.recordIn("coinbase");
    expect(store.getStats("binance")!.messages_in).toBe(2);
    expect(store.getStats("coinbase")!.messages_in).toBe(1);
  });
});

describe("GET /api/modules/:name/pipeline-stats", () => {
  let store: PipelineStatsStore;

  beforeEach(() => {
    store = new PipelineStatsStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModulePipelineStats({ pipelineStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModulePipelineStats({ pipelineStore: store });
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns zeros when no data exists for known module", () => {
    const handler = getModulePipelineStats({ pipelineStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getStatus()).toBe(200);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.messages_in).toBe(0);
    expect(body.messages_out).toBe(0);
    expect(body.messages_dropped).toBe(0);
    expect(body.processing_time_avg_ms).toBeNull();
    expect(body.backpressure_events).toBe(0);
    expect(body.last_processed_at).toBeNull();
  });

  it("returns recorded stats for a module", () => {
    store.recordIn("coinbase");
    store.recordIn("coinbase");
    store.recordOut("coinbase", 10);
    store.recordOut("coinbase", 30);
    store.recordDrop("coinbase");
    store.recordBackpressure("coinbase");

    const handler = getModulePipelineStats({ pipelineStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.module).toBe("coinbase");
    expect(body.messages_in).toBe(2);
    expect(body.messages_out).toBe(2);
    expect(body.messages_dropped).toBe(1);
    expect(body.processing_time_avg_ms).toBe(20);
    expect(body.backpressure_events).toBe(1);
    expect(body.last_processed_at).toBeDefined();
  });

  it("includes all required response fields", () => {
    store.recordIn("okx");
    const handler = getModulePipelineStats({ pipelineStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("okx"), res);
    const body = getBody();
    expect(body).toHaveProperty("module");
    expect(body).toHaveProperty("messages_in");
    expect(body).toHaveProperty("messages_out");
    expect(body).toHaveProperty("messages_dropped");
    expect(body).toHaveProperty("processing_time_avg_ms");
    expect(body).toHaveProperty("backpressure_events");
    expect(body).toHaveProperty("last_processed_at");
  });

  it("works for multiple known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "okx", "kalshi", "polymarket"];
    const handler = getModulePipelineStats({ pipelineStore: store });
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
    }
  });
});
