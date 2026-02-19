import { describe, it, expect } from "vitest";
import { getModuleSearch } from "../moduleSearch.js";

function makeReq(query: Record<string, string> = {}) {
  return { query } as any;
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

function makeMockStore(modules: Array<{ name: string; status: string; message_count: number }> = []) {
  return {
    getAllModules() { return modules; },
    getUptimeSeconds() { return 600; },
  } as any;
}

describe("GET /api/modules/search", () => {
  it("returns all modules when no filters", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("modules");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("filtered");
    expect(body.total).toBeGreaterThan(0);
    expect(body.filtered).toBe(body.total);
  });

  it("returns correct response shape per module", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const mod = getBody().modules[0];
    expect(mod).toHaveProperty("name");
    expect(mod).toHaveProperty("type");
    expect(mod).toHaveProperty("natsSubject");
    expect(mod).toHaveProperty("status");
    expect(mod).toHaveProperty("messageRate");
    expect(mod).not.toHaveProperty("_filterStatus");
  });

  it("filters by type=cex", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "cex" }), res);
    const body = getBody();
    expect(body.filtered).toBeGreaterThan(0);
    expect(body.filtered).toBeLessThan(body.total);
    body.modules.forEach((m: any) => expect(m.type).toBe("cex"));
  });

  it("filters by type=dex", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "dex" }), res);
    const body = getBody();
    expect(body.filtered).toBeGreaterThan(0);
    body.modules.forEach((m: any) => expect(m.type).toBe("dex"));
  });

  it("filters by type=prediction", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "prediction" }), res);
    const body = getBody();
    expect(body.filtered).toBeGreaterThan(0);
    body.modules.forEach((m: any) => expect(m.type).toBe("prediction"));
  });

  it("filters by q prefix", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ q: "bin" }), res);
    const body = getBody();
    expect(body.filtered).toBe(1);
    expect(body.modules[0].name).toBe("binance");
  });

  it("filters by q substring (case-insensitive)", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ q: "BASE" }), res);
    const body = getBody();
    expect(body.filtered).toBeGreaterThanOrEqual(2);
    body.modules.forEach((m: any) => expect(m.name.toLowerCase()).toContain("base"));
  });

  it("filters by status=active with live modules", () => {
    const store = makeMockStore([
      { name: "binance", status: "healthy", message_count: 100 },
    ]);
    const handler = getModuleSearch({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "active" }), res);
    const body = getBody();
    expect(body.filtered).toBe(1);
    expect(body.modules[0].name).toBe("binance");
  });

  it("filters by status=stopped returns inactive modules", () => {
    const store = makeMockStore([
      { name: "binance", status: "healthy", message_count: 100 },
      { name: "coinbase", status: "offline", message_count: 0 },
    ]);
    const handler = getModuleSearch({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "stopped" }), res);
    const body = getBody();
    expect(body.filtered).toBeGreaterThan(0);
    body.modules.forEach((m: any) => expect(m.name).not.toBe("binance"));
  });

  it("filters by status=error with stale modules", () => {
    const store = makeMockStore([
      { name: "coinbase", status: "stale", message_count: 5 },
    ]);
    const handler = getModuleSearch({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "error" }), res);
    const body = getBody();
    expect(body.filtered).toBe(1);
    expect(body.modules[0].name).toBe("coinbase");
  });

  it("combines type + q filters", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "cex", q: "bi" }), res);
    const body = getBody();
    expect(body.filtered).toBeGreaterThanOrEqual(2);
    body.modules.forEach((m: any) => {
      expect(m.type).toBe("cex");
      expect(m.name.toLowerCase()).toContain("bi");
    });
  });

  it("combines status + type filters", () => {
    const store = makeMockStore([
      { name: "binance", status: "healthy", message_count: 100 },
      { name: "uniswap-base", status: "healthy", message_count: 50 },
    ]);
    const handler = getModuleSearch({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "active", type: "cex" }), res);
    const body = getBody();
    expect(body.filtered).toBe(1);
    expect(body.modules[0].name).toBe("binance");
  });

  it("combines all three filters", () => {
    const store = makeMockStore([
      { name: "binance", status: "healthy", message_count: 100 },
      { name: "coinbase", status: "healthy", message_count: 50 },
    ]);
    const handler = getModuleSearch({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "active", type: "cex", q: "coin" }), res);
    const body = getBody();
    expect(body.filtered).toBe(1);
    expect(body.modules[0].name).toBe("coinbase");
  });

  it("returns empty modules array when no match", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ q: "nonexistent" }), res);
    const body = getBody();
    expect(body.modules).toEqual([]);
    expect(body.filtered).toBe(0);
    expect(body.total).toBeGreaterThan(0);
  });

  it("ignores invalid status filter", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "invalid" }), res);
    expect(getBody().filtered).toBe(getBody().total);
  });

  it("ignores invalid type filter", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ type: "invalid" }), res);
    expect(getBody().filtered).toBe(getBody().total);
  });

  it("ignores empty q string", () => {
    const handler = getModuleSearch({ store: makeMockStore() });
    const { res, getBody } = makeRes();
    handler(makeReq({ q: "" }), res);
    expect(getBody().filtered).toBe(getBody().total);
  });

  it("computes messageRate from live store data", () => {
    const store = makeMockStore([
      { name: "binance", status: "healthy", message_count: 600 },
    ]);
    const handler = getModuleSearch({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ q: "binance" }), res);
    const mod = getBody().modules[0];
    expect(mod.messageRate).toBe(60);
  });
});
