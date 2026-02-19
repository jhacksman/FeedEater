import { describe, it, expect, beforeEach } from "vitest";
import { postModuleTestConnection } from "../moduleTestConnection.js";
import type { ConnectionTester } from "../moduleTestConnection.js";

function makeReq(name: string) {
  return { params: { name }, body: {} } as any;
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

function makeTester(result: { reachable: boolean; latency_ms: number; error: string | null }): ConnectionTester {
  return async () => result;
}

describe("POST /api/modules/:name/test-connection", () => {
  const FIXED_NOW = 1700000000000;

  it("returns 404 for unknown module", async () => {
    const handler = postModuleTestConnection({ tester: makeTester({ reachable: true, latency_ms: 10, error: null }), nowFn: () => FIXED_NOW });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("fake-module"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns 404 for empty module name", async () => {
    const handler = postModuleTestConnection({ tester: makeTester({ reachable: true, latency_ms: 10, error: null }), nowFn: () => FIXED_NOW });
    const { res, getStatus } = makeRes();
    await handler(makeReq(""), res);
    expect(getStatus()).toBe(404);
  });

  it("returns correct response shape when reachable", async () => {
    const handler = postModuleTestConnection({ tester: makeTester({ reachable: true, latency_ms: 42, error: null }), nowFn: () => FIXED_NOW });
    const { res, getBody } = makeRes();
    await handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.venue).toBe("Binance");
    expect(body.reachable).toBe(true);
    expect(body.latency_ms).toBe(42);
    expect(body.tested_at).toBe(new Date(FIXED_NOW).toISOString());
    expect(body.error).toBeNull();
  });

  it("returns correct response shape when unreachable", async () => {
    const handler = postModuleTestConnection({ tester: makeTester({ reachable: false, latency_ms: 10000, error: "Connection timed out" }), nowFn: () => FIXED_NOW });
    const { res, getBody } = makeRes();
    await handler(makeReq("coinbase"), res);
    const body = getBody();
    expect(body.module).toBe("coinbase");
    expect(body.venue).toBe("Coinbase");
    expect(body.reachable).toBe(false);
    expect(body.latency_ms).toBe(10000);
    expect(body.error).toBe("Connection timed out");
  });

  it("tested_at is ISO string", async () => {
    const handler = postModuleTestConnection({ tester: makeTester({ reachable: true, latency_ms: 5, error: null }), nowFn: () => FIXED_NOW });
    const { res, getBody } = makeRes();
    await handler(makeReq("bybit"), res);
    expect(getBody().tested_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns venue name for each CEX module", async () => {
    const tester = makeTester({ reachable: true, latency_ms: 1, error: null });
    const venues: Record<string, string> = {
      binance: "Binance",
      coinbase: "Coinbase",
      bybit: "Bybit",
      gemini: "Gemini",
      bitstamp: "Bitstamp",
      okx: "OKX",
    };
    for (const [mod, venue] of Object.entries(venues)) {
      const handler = postModuleTestConnection({ tester, nowFn: () => FIXED_NOW });
      const { res, getBody } = makeRes();
      await handler(makeReq(mod), res);
      expect(getBody().venue).toBe(venue);
    }
  });

  it("returns venue name for prediction market modules", async () => {
    const tester = makeTester({ reachable: true, latency_ms: 1, error: null });
    const handler = postModuleTestConnection({ tester, nowFn: () => FIXED_NOW });

    const { res: r1, getBody: gb1 } = makeRes();
    await handler(makeReq("kalshi"), r1);
    expect(gb1().venue).toBe("Kalshi");

    const { res: r2, getBody: gb2 } = makeRes();
    await handler(makeReq("polymarket"), r2);
    expect(gb2().venue).toBe("Polymarket");
  });

  it("returns venue name for DEX modules", async () => {
    const tester = makeTester({ reachable: true, latency_ms: 1, error: null });
    const handler = postModuleTestConnection({ tester, nowFn: () => FIXED_NOW });

    const { res: r1, getBody: gb1 } = makeRes();
    await handler(makeReq("aerodrome-base"), r1);
    expect(gb1().venue).toBe("Aerodrome (Base)");

    const { res: r2, getBody: gb2 } = makeRes();
    await handler(makeReq("uniswap-base"), r2);
    expect(gb2().venue).toBe("Uniswap V3 (Base)");
  });

  it("passes url and type to tester", async () => {
    let calledUrl = "";
    let calledType = "";
    const tester: ConnectionTester = async (url, type) => {
      calledUrl = url;
      calledType = type;
      return { reachable: true, latency_ms: 1, error: null };
    };
    const handler = postModuleTestConnection({ tester, nowFn: () => FIXED_NOW });
    const { res } = makeRes();
    await handler(makeReq("binance"), res);
    expect(calledUrl).toBe("wss://stream.binance.com:9443/ws");
    expect(calledType).toBe("ws");
  });

  it("passes http type for kalshi", async () => {
    let calledType = "";
    const tester: ConnectionTester = async (_url, type) => {
      calledType = type;
      return { reachable: true, latency_ms: 1, error: null };
    };
    const handler = postModuleTestConnection({ tester, nowFn: () => FIXED_NOW });
    const { res } = makeRes();
    await handler(makeReq("kalshi"), res);
    expect(calledType).toBe("http");
  });

  it("returns 500 if tester throws", async () => {
    const tester: ConnectionTester = async () => { throw new Error("Network failure"); };
    const handler = postModuleTestConnection({ tester, nowFn: () => FIXED_NOW });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("binance"), res);
    expect(getStatus()).toBe(500);
    expect(getBody().error).toBe("Network failure");
  });

  it("returns 500 with generic message for non-Error throw", async () => {
    const tester: ConnectionTester = async () => { throw "something"; };
    const handler = postModuleTestConnection({ tester, nowFn: () => FIXED_NOW });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq("coinbase"), res);
    expect(getStatus()).toBe(500);
    expect(getBody().error).toBe("Connection test failed");
  });

  it("works for all known modules", async () => {
    const modules = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx", "kalshi", "polymarket", "aerodrome-base", "uniswap-base"];
    const tester = makeTester({ reachable: true, latency_ms: 5, error: null });
    for (const mod of modules) {
      const handler = postModuleTestConnection({ tester, nowFn: () => FIXED_NOW });
      const { res, getStatus, getBody } = makeRes();
      await handler(makeReq(mod), res);
      expect(getStatus()).toBe(200);
      expect(getBody().module).toBe(mod);
      expect(getBody()).toHaveProperty("venue");
      expect(getBody()).toHaveProperty("reachable");
      expect(getBody()).toHaveProperty("latency_ms");
      expect(getBody()).toHaveProperty("tested_at");
      expect(getBody()).toHaveProperty("error");
    }
  });

  it("tester receives different URLs for different modules", async () => {
    const urls: string[] = [];
    const tester: ConnectionTester = async (url) => {
      urls.push(url);
      return { reachable: true, latency_ms: 1, error: null };
    };
    const handler = postModuleTestConnection({ tester, nowFn: () => FIXED_NOW });

    const { res: r1 } = makeRes();
    await handler(makeReq("binance"), r1);
    const { res: r2 } = makeRes();
    await handler(makeReq("coinbase"), r2);

    expect(urls[0]).not.toBe(urls[1]);
    expect(urls[0]).toContain("binance");
    expect(urls[1]).toContain("coinbase");
  });
});
