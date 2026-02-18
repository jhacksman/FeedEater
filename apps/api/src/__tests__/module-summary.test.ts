import { describe, it, expect, beforeEach } from "vitest";
import { getModuleSummary } from "../moduleSummary.js";
import { LiveStatusStore } from "../status.js";
import type { Request, Response } from "express";

const NOW = new Date("2025-06-01T12:00:00.000Z").getTime();

function makeReq(): Request {
  return { params: {}, query: {} } as unknown as Request;
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

describe("GET /api/modules/summary", () => {
  let store: LiveStatusStore;

  beforeEach(() => {
    store = new LiveStatusStore();
  });

  it("returns correct shape with all fields", () => {
    const handler = getModuleSummary({ store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("active");
    expect(body).toHaveProperty("inactive");
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("last_updated");
  });

  it("returns total of 10 modules", () => {
    const handler = getModuleSummary({ store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().total).toBe(10);
  });

  it("all modules inactive when no messages recorded", () => {
    const handler = getModuleSummary({ store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.active).toBe(0);
    expect(body.inactive).toBe(10);
    expect(body.error).toBe(0);
  });

  it("counts active modules with recent messages", () => {
    store.recordMessage("binance");
    store.recordMessage("coinbase");
    store.recordMessage("bybit");
    const handler = getModuleSummary({ store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.active).toBe(3);
    expect(body.inactive).toBe(7);
    expect(body.error).toBe(0);
  });

  it("total always equals active + inactive + error", () => {
    store.recordMessage("binance");
    store.recordMessage("gemini");
    const handler = getModuleSummary({ store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body.total).toBe(body.active + body.inactive + body.error);
  });

  it("returns last_updated as ISO string", () => {
    const handler = getModuleSummary({ store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    expect(getBody().last_updated).toBe("2025-06-01T12:00:00.000Z");
  });

  it("returns numeric types for counts", () => {
    const handler = getModuleSummary({ store, nowFn: () => NOW });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(typeof body.total).toBe("number");
    expect(typeof body.active).toBe("number");
    expect(typeof body.inactive).toBe("number");
    expect(typeof body.error).toBe("number");
  });
});
