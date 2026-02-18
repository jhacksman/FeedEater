import { describe, it, expect, beforeEach } from "vitest";
import { getPipelineStatus } from "../pipelineStatus.js";
import { StalenessTracker } from "../staleness.js";
import { ModuleMetricsStore } from "../moduleMetrics.js";

function makeRes() {
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: any) { body = data; },
  } as any;
  return { res, getStatus: () => statusCode, getBody: () => body };
}

const ALL_MODULES = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "uniswap-base", "aerodrome-base", "kalshi", "polymarket"];

describe("GET /api/pipeline/status", () => {
  let now: number;
  let stalenessTracker: StalenessTracker;
  let metricsStore: ModuleMetricsStore;
  let disabledModules: Set<string>;
  let getNatsConn: () => Promise<any>;
  let checkPostgres: () => Promise<boolean>;

  beforeEach(() => {
    now = 1700000000000;
    stalenessTracker = new StalenessTracker(() => now);
    metricsStore = new ModuleMetricsStore(() => now);
    disabledModules = new Set();
    getNatsConn = async () => ({});
    checkPostgres = async () => true;
  });

  function makeDeps() {
    return { stalenessTracker, metricsStore, disabledModules, getNatsConn, checkPostgres };
  }

  it("returns all 10 modules in pipeline", async () => {
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    expect(getBody().modules).toHaveLength(10);
  });

  it("response has correct top-level shape", async () => {
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    const body = getBody();
    expect(body).toHaveProperty("health");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("modules");
    expect(body).toHaveProperty("infrastructure");
    expect(body).toHaveProperty("latency_estimate_ms");
  });

  it("each module has correct shape", async () => {
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    for (const m of getBody().modules) {
      expect(m).toHaveProperty("name");
      expect(m).toHaveProperty("type");
      expect(m).toHaveProperty("status");
      expect(m).toHaveProperty("upstream");
      expect(m).toHaveProperty("downstream");
      expect(m).toHaveProperty("throughput");
      expect(Array.isArray(m.upstream)).toBe(true);
      expect(Array.isArray(m.downstream)).toBe(true);
    }
  });

  it("module types are cex, dex, or prediction", async () => {
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    for (const m of getBody().modules) {
      expect(["cex", "dex", "prediction"]).toContain(m.type);
    }
  });

  it("module status values are active, inactive, stale, or error", async () => {
    for (const mod of ALL_MODULES) {
      metricsStore.recordMessage(mod);
      stalenessTracker.updateModuleSeen(mod);
    }
    disabledModules.add("okx");
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    for (const m of getBody().modules) {
      expect(["active", "inactive", "stale", "error"]).toContain(m.status);
    }
  });

  it("shows healthy when all enabled modules are active", async () => {
    for (const mod of ALL_MODULES) {
      metricsStore.recordMessage(mod);
      stalenessTracker.updateModuleSeen(mod);
    }
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    expect(getBody().health).toBe("healthy");
  });

  it("shows degraded when some modules are stale", async () => {
    for (const mod of ALL_MODULES) {
      metricsStore.recordMessage(mod);
      stalenessTracker.updateModuleSeen(mod);
    }
    now += 120_000;
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    expect(getBody().health).toBe("degraded");
  });

  it("shows down when NATS is disconnected", async () => {
    getNatsConn = async () => { throw new Error("NATS down"); };
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    expect(getBody().health).toBe("down");
    expect(getBody().infrastructure.nats.connected).toBe(false);
  });

  it("shows down when Postgres is disconnected", async () => {
    checkPostgres = async () => false;
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    expect(getBody().health).toBe("down");
    expect(getBody().infrastructure.postgres.connected).toBe(false);
  });

  it("shows inactive status for disabled modules", async () => {
    disabledModules.add("binance");
    metricsStore.recordMessage("binance");
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    const binance = getBody().modules.find((m: any) => m.name === "binance");
    expect(binance.status).toBe("inactive");
  });

  it("shows active status for module with messages", async () => {
    metricsStore.recordMessage("coinbase");
    stalenessTracker.updateModuleSeen("coinbase");
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    const coinbase = getBody().modules.find((m: any) => m.name === "coinbase");
    expect(coinbase.status).toBe("active");
  });

  it("infrastructure shows nats and postgres status", async () => {
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    const infra = getBody().infrastructure;
    expect(infra.nats).toHaveProperty("connected");
    expect(infra.postgres).toHaveProperty("connected");
    expect(typeof infra.nats.connected).toBe("boolean");
    expect(typeof infra.postgres.connected).toBe("boolean");
  });

  it("latency_estimate_ms is null when no latency data", async () => {
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    expect(getBody().latency_estimate_ms).toBeNull();
  });

  it("latency_estimate_ms computes average across modules", async () => {
    metricsStore.recordMessage("binance", 10);
    metricsStore.recordMessage("coinbase", 20);
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    expect(getBody().latency_estimate_ms).toBe(15);
  });

  it("throughput includes message_rate, total_messages, last_message_at", async () => {
    metricsStore.recordMessage("bybit");
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    const bybit = getBody().modules.find((m: any) => m.name === "bybit");
    expect(bybit.throughput).toHaveProperty("message_rate");
    expect(bybit.throughput).toHaveProperty("total_messages");
    expect(bybit.throughput).toHaveProperty("last_message_at");
    expect(bybit.throughput.total_messages).toBe(1);
  });

  it("each module has upstream and downstream arrays", async () => {
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    for (const m of getBody().modules) {
      expect(m.upstream.length).toBeGreaterThan(0);
      expect(m.downstream.length).toBeGreaterThan(0);
    }
  });

  it("dex modules have base-rpc as upstream", async () => {
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    const dexModules = getBody().modules.filter((m: any) => m.type === "dex");
    for (const m of dexModules) {
      expect(m.upstream).toContain("base-rpc");
    }
  });

  it("all modules have nats and postgres as downstream", async () => {
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    for (const m of getBody().modules) {
      expect(m.downstream).toContain("nats");
      expect(m.downstream).toContain("postgres");
    }
  });

  it("shows down when all modules disabled", async () => {
    for (const mod of ALL_MODULES) disabledModules.add(mod);
    const handler = getPipelineStatus(makeDeps());
    const { res, getBody } = makeRes();
    await handler({} as any, res);
    expect(getBody().health).toBe("down");
  });
});
