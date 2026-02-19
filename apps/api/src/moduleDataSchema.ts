import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface SchemaField {
  name: string;
  type: string;
  unit: string | null;
  description: string;
}

interface ModuleSchema {
  fields: SchemaField[];
  version: string;
  updated_at: string;
}

export class DataSchemaStore {
  private schemas = new Map<string, ModuleSchema>();

  register(module: string, fields: SchemaField[], version: string, updatedAt?: string): void {
    this.schemas.set(module, {
      fields,
      version,
      updated_at: updatedAt ?? new Date().toISOString(),
    });
  }

  get(module: string): ModuleSchema | null {
    return this.schemas.get(module) ?? null;
  }

  clear(): void {
    this.schemas.clear();
  }
}

const CEX_FIELDS: SchemaField[] = [
  { name: "symbol", type: "string", unit: null, description: "Trading pair symbol" },
  { name: "price", type: "number", unit: "USD", description: "Last trade price" },
  { name: "bid", type: "number", unit: "USD", description: "Best bid price" },
  { name: "ask", type: "number", unit: "USD", description: "Best ask price" },
  { name: "volume_24h", type: "number", unit: "base_currency", description: "24-hour trading volume" },
  { name: "timestamp", type: "string", unit: "ISO8601", description: "Data point timestamp" },
];

const DEX_FIELDS: SchemaField[] = [
  { name: "pool_address", type: "string", unit: null, description: "DEX pool contract address" },
  { name: "token0", type: "string", unit: null, description: "First token symbol" },
  { name: "token1", type: "string", unit: null, description: "Second token symbol" },
  { name: "price", type: "number", unit: "USD", description: "Spot price" },
  { name: "liquidity_usd", type: "number", unit: "USD", description: "Total pool liquidity" },
  { name: "volume_24h", type: "number", unit: "USD", description: "24-hour volume" },
  { name: "timestamp", type: "string", unit: "ISO8601", description: "Data point timestamp" },
];

const PREDICTION_FIELDS: SchemaField[] = [
  { name: "market_id", type: "string", unit: null, description: "Market identifier" },
  { name: "title", type: "string", unit: null, description: "Market question/title" },
  { name: "yes_price", type: "number", unit: "USD", description: "Price of YES outcome" },
  { name: "no_price", type: "number", unit: "USD", description: "Price of NO outcome" },
  { name: "volume_24h", type: "number", unit: "USD", description: "24-hour trading volume" },
  { name: "timestamp", type: "string", unit: "ISO8601", description: "Data point timestamp" },
];

const CEX_MODULES = new Set(["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx"]);
const DEX_MODULES = new Set(["uniswap-base", "aerodrome-base"]);
const PREDICTION_MODULES = new Set(["kalshi", "polymarket"]);

export function getDefaultFields(module: string): SchemaField[] | null {
  if (CEX_MODULES.has(module)) return CEX_FIELDS;
  if (DEX_MODULES.has(module)) return DEX_FIELDS;
  if (PREDICTION_MODULES.has(module)) return PREDICTION_FIELDS;
  return null;
}

interface DataSchemaDeps {
  schemaStore: DataSchemaStore;
}

export function getModuleDataSchema({ schemaStore }: DataSchemaDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const stored = schemaStore.get(name);
    if (stored) {
      res.json({ module: name, schema: stored });
      return;
    }

    const defaultFields = getDefaultFields(name);
    res.json({
      module: name,
      schema: {
        fields: defaultFields ?? [],
        version: "1.0.0",
        updated_at: null,
      },
    });
  };
}
