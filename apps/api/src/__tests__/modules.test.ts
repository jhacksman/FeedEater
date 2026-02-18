import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { getModuleList } from "../moduleList.js";
import { LiveStatusStore } from "../status.js";

const ALL_MODULE_NAMES = [
  "binance", "coinbase", "bybit", "gemini", "bitstamp", "okx",
  "uniswap-base", "aerodrome-base", "kalshi", "polymarket",
];

const CEX_MODULES = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx"];
const DEX_MODULES = ["uniswap-base", "aerodrome-base"];
const PREDICTION_MODULES = ["kalshi", "polymarket"];

function makeReq(): Request {
  return {} as unknown as Request;
}

function makeRes() {
  let body: unknown = null;
  const res = {
    json(data: unknown) { body = data; return res; },
    get body() { return body; },
  };
  return res as unknown as Response & { body: unknown };
}

describe("GET /api/modules — module list", () => {
  it("returns all 10 modules", () => {
    const store = new LiveStatusStore();
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string }>;
    expect(modules).toHaveLength(10);
    const names = modules.map((m) => m.name);
    for (const name of ALL_MODULE_NAMES) {
      expect(names).toContain(name);
    }
  });

  it("assigns correct type to CEX modules", () => {
    const store = new LiveStatusStore();
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string; type: string }>;
    for (const name of CEX_MODULES) {
      const mod = modules.find((m) => m.name === name);
      expect(mod?.type).toBe("cex");
    }
  });

  it("assigns correct type to DEX modules", () => {
    const store = new LiveStatusStore();
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string; type: string }>;
    for (const name of DEX_MODULES) {
      const mod = modules.find((m) => m.name === name);
      expect(mod?.type).toBe("dex");
    }
  });

  it("assigns correct type to prediction modules", () => {
    const store = new LiveStatusStore();
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string; type: string }>;
    for (const name of PREDICTION_MODULES) {
      const mod = modules.find((m) => m.name === name);
      expect(mod?.type).toBe("prediction");
    }
  });

  it("returns correct natsSubject for each module", () => {
    const store = new LiveStatusStore();
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string; natsSubject: string }>;
    for (const mod of modules) {
      expect(mod.natsSubject).toBe(`feedeater.${mod.name}.tradeExecuted`);
    }
  });

  it("returns 'unknown' status when no health data exists", () => {
    const store = new LiveStatusStore();
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string; status: string }>;
    for (const mod of modules) {
      expect(mod.status).toBe("unknown");
    }
  });

  it("returns 'running' status for healthy modules", () => {
    const store = new LiveStatusStore();
    store.recordMessage("binance");
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string; status: string }>;
    const binance = modules.find((m) => m.name === "binance");
    expect(binance?.status).toBe("running");
  });

  it("returns 'stopped' status for offline modules", () => {
    const store = new LiveStatusStore();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(new Date(now).toISOString());
    store.recordMessage("gemini");

    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60 * 1000);
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string; status: string }>;
    const gemini = modules.find((m) => m.name === "gemini");
    expect(gemini?.status).toBe("stopped");

    vi.restoreAllMocks();
  });

  it("returns messageRate of 0 when no data", () => {
    const store = new LiveStatusStore();
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string; messageRate: number }>;
    for (const mod of modules) {
      expect(mod.messageRate).toBe(0);
    }
  });

  it("computes messageRate from message count and uptime", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const store = new LiveStatusStore();
    store.recordMessage("okx");
    store.recordMessage("okx");
    store.recordMessage("okx");

    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    const handler = getModuleList({ store });
    const res = makeRes();
    handler(makeReq(), res);
    const modules = res.body as Array<{ name: string; messageRate: number }>;
    const okx = modules.find((m) => m.name === "okx");
    expect(okx?.messageRate).toBe(3);

    vi.restoreAllMocks();
  });
});
