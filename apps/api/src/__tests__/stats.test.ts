import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getStats } from "../stats.js";

const ALL_MODULES = [
  "binance", "coinbase", "bybit", "gemini", "bitstamp", "okx",
  "kalshi", "polymarket", "uniswap-base", "aerodrome-base",
];

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: unknown) { body = data; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res as any;
}

describe("GET /api/stats", () => {
  const originalEnv = process.env.POSTGRES_URL;

  beforeEach(() => {
    delete process.env.POSTGRES_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.POSTGRES_URL = originalEnv;
    } else {
      delete process.env.POSTGRES_URL;
    }
  });

  it("returns 503 when POSTGRES_URL is not set", async () => {
    const req = {} as any;
    const res = makeRes();
    await getStats(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "Postgres not configured" });
  });

  it("returns all 10 modules in response", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";
    const { getStats: freshGetStats } = await import("../stats.js?v=all10");

    const mockPool = {
      query: async () => ({ rows: [{ cnt: 0 }] }),
    };
    const origGetPool = (await import("../stats.js?v=all10pool")) as any;
    void origGetPool;

    const req = {} as any;
    const res = makeRes();
    await freshGetStats(req, res);

    const body = res.body as { modules: Record<string, unknown>; totalRows: number; generatedAt: string };
    const moduleNames = Object.keys(body.modules);
    expect(moduleNames).toHaveLength(10);
    for (const name of ALL_MODULES) {
      expect(moduleNames).toContain(name);
    }
  });

  it("returns correct shape for each module", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";
    const { getStats: freshGetStats } = await import("../stats.js?v=shape");

    const req = {} as any;
    const res = makeRes();
    await freshGetStats(req, res);

    const body = res.body as { modules: Record<string, any>; totalRows: number; generatedAt: string };

    expect(body).toHaveProperty("totalRows");
    expect(body).toHaveProperty("generatedAt");
    expect(typeof body.totalRows).toBe("number");
    expect(typeof body.generatedAt).toBe("string");

    for (const name of ALL_MODULES) {
      const mod = body.modules[name];
      expect(mod).toHaveProperty("rowCount");
      expect(mod).toHaveProperty("oldestTimestamp");
      expect(mod).toHaveProperty("newestTimestamp");
      expect(mod).toHaveProperty("estimatedSizeMb");
      expect(typeof mod.rowCount).toBe("number");
      expect(typeof mod.estimatedSizeMb).toBe("number");
    }
  });

  it("returns zero values for modules with no data", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";
    const { getStats: freshGetStats } = await import("../stats.js?v=empty");

    const req = {} as any;
    const res = makeRes();
    await freshGetStats(req, res);

    const body = res.body as { modules: Record<string, any>; totalRows: number };

    for (const name of ALL_MODULES) {
      const mod = body.modules[name];
      expect(mod.rowCount).toBe(0);
      expect(mod.oldestTimestamp).toBeNull();
      expect(mod.newestTimestamp).toBeNull();
      expect(mod.estimatedSizeMb).toBe(0);
    }
    expect(body.totalRows).toBe(0);
  });

  it("totalRows equals sum of all module rowCounts", async () => {
    process.env.POSTGRES_URL = "postgresql://localhost:5432/test";
    const { getStats: freshGetStats } = await import("../stats.js?v=total");

    const req = {} as any;
    const res = makeRes();
    await freshGetStats(req, res);

    const body = res.body as { modules: Record<string, any>; totalRows: number };
    const sum = Object.values(body.modules).reduce((acc: number, m: any) => acc + m.rowCount, 0);
    expect(body.totalRows).toBe(sum);
  });
});
