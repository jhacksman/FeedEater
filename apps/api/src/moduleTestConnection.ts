import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

const VENUE_ENDPOINTS: Record<string, { venue: string; url: string; type: "ws" | "http" }> = {
  binance: { venue: "Binance", url: "wss://stream.binance.com:9443/ws", type: "ws" },
  coinbase: { venue: "Coinbase", url: "wss://ws-feed.exchange.coinbase.com", type: "ws" },
  bybit: { venue: "Bybit", url: "wss://stream.bybit.com/v5/public/spot", type: "ws" },
  gemini: { venue: "Gemini", url: "wss://api.gemini.com/v1/marketdata", type: "ws" },
  bitstamp: { venue: "Bitstamp", url: "wss://ws.bitstamp.net", type: "ws" },
  okx: { venue: "OKX", url: "wss://ws.okx.com:8443/ws/v5/public", type: "ws" },
  kalshi: { venue: "Kalshi", url: "https://trading-api.kalshi.com/trade-api/v2", type: "http" },
  polymarket: { venue: "Polymarket", url: "https://clob.polymarket.com", type: "http" },
  "aerodrome-base": { venue: "Aerodrome (Base)", url: "https://mainnet.base.org", type: "http" },
  "uniswap-base": { venue: "Uniswap V3 (Base)", url: "https://mainnet.base.org", type: "http" },
};

export type ConnectionTester = (url: string, type: "ws" | "http") => Promise<{ reachable: boolean; latency_ms: number; error: string | null }>;

const TIMEOUT_MS = 10_000;

async function defaultConnectionTester(url: string, type: "ws" | "http"): Promise<{ reachable: boolean; latency_ms: number; error: string | null }> {
  const start = Date.now();
  try {
    if (type === "http") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const resp = await fetch(url, { method: "HEAD", signal: controller.signal });
      clearTimeout(timer);
      const latency_ms = Date.now() - start;
      return { reachable: resp.ok || resp.status < 500, latency_ms, error: null };
    }
    const { WebSocket } = await import("ws");
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        ws.close();
        resolve({ reachable: false, latency_ms: TIMEOUT_MS, error: "Connection timed out" });
      }, TIMEOUT_MS);
      const ws = new WebSocket(url);
      ws.on("open", () => {
        clearTimeout(timer);
        const latency_ms = Date.now() - start;
        ws.close();
        resolve({ reachable: true, latency_ms, error: null });
      });
      ws.on("error", (err: Error) => {
        clearTimeout(timer);
        const latency_ms = Date.now() - start;
        ws.close();
        resolve({ reachable: false, latency_ms, error: err.message });
      });
    });
  } catch (err: unknown) {
    const latency_ms = Date.now() - start;
    const message = err instanceof Error ? err.message : "Connection failed";
    return { reachable: false, latency_ms, error: message };
  }
}

interface TestConnectionDeps {
  tester?: ConnectionTester;
  nowFn?: () => number;
}

export function postModuleTestConnection({ tester, nowFn }: TestConnectionDeps) {
  const testFn = tester ?? defaultConnectionTester;

  return async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const endpoint = VENUE_ENDPOINTS[name];
    if (!endpoint) {
      res.status(404).json({ error: `No venue endpoint configured for module: ${name}` });
      return;
    }

    const now = nowFn?.() ?? Date.now();

    try {
      const result = await testFn(endpoint.url, endpoint.type);
      res.json({
        module: name,
        venue: endpoint.venue,
        reachable: result.reachable,
        latency_ms: result.latency_ms,
        tested_at: new Date(now).toISOString(),
        error: result.error,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Connection test failed";
      res.status(500).json({ error: message });
    }
  };
}
