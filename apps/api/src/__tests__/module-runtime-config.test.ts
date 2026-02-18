import { describe, it, expect } from "vitest";
import { getModuleRuntimeConfig } from "../moduleRuntimeConfig.js";

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

const LOADED_AT = "2025-01-01T00:00:00.000Z";

describe("GET /api/modules/:name/config (runtime config)", () => {
  const envOverride: Record<string, string> = {
    NATS_URL: "nats://localhost:4222",
    DATABASE_URL: "postgres://user:pass@localhost:5432/feed",
    FEED_INTERNAL_TOKEN: "super-secret-token-123",
    BINANCE_WS_URL: "wss://stream.binance.com:9443/ws",
    KALSHI_API_KEY: "kalshi-secret-key-abc",
  };

  function makeDeps(disabled: string[] = []) {
    return {
      disabledModules: new Set(disabled),
      loadedAt: LOADED_AT,
      envOverride,
    };
  }

  it("returns 404 for unknown module", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("unknown-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("returns 404 for empty module name", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getStatus } = makeRes();
    handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape for valid module", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body).toHaveProperty("module", "binance");
    expect(body).toHaveProperty("disabled");
    expect(body).toHaveProperty("loaded_at", LOADED_AT);
    expect(body).toHaveProperty("config");
    expect(Array.isArray(body.config)).toBe(true);
  });

  it("each config entry has key, value, source, sensitive", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    for (const entry of getBody().config) {
      expect(entry).toHaveProperty("key");
      expect(entry).toHaveProperty("value");
      expect(entry).toHaveProperty("source");
      expect(entry).toHaveProperty("sensitive");
      expect(["env", "default"]).toContain(entry.source);
      expect(typeof entry.sensitive).toBe("boolean");
    }
  });

  it("redacts sensitive env vars (TOKEN, KEY)", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const tokenEntry = getBody().config.find((e: any) => e.key === "FEED_INTERNAL_TOKEN");
    expect(tokenEntry).toBeDefined();
    expect(tokenEntry.value).toBe("***");
    expect(tokenEntry.sensitive).toBe(true);
  });

  it("redacts KALSHI_API_KEY", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    const keyEntry = getBody().config.find((e: any) => e.key === "KALSHI_API_KEY");
    expect(keyEntry).toBeDefined();
    expect(keyEntry.value).toBe("***");
    expect(keyEntry.sensitive).toBe(true);
  });

  it("does not redact non-sensitive env vars", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const natsEntry = getBody().config.find((e: any) => e.key === "NATS_URL");
    expect(natsEntry).toBeDefined();
    expect(natsEntry.value).toBe("nats://localhost:4222");
    expect(natsEntry.sensitive).toBe(false);
  });

  it("shows source as env when var is in environment", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const natsEntry = getBody().config.find((e: any) => e.key === "NATS_URL");
    expect(natsEntry.source).toBe("env");
  });

  it("shows source as default when var is not in environment", () => {
    const handler = getModuleRuntimeConfig({
      disabledModules: new Set(),
      loadedAt: LOADED_AT,
      envOverride: {},
    });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const wsEntry = getBody().config.find((e: any) => e.key === "BINANCE_WS_URL");
    expect(wsEntry).toBeDefined();
    expect(wsEntry.source).toBe("default");
    expect(wsEntry.value).toBe("wss://stream.binance.com:9443/ws");
  });

  it("shows disabled=true for disabled module", () => {
    const handler = getModuleRuntimeConfig(makeDeps(["binance"]));
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().disabled).toBe(true);
  });

  it("shows disabled=false for enabled module", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    expect(getBody().disabled).toBe(false);
  });

  it("returns config for all 10 known modules", () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const handler = getModuleRuntimeConfig(makeDeps());
    for (const mod of modules) {
      const { res, getStatus, getBody } = makeRes();
      handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
      expect(Array.isArray(getBody().config)).toBe(true);
    }
  });

  it("dex modules include BASE_RPC_URL but not FEED_INTERNAL_TOKEN", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("aerodrome-base"), res);
    const keys = getBody().config.map((e: any) => e.key);
    expect(keys).toContain("BASE_RPC_URL");
    expect(keys).not.toContain("FEED_INTERNAL_TOKEN");
  });

  it("DATABASE_URL is redacted (contains sensitive pattern)", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const dbEntry = getBody().config.find((e: any) => e.key === "DATABASE_URL");
    expect(dbEntry).toBeDefined();
    expect(dbEntry.value).not.toContain("postgres://");
  });

  it("empty string value for missing env var with no default", () => {
    const handler = getModuleRuntimeConfig({
      disabledModules: new Set(),
      loadedAt: LOADED_AT,
      envOverride: {},
    });
    const { res, getBody } = makeRes();
    handler(makeReq("aerodrome-base"), res);
    const rpcEntry = getBody().config.find((e: any) => e.key === "BASE_RPC_URL");
    expect(rpcEntry).toBeDefined();
    expect(rpcEntry.value).toBe("");
    expect(rpcEntry.source).toBe("default");
  });

  it("loaded_at timestamp matches what was passed in deps", () => {
    const handler = getModuleRuntimeConfig(makeDeps());
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    expect(getBody().loaded_at).toBe(LOADED_AT);
  });
});
