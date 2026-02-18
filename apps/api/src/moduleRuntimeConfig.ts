import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

type ConfigSource = "env" | "default";

interface ConfigEntry {
  key: string;
  value: string;
  source: ConfigSource;
  sensitive: boolean;
}

const SENSITIVE_PATTERNS = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
  /database_url/i,
  /rpc_url/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(key));
}

function redact(value: string, sensitive: boolean): string {
  return sensitive ? "***" : value;
}

interface ModuleEnvDef {
  keys: string[];
  defaults: Record<string, string>;
}

const MODULE_ENV_DEFS: Record<string, ModuleEnvDef> = {
  binance: {
    keys: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN", "BINANCE_WS_URL"],
    defaults: { BINANCE_WS_URL: "wss://stream.binance.com:9443/ws" },
  },
  coinbase: {
    keys: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN", "COINBASE_WS_URL"],
    defaults: { COINBASE_WS_URL: "wss://ws-feed.exchange.coinbase.com" },
  },
  bybit: {
    keys: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN", "BYBIT_WS_URL"],
    defaults: { BYBIT_WS_URL: "wss://stream.bybit.com/v5/public/spot" },
  },
  gemini: {
    keys: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN", "GEMINI_WS_URL"],
    defaults: { GEMINI_WS_URL: "wss://api.gemini.com/v1/marketdata" },
  },
  bitstamp: {
    keys: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN", "BITSTAMP_WS_URL"],
    defaults: { BITSTAMP_WS_URL: "wss://ws.bitstamp.net" },
  },
  okx: {
    keys: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN", "OKX_WS_URL"],
    defaults: { OKX_WS_URL: "wss://ws.okx.com:8443/ws/v5/public" },
  },
  kalshi: {
    keys: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN", "KALSHI_API_URL", "KALSHI_API_KEY"],
    defaults: { KALSHI_API_URL: "https://trading-api.kalshi.com/trade-api/v2" },
  },
  polymarket: {
    keys: ["NATS_URL", "DATABASE_URL", "FEED_INTERNAL_TOKEN", "POLYMARKET_API_URL"],
    defaults: { POLYMARKET_API_URL: "https://clob.polymarket.com" },
  },
  "aerodrome-base": {
    keys: ["NATS_URL", "DATABASE_URL", "BASE_RPC_URL"],
    defaults: {},
  },
  "uniswap-base": {
    keys: ["NATS_URL", "DATABASE_URL", "BASE_RPC_URL"],
    defaults: {},
  },
};

interface RuntimeConfigDeps {
  disabledModules: Set<string>;
  loadedAt: string;
  envOverride?: Record<string, string | undefined>;
}

export function getModuleRuntimeConfig({ disabledModules, loadedAt, envOverride }: RuntimeConfigDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const def = MODULE_ENV_DEFS[name];
    const env = envOverride ?? process.env;
    const config: ConfigEntry[] = [];

    if (def) {
      for (const key of def.keys) {
        const envVal = env[key];
        const defaultVal = def.defaults[key];
        const sensitive = isSensitiveKey(key);

        if (envVal !== undefined) {
          config.push({ key, value: redact(envVal, sensitive), source: "env", sensitive });
        } else if (defaultVal !== undefined) {
          config.push({ key, value: redact(defaultVal, sensitive), source: "default", sensitive });
        } else {
          config.push({ key, value: "", source: "default", sensitive });
        }
      }
    }

    res.json({
      module: name,
      disabled: disabledModules.has(name),
      loaded_at: loadedAt,
      config,
    });
  };
}
