import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";
import { getModuleDependencies } from "../moduleDependencies.js";

const TEST_MODULES_DIR = `/tmp/test-modules-${process.pid}`;

function makeReq(params: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return { params, query } as unknown as Request;
}

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: unknown) { body = data; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

interface DepResponse {
  module: string;
  dependencies: Array<{
    name: string;
    type: "npm" | "env" | "service";
    status: "satisfied" | "missing" | "unknown";
    version?: string;
    required_version?: string;
  }>;
  summary: { total: number; satisfied: number; missing: number; unknown: number };
  error?: string;
}

function setupModuleDir(name: string, deps?: Record<string, string>) {
  const dir = join(TEST_MODULES_DIR, name);
  mkdirSync(dir, { recursive: true });
  if (deps) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
  }
}

function cleanupModulesDir() {
  try { rmSync(TEST_MODULES_DIR, { recursive: true, force: true }); } catch {}
}

describe("GET /api/modules/:name/dependencies", () => {
  it("returns 404 for unknown module", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: {} });
    const res = makeRes();
    handler(makeReq({ name: "fake-module" }), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain("Unknown module");
  });

  it("returns 404 for missing name param", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: {} });
    const res = makeRes();
    handler(makeReq({}), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns correct module name in response", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: { NATS_URL: "nats://x", DATABASE_URL: "pg://x", FEED_INTERNAL_TOKEN: "t" } });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    const body = res.body as DepResponse;
    expect(body.module).toBe("binance");
  });

  it("returns env var dependencies with satisfied status when set", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: { NATS_URL: "nats://x", DATABASE_URL: "pg://x", FEED_INTERNAL_TOKEN: "t" } });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    const body = res.body as DepResponse;
    const envDeps = body.dependencies.filter((d) => d.type === "env");
    expect(envDeps.length).toBeGreaterThanOrEqual(3);
    for (const d of envDeps) {
      expect(d.status).toBe("satisfied");
    }
  });

  it("returns env var dependencies with missing status when unset", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: {} });
    const res = makeRes();
    handler(makeReq({ name: "coinbase" }), res);
    const body = res.body as DepResponse;
    const envDeps = body.dependencies.filter((d) => d.type === "env");
    for (const d of envDeps) {
      expect(d.status).toBe("missing");
    }
  });

  it("returns service dependencies", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: { NATS_URL: "nats://x" } });
    const res = makeRes();
    handler(makeReq({ name: "bybit" }), res);
    const body = res.body as DepResponse;
    const svcDeps = body.dependencies.filter((d) => d.type === "service");
    expect(svcDeps.length).toBeGreaterThanOrEqual(2);
    const natsSvc = svcDeps.find((d) => d.name === "nats");
    expect(natsSvc?.status).toBe("satisfied");
  });

  it("marks service as missing when env key not set", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: {} });
    const res = makeRes();
    handler(makeReq({ name: "gemini" }), res);
    const body = res.body as DepResponse;
    const svcDeps = body.dependencies.filter((d) => d.type === "service");
    const pgSvc = svcDeps.find((d) => d.name === "postgres");
    expect(pgSvc?.status).toBe("missing");
  });

  it("reads npm dependencies from package.json", () => {
    cleanupModulesDir();
    setupModuleDir("okx", { nats: "^2.29.3", ws: "^8.18.0" });
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: {} });
    const res = makeRes();
    handler(makeReq({ name: "okx" }), res);
    const body = res.body as DepResponse;
    const npmDeps = body.dependencies.filter((d) => d.type === "npm");
    expect(npmDeps.length).toBe(2);
    expect(npmDeps.find((d) => d.name === "nats")?.required_version).toBe("^2.29.3");
    cleanupModulesDir();
  });

  it("returns summary counts", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: { NATS_URL: "nats://x", DATABASE_URL: "pg://x", FEED_INTERNAL_TOKEN: "t" } });
    const res = makeRes();
    handler(makeReq({ name: "bitstamp" }), res);
    const body = res.body as DepResponse;
    expect(body.summary.total).toBeGreaterThan(0);
    expect(body.summary.satisfied + body.summary.missing + body.summary.unknown).toBe(body.summary.total);
  });

  it("handles aerodrome-base with base-rpc service", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: { NATS_URL: "nats://x", DATABASE_URL: "pg://x" } });
    const res = makeRes();
    handler(makeReq({ name: "aerodrome-base" }), res);
    const body = res.body as DepResponse;
    const svcDeps = body.dependencies.filter((d) => d.type === "service");
    const rpcSvc = svcDeps.find((d) => d.name === "base-rpc");
    expect(rpcSvc).toBeDefined();
    expect(rpcSvc?.status).toBe("unknown");
  });

  it("handles uniswap-base with base-rpc service", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: { NATS_URL: "nats://x", DATABASE_URL: "pg://x" } });
    const res = makeRes();
    handler(makeReq({ name: "uniswap-base" }), res);
    const body = res.body as DepResponse;
    const svcDeps = body.dependencies.filter((d) => d.type === "service");
    const rpcSvc = svcDeps.find((d) => d.name === "base-rpc");
    expect(rpcSvc).toBeDefined();
  });

  it("returns npm deps with unknown status when node_modules missing", () => {
    cleanupModulesDir();
    setupModuleDir("kalshi", { zod: "^3.25.76" });
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: {} });
    const res = makeRes();
    handler(makeReq({ name: "kalshi" }), res);
    const body = res.body as DepResponse;
    const npmDeps = body.dependencies.filter((d) => d.type === "npm");
    expect(npmDeps[0].status).toBe("unknown");
    cleanupModulesDir();
  });

  it("returns npm deps with satisfied status and version when installed", () => {
    cleanupModulesDir();
    setupModuleDir("polymarket", { zod: "^3.25.76" });
    const nmDir = join(TEST_MODULES_DIR, "polymarket", "node_modules", "zod");
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(join(nmDir, "package.json"), JSON.stringify({ version: "3.25.76" }));
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: {} });
    const res = makeRes();
    handler(makeReq({ name: "polymarket" }), res);
    const body = res.body as DepResponse;
    const zodDep = body.dependencies.find((d) => d.name === "zod");
    expect(zodDep?.status).toBe("satisfied");
    expect(zodDep?.version).toBe("3.25.76");
    cleanupModulesDir();
  });

  it("handles missing package.json gracefully", () => {
    cleanupModulesDir();
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: { NATS_URL: "x", DATABASE_URL: "x", FEED_INTERNAL_TOKEN: "x" } });
    const res = makeRes();
    handler(makeReq({ name: "binance" }), res);
    const body = res.body as DepResponse;
    const npmDeps = body.dependencies.filter((d) => d.type === "npm");
    expect(npmDeps.length).toBe(0);
    expect(body.summary.total).toBeGreaterThan(0);
  });

  it("lists valid modules in 404 error message", () => {
    const handler = getModuleDependencies({ modulesDir: TEST_MODULES_DIR, envOverride: {} });
    const res = makeRes();
    handler(makeReq({ name: "nonexistent" }), res);
    const body = res.body as { error: string };
    expect(body.error).toContain("binance");
    expect(body.error).toContain("coinbase");
  });
});
