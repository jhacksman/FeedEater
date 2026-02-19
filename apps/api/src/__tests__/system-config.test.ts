import { describe, it, expect, beforeEach } from "vitest";
import { RuntimeConfig, getSystemConfig, patchSystemConfig } from "../systemConfig.js";

function makeReq(body?: Record<string, unknown>) {
  return { body } as any;
}

function makeGetReq() {
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

const baseDeps = {
  natsUrl: "nats://localhost:4222",
  postgresEnabled: true,
  apiPort: 4000,
  version: "1.0.0",
};

describe("RuntimeConfig", () => {
  it("has sensible defaults", () => {
    const cfg = new RuntimeConfig();
    expect(cfg.logLevel).toBe("info");
    expect(cfg.rateLimitDefaults).toEqual({ window_ms: 60000, max_requests: 100 });
  });

  it("accepts custom values", () => {
    const cfg = new RuntimeConfig("debug", { window_ms: 30000, max_requests: 50 });
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.rateLimitDefaults).toEqual({ window_ms: 30000, max_requests: 50 });
  });
});

describe("GET /api/system/config", () => {
  let config: RuntimeConfig;

  beforeEach(() => {
    config = new RuntimeConfig();
  });

  it("returns all expected fields", () => {
    const handler = getSystemConfig({ runtimeConfig: config, ...baseDeps });
    const { res, getBody } = makeRes();
    handler(makeGetReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("nats_url");
    expect(body).toHaveProperty("postgres_enabled");
    expect(body).toHaveProperty("api_port");
    expect(body).toHaveProperty("rate_limit_defaults");
    expect(body).toHaveProperty("log_level");
    expect(body).toHaveProperty("module_count");
    expect(body).toHaveProperty("version");
  });

  it("returns correct static values", () => {
    const handler = getSystemConfig({ runtimeConfig: config, ...baseDeps });
    const { res, getBody } = makeRes();
    handler(makeGetReq(), res);
    const body = getBody();
    expect(body.nats_url).toBe("nats://localhost:4222");
    expect(body.postgres_enabled).toBe(true);
    expect(body.api_port).toBe(4000);
    expect(body.version).toBe("1.0.0");
  });

  it("returns current runtime config values", () => {
    config.logLevel = "debug";
    config.rateLimitDefaults = { window_ms: 30000, max_requests: 50 };
    const handler = getSystemConfig({ runtimeConfig: config, ...baseDeps });
    const { res, getBody } = makeRes();
    handler(makeGetReq(), res);
    expect(getBody().log_level).toBe("debug");
    expect(getBody().rate_limit_defaults).toEqual({ window_ms: 30000, max_requests: 50 });
  });

  it("module_count reflects KNOWN_MODULES size", () => {
    const handler = getSystemConfig({ runtimeConfig: config, ...baseDeps });
    const { res, getBody } = makeRes();
    handler(makeGetReq(), res);
    expect(typeof getBody().module_count).toBe("number");
    expect(getBody().module_count).toBeGreaterThan(0);
  });

  it("does not expose secrets", () => {
    const handler = getSystemConfig({ runtimeConfig: config, ...baseDeps });
    const { res, getBody } = makeRes();
    handler(makeGetReq(), res);
    const body = getBody();
    const json = JSON.stringify(body);
    expect(json).not.toContain("api_key");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("password");
    expect(json).not.toContain("DATABASE_URL");
  });
});

describe("PATCH /api/system/config", () => {
  let config: RuntimeConfig;

  beforeEach(() => {
    config = new RuntimeConfig();
  });

  it("updates log_level", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ log_level: "error" }), res);
    expect(getStatus()).toBe(200);
    expect(getBody().updated).toContain("log_level");
    expect(getBody().log_level).toBe("error");
    expect(config.logLevel).toBe("error");
  });

  it("updates rate_limit_defaults", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ rate_limit_defaults: { window_ms: 30000, max_requests: 200 } }), res);
    expect(getStatus()).toBe(200);
    expect(getBody().updated).toContain("rate_limit_defaults");
    expect(getBody().rate_limit_defaults).toEqual({ window_ms: 30000, max_requests: 200 });
  });

  it("updates both fields at once", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getBody } = makeRes();
    handler(makeReq({ log_level: "warn", rate_limit_defaults: { window_ms: 10000, max_requests: 50 } }), res);
    expect(getBody().updated).toContain("log_level");
    expect(getBody().updated).toContain("rate_limit_defaults");
    expect(getBody().log_level).toBe("warn");
    expect(getBody().rate_limit_defaults).toEqual({ window_ms: 10000, max_requests: 50 });
  });

  it("rejects invalid log_level", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ log_level: "fatal" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody()).toHaveProperty("error");
    expect(config.logLevel).toBe("info");
  });

  it("rejects non-string log_level", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getStatus } = makeRes();
    handler(makeReq({ log_level: 42 }), res);
    expect(getStatus()).toBe(400);
  });

  it("rejects rate_limit_defaults with missing fields", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getStatus } = makeRes();
    handler(makeReq({ rate_limit_defaults: { window_ms: 5000 } }), res);
    expect(getStatus()).toBe(400);
  });

  it("rejects rate_limit_defaults with non-positive values", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getStatus } = makeRes();
    handler(makeReq({ rate_limit_defaults: { window_ms: -1, max_requests: 100 } }), res);
    expect(getStatus()).toBe(400);
  });

  it("rejects empty body", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getStatus } = makeRes();
    handler(makeReq({}), res);
    expect(getStatus()).toBe(400);
  });

  it("rejects missing body", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getStatus } = makeRes();
    handler(makeReq(undefined), res);
    expect(getStatus()).toBe(400);
  });

  it("ignores unknown fields and still updates valid ones", () => {
    const handler = patchSystemConfig({ runtimeConfig: config });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq({ log_level: "debug", unknown_field: "ignored" }), res);
    expect(getStatus()).toBe(200);
    expect(getBody().log_level).toBe("debug");
  });

  it("persists changes visible to GET", () => {
    const patchHandler = patchSystemConfig({ runtimeConfig: config });
    const getHandler = getSystemConfig({ runtimeConfig: config, ...baseDeps });

    const { res: pRes } = makeRes();
    patchHandler(makeReq({ log_level: "error" }), pRes);

    const { res: gRes, getBody } = makeRes();
    getHandler(makeGetReq(), gRes);
    expect(getBody().log_level).toBe("error");
  });
});
