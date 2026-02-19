import { describe, it, expect, beforeEach } from "vitest";
import { DataSchemaStore, getModuleDataSchema, getDefaultFields } from "../moduleDataSchema.js";

function makeReq(name: string) {
  return { params: { name } } as any;
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

describe("DataSchemaStore", () => {
  let store: DataSchemaStore;

  beforeEach(() => {
    store = new DataSchemaStore();
  });

  it("returns null for unregistered module", () => {
    expect(store.get("binance")).toBeNull();
  });

  it("registers and retrieves a schema", () => {
    const fields = [{ name: "price", type: "number", unit: "USD", description: "Last price" }];
    store.register("binance", fields, "2.0.0", "2026-01-01T00:00:00Z");
    const schema = store.get("binance")!;
    expect(schema.fields).toEqual(fields);
    expect(schema.version).toBe("2.0.0");
    expect(schema.updated_at).toBe("2026-01-01T00:00:00Z");
  });

  it("overwrites on re-register", () => {
    store.register("binance", [], "1.0.0", "2026-01-01T00:00:00Z");
    store.register("binance", [{ name: "vol", type: "number", unit: null, description: "Volume" }], "2.0.0", "2026-02-01T00:00:00Z");
    const schema = store.get("binance")!;
    expect(schema.fields.length).toBe(1);
    expect(schema.version).toBe("2.0.0");
  });

  it("clear removes all schemas", () => {
    store.register("binance", [], "1.0.0");
    store.clear();
    expect(store.get("binance")).toBeNull();
  });
});

describe("getDefaultFields", () => {
  it("returns CEX fields for CEX modules", () => {
    for (const mod of ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx"]) {
      const fields = getDefaultFields(mod)!;
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.some((f) => f.name === "price")).toBe(true);
      expect(fields.some((f) => f.name === "symbol")).toBe(true);
    }
  });

  it("returns DEX fields for DEX modules", () => {
    for (const mod of ["uniswap-base", "aerodrome-base"]) {
      const fields = getDefaultFields(mod)!;
      expect(fields.some((f) => f.name === "pool_address")).toBe(true);
      expect(fields.some((f) => f.name === "liquidity_usd")).toBe(true);
    }
  });

  it("returns prediction fields for prediction modules", () => {
    for (const mod of ["kalshi", "polymarket"]) {
      const fields = getDefaultFields(mod)!;
      expect(fields.some((f) => f.name === "market_id")).toBe(true);
      expect(fields.some((f) => f.name === "yes_price")).toBe(true);
    }
  });

  it("returns null for unknown module", () => {
    expect(getDefaultFields("unknown")).toBeNull();
  });
});

describe("GET /api/modules/:name/data-schema", () => {
  let store: DataSchemaStore;

  beforeEach(() => {
    store = new DataSchemaStore();
  });

  it("returns 404 for unknown module", () => {
    const handler = getModuleDataSchema({ schemaStore: store });
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq("nonexistent"), res);
    expect(getStatus()).toBe(404);
    expect(getBody()).toHaveProperty("error");
  });

  it("returns default CEX schema for binance with no custom schema", () => {
    const handler = getModuleDataSchema({ schemaStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.module).toBe("binance");
    expect(body.schema.fields.length).toBeGreaterThan(0);
    expect(body.schema.version).toBe("1.0.0");
    expect(body.schema.updated_at).toBeNull();
  });

  it("returns default DEX schema for uniswap-base", () => {
    const handler = getModuleDataSchema({ schemaStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("uniswap-base"), res);
    const fields = getBody().schema.fields;
    expect(fields.some((f: any) => f.name === "pool_address")).toBe(true);
  });

  it("returns default prediction schema for kalshi", () => {
    const handler = getModuleDataSchema({ schemaStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("kalshi"), res);
    const fields = getBody().schema.fields;
    expect(fields.some((f: any) => f.name === "market_id")).toBe(true);
  });

  it("returns custom schema when registered", () => {
    const customFields = [{ name: "custom_field", type: "string", unit: null, description: "Custom" }];
    store.register("binance", customFields, "3.0.0", "2026-06-01T00:00:00Z");
    const handler = getModuleDataSchema({ schemaStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("binance"), res);
    const body = getBody();
    expect(body.schema.fields).toEqual(customFields);
    expect(body.schema.version).toBe("3.0.0");
    expect(body.schema.updated_at).toBe("2026-06-01T00:00:00Z");
  });

  it("schema fields have name, type, unit, description", () => {
    const handler = getModuleDataSchema({ schemaStore: store });
    const { res, getBody } = makeRes();
    handler(makeReq("coinbase"), res);
    for (const field of getBody().schema.fields) {
      expect(field).toHaveProperty("name");
      expect(field).toHaveProperty("type");
      expect(field).toHaveProperty("unit");
      expect(field).toHaveProperty("description");
    }
  });
});
