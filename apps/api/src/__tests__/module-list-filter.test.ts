import { describe, it, expect, beforeEach } from "vitest";
import { getModuleList } from "../moduleList.js";
import { LiveStatusStore } from "../status.js";
import type { Request, Response } from "express";

function makeReq(query: Record<string, string> = {}): Request {
  return { params: {}, query } as unknown as Request;
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

describe("GET /api/modules with ?status= filter", () => {
  let store: LiveStatusStore;

  beforeEach(() => {
    store = new LiveStatusStore();
  });

  it("returns all 10 modules when no filter is applied", () => {
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const body = getBody();
    expect(body).toHaveLength(10);
    expect(body[0]).toHaveProperty("name");
    expect(body[0]).toHaveProperty("type");
    expect(body[0]).toHaveProperty("status");
    expect(body[0]).toHaveProperty("messageRate");
    expect(body[0]).toHaveProperty("natsSubject");
  });

  it("does not include _filterStatus in the response", () => {
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    for (const m of getBody()) {
      expect(m).not.toHaveProperty("_filterStatus");
    }
  });

  it("does not include _filterStatus when filter is applied", () => {
    store.recordMessage("binance");
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "active" }), res);
    for (const m of getBody()) {
      expect(m).not.toHaveProperty("_filterStatus");
    }
  });

  it("filters active modules (healthy in LiveStatusStore)", () => {
    store.recordMessage("binance");
    store.recordMessage("coinbase");
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "active" }), res);
    const body = getBody();
    const names = body.map((m: any) => m.name);
    expect(names).toContain("binance");
    expect(names).toContain("coinbase");
    expect(names).not.toContain("gemini");
  });

  it("filters inactive modules (no live data)", () => {
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "inactive" }), res);
    const body = getBody();
    expect(body).toHaveLength(10);
    for (const m of body) {
      expect(m.status).toMatch(/stopped|unknown/);
    }
  });

  it("returns empty array for active when no modules have messages", () => {
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "active" }), res);
    expect(getBody()).toHaveLength(0);
  });

  it("ignores invalid filter value and returns all modules", () => {
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "bogus" }), res);
    expect(getBody()).toHaveLength(10);
  });

  it("maintains backward compatibility — response shape unchanged", () => {
    store.recordMessage("binance");
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq(), res);
    const binance = getBody().find((m: any) => m.name === "binance");
    expect(binance).toEqual({
      name: "binance",
      type: "cex",
      natsSubject: "feedeater.binance.tradeExecuted",
      status: "running",
      messageRate: expect.any(Number),
    });
  });

  it("active modules have status running", () => {
    store.recordMessage("bybit");
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "active" }), res);
    for (const m of getBody()) {
      expect(m.status).toBe("running");
    }
  });

  it("error filter returns empty when no stale modules", () => {
    store.recordMessage("binance");
    const handler = getModuleList({ store });
    const { res, getBody } = makeRes();
    handler(makeReq({ status: "error" }), res);
    expect(getBody()).toHaveLength(0);
  });
});
