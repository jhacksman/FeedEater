import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface ConnectionState {
  connected: boolean;
  last_connected_at: string | null;
  last_disconnected_at: string | null;
  reconnect_count: number;
  latency_ms: number | null;
  endpoint_url: string;
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  binance: "wss://stream.binance.com:9443/ws",
  coinbase: "wss://ws-feed.exchange.coinbase.com",
  bybit: "wss://stream.bybit.com/v5/public/spot",
  gemini: "wss://api.gemini.com/v1/marketdata",
  bitstamp: "wss://ws.bitstamp.net",
  okx: "wss://ws.okx.com:8443/ws/v5/public",
  "uniswap-base": "https://base-mainnet.g.alchemy.com/v2",
  "aerodrome-base": "https://base-mainnet.g.alchemy.com/v2",
  kalshi: "wss://trading-api.kalshi.com/trade-api/ws/v2",
  polymarket: "wss://ws-subscriptions-clob.polymarket.com/ws",
};

export class ConnectionStatusStore {
  private states = new Map<string, ConnectionState>();

  connect(module: string, timestamp?: string): void {
    const state = this.getOrCreate(module);
    state.connected = true;
    state.last_connected_at = timestamp ?? new Date().toISOString();
  }

  disconnect(module: string, timestamp?: string): void {
    const state = this.getOrCreate(module);
    state.connected = false;
    state.last_disconnected_at = timestamp ?? new Date().toISOString();
  }

  recordReconnect(module: string, timestamp?: string): void {
    const state = this.getOrCreate(module);
    state.reconnect_count += 1;
    state.connected = true;
    state.last_connected_at = timestamp ?? new Date().toISOString();
  }

  recordLatency(module: string, ms: number): void {
    const state = this.getOrCreate(module);
    state.latency_ms = ms;
  }

  get(module: string): ConnectionState | null {
    return this.states.get(module) ?? null;
  }

  clear(): void {
    this.states.clear();
  }

  private getOrCreate(module: string): ConnectionState {
    let state = this.states.get(module);
    if (!state) {
      state = {
        connected: false,
        last_connected_at: null,
        last_disconnected_at: null,
        reconnect_count: 0,
        latency_ms: null,
        endpoint_url: DEFAULT_ENDPOINTS[module] ?? "unknown",
      };
      this.states.set(module, state);
    }
    return state;
  }
}

interface ConnectionStatusDeps {
  connectionStore: ConnectionStatusStore;
}

export function getModuleConnectionStatus({ connectionStore }: ConnectionStatusDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const state = connectionStore.get(name);

    res.json({
      module: name,
      connected: state?.connected ?? false,
      last_connected_at: state?.last_connected_at ?? null,
      last_disconnected_at: state?.last_disconnected_at ?? null,
      reconnect_count: state?.reconnect_count ?? 0,
      latency_ms: state?.latency_ms ?? null,
      endpoint_url: DEFAULT_ENDPOINTS[name] ?? "unknown",
    });
  };
}
