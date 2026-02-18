import { describe, it, expect, beforeEach } from "vitest";
import { VenueStore, getVenues } from "../venues.js";

function makeRes() {
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(data: any) { body = data; },
  } as any;
  return { res, getStatus: () => statusCode, getBody: () => body };
}

describe("VenueStore", () => {
  let store: VenueStore;
  let now: number;

  beforeEach(() => {
    now = 1700000000000;
    store = new VenueStore(() => now);
  });

  it("returns null lastMessageAt for untracked module", () => {
    const data = store.getVenueData("binance");
    expect(data.lastMessageAt).toBeNull();
    expect(data.messageCount24h).toBe(0);
    expect(data.hasError).toBe(false);
  });

  it("tracks lastMessageAt after recordMessage", () => {
    store.recordMessage("coinbase");
    const data = store.getVenueData("coinbase");
    expect(data.lastMessageAt).toBe(new Date(now).toISOString());
  });

  it("counts messages within 24h window", () => {
    store.recordMessage("bybit");
    store.recordMessage("bybit");
    store.recordMessage("bybit");
    const data = store.getVenueData("bybit");
    expect(data.messageCount24h).toBe(3);
  });

  it("excludes messages older than 24h from count", () => {
    store.recordMessage("gemini");
    now += 25 * 60 * 60 * 1000;
    store.recordMessage("gemini");
    const data = store.getVenueData("gemini");
    expect(data.messageCount24h).toBe(1);
  });

  it("sets hasError on recordError", () => {
    store.recordError("okx");
    const data = store.getVenueData("okx");
    expect(data.hasError).toBe(true);
  });

  it("clears error with clearError", () => {
    store.recordError("bitstamp");
    store.clearError("bitstamp");
    const data = store.getVenueData("bitstamp");
    expect(data.hasError).toBe(false);
  });

  it("tracks modules independently", () => {
    store.recordMessage("binance");
    store.recordMessage("binance");
    store.recordMessage("coinbase");
    expect(store.getVenueData("binance").messageCount24h).toBe(2);
    expect(store.getVenueData("coinbase").messageCount24h).toBe(1);
  });

  it("clearError is no-op for untracked module", () => {
    store.clearError("unknown");
    expect(store.getVenueData("unknown").hasError).toBe(false);
  });
});

describe("GET /api/venues handler", () => {
  let store: VenueStore;
  let disabledModules: Set<string>;
  let now: number;

  beforeEach(() => {
    now = 1700000000000;
    store = new VenueStore(() => now);
    disabledModules = new Set();
  });

  it("returns all 10 venues", () => {
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    expect(getBody().venues).toHaveLength(10);
  });

  it("returns correct response shape for each venue", () => {
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    const venue = getBody().venues[0];
    expect(venue).toHaveProperty("name");
    expect(venue).toHaveProperty("type");
    expect(venue).toHaveProperty("status");
    expect(venue).toHaveProperty("module");
    expect(venue).toHaveProperty("last_message_at");
    expect(venue).toHaveProperty("message_count_24h");
  });

  it("includes cex, dex, and prediction venue types", () => {
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    const types = new Set(getBody().venues.map((v: any) => v.type));
    expect(types.has("cex")).toBe(true);
    expect(types.has("dex")).toBe(true);
    expect(types.has("prediction")).toBe(true);
  });

  it("shows inactive status when no messages received", () => {
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    const binance = getBody().venues.find((v: any) => v.name === "binance");
    expect(binance.status).toBe("inactive");
  });

  it("shows active status when messages are present", () => {
    store.recordMessage("binance");
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    const binance = getBody().venues.find((v: any) => v.name === "binance");
    expect(binance.status).toBe("active");
  });

  it("shows inactive status for disabled modules", () => {
    store.recordMessage("coinbase");
    disabledModules.add("coinbase");
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    const coinbase = getBody().venues.find((v: any) => v.name === "coinbase");
    expect(coinbase.status).toBe("inactive");
  });

  it("shows error status when module has error", () => {
    store.recordMessage("okx");
    store.recordError("okx");
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    const okx = getBody().venues.find((v: any) => v.name === "okx");
    expect(okx.status).toBe("error");
  });

  it("populates last_message_at and message_count_24h", () => {
    store.recordMessage("kalshi");
    store.recordMessage("kalshi");
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    const kalshi = getBody().venues.find((v: any) => v.name === "kalshi");
    expect(kalshi.last_message_at).toBe(new Date(now).toISOString());
    expect(kalshi.message_count_24h).toBe(2);
  });

  it("returns null last_message_at for venues with no data", () => {
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    const poly = getBody().venues.find((v: any) => v.name === "polymarket");
    expect(poly.last_message_at).toBeNull();
    expect(poly.message_count_24h).toBe(0);
  });

  it("venue type values are strictly cex, dex, or prediction", () => {
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    for (const v of getBody().venues) {
      expect(["cex", "dex", "prediction"]).toContain(v.type);
    }
  });

  it("venue status values are strictly active, inactive, or error", () => {
    store.recordMessage("binance");
    store.recordError("coinbase");
    const handler = getVenues({ venueStore: store, disabledModules });
    const { res, getBody } = makeRes();
    handler({} as any, res);
    for (const v of getBody().venues) {
      expect(["active", "inactive", "error"]).toContain(v.status);
    }
  });
});
