import { describe, it, expect, beforeEach, vi } from "vitest";
import { postModulePurge } from "../modulePurge.js";

function makeReq(name: string, body?: Record<string, unknown>) {
  return { params: { name }, body: body ?? {} } as any;
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

describe("POST /api/modules/:name/purge", () => {
  let tick: number;
  let runPurge: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tick = 1700000000000;
    runPurge = vi.fn().mockResolvedValue({ rowCount: 0 });
  });

  function handler() {
    return postModulePurge({ runPurge, nowFn: () => tick });
  }

  it("returns 404 for unknown module", async () => {
    const { res, getStatus, getBody } = makeRes();
    await handler()(makeReq("nonexistent", { confirm: true }), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("returns 400 when confirm is missing", async () => {
    const { res, getStatus, getBody } = makeRes();
    await handler()(makeReq("binance", {}), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("confirm must be true");
  });

  it("returns 400 when confirm is false", async () => {
    const { res, getStatus, getBody } = makeRes();
    await handler()(makeReq("binance", { confirm: false }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("confirm must be true");
  });

  it("returns 400 when confirm is string 'true'", async () => {
    const { res, getStatus, getBody } = makeRes();
    await handler()(makeReq("binance", { confirm: "true" }), res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("confirm must be true");
  });

  it("returns 400 when body is undefined", async () => {
    const { res, getStatus, getBody } = makeRes();
    await handler()({ params: { name: "binance" }, body: undefined } as any, res);
    expect(getStatus()).toBe(400);
    expect(getBody().error).toContain("confirm must be true");
  });

  it("purges successfully with confirm: true", async () => {
    runPurge.mockResolvedValue({ rowCount: 42 });
    const { res, getStatus, getBody } = makeRes();
    await handler()(makeReq("binance", { confirm: true }), res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({
      module: "binance",
      purged: true,
      records_deleted: 42,
      purged_at: new Date(tick).toISOString(),
    });
  });

  it("calls runPurge with the module name", async () => {
    const { res } = makeRes();
    await handler()(makeReq("coinbase", { confirm: true }), res);
    expect(runPurge).toHaveBeenCalledWith("coinbase");
  });

  it("returns records_deleted: 0 when no data existed", async () => {
    runPurge.mockResolvedValue({ rowCount: 0 });
    const { res, getBody } = makeRes();
    await handler()(makeReq("bybit", { confirm: true }), res);
    expect(getBody().records_deleted).toBe(0);
    expect(getBody().purged).toBe(true);
  });

  it("returns 500 when runPurge throws", async () => {
    runPurge.mockRejectedValue(new Error("connection refused"));
    const { res, getStatus, getBody } = makeRes();
    await handler()(makeReq("binance", { confirm: true }), res);
    expect(getStatus()).toBe(500);
    expect(getBody().error).toBe("connection refused");
  });

  it("returns 500 with generic message for non-Error throws", async () => {
    runPurge.mockRejectedValue("something went wrong");
    const { res, getStatus, getBody } = makeRes();
    await handler()(makeReq("binance", { confirm: true }), res);
    expect(getStatus()).toBe(500);
    expect(getBody().error).toBe("Purge failed");
  });

  it("purged_at is a valid ISO timestamp", async () => {
    runPurge.mockResolvedValue({ rowCount: 1 });
    const { res, getBody } = makeRes();
    await handler()(makeReq("okx", { confirm: true }), res);
    const d = new Date(getBody().purged_at);
    expect(d.getTime()).toBe(tick);
  });

  it("works for all known modules", async () => {
    const modules = [
      "binance", "coinbase", "bybit", "gemini", "bitstamp",
      "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base",
    ];
    for (const mod of modules) {
      runPurge.mockResolvedValue({ rowCount: 10 });
      const { res, getStatus, getBody } = makeRes();
      await handler()(makeReq(mod, { confirm: true }), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
      expect(getBody().purged).toBe(true);
    }
  });

  it("returns 404 for empty module name", async () => {
    const { res, getStatus, getBody } = makeRes();
    await handler()(makeReq("", { confirm: true }), res);
    expect(getStatus()).toBe(404);
    expect(getBody().error).toContain("Unknown module");
  });

  it("validates confirm before calling runPurge", async () => {
    const { res } = makeRes();
    await handler()(makeReq("binance", { confirm: false }), res);
    expect(runPurge).not.toHaveBeenCalled();
  });

  it("validates module before checking confirm", async () => {
    const { res, getStatus } = makeRes();
    await handler()(makeReq("nonexistent", { confirm: true }), res);
    expect(getStatus()).toBe(404);
    expect(runPurge).not.toHaveBeenCalled();
  });
});
