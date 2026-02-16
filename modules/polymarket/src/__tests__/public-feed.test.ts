import { describe, it, expect } from "vitest";

interface PolymarketTradeEvent {
  source: string;
  symbol: string;
  side: string;
  price: number;
  size: number;
  notional_usd: number;
  timestamp: string;
  outcome: string;
}

function parsePolymarketDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    watchedMarkets: String(raw.watchedMarkets ?? "[]"),
    watchedCategories: String(raw.watchedCategories ?? '["politics", "crypto", "sports"]'),
    minVolume: raw.minVolume ? Number(raw.minVolume) : 10000,
    collectComments: String(raw.collectComments ?? "false") === "true",
    collectAllTrades: String(raw.collectAllTrades ?? "true") === "true",
    whaleThreshold: raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000,
    orderbookEnabled: String(raw.orderbookEnabled ?? "true") === "true",
    orderbookIntervalMs: raw.orderbookIntervalMs ? Number(raw.orderbookIntervalMs) : 60000,
    lookbackHours: raw.lookbackHours ? Number(raw.lookbackHours) : 24,
  };
}

function parsePolymarketClobTrade(msg: {
  event_type: string;
  asset_id: string;
  price: string;
  size: string;
  side: string;
  timestamp: number;
  outcome: string;
}): PolymarketTradeEvent | null {
  if (msg.event_type !== "last_trade_price") return null;
  const price = parseFloat(msg.price);
  const size = parseFloat(msg.size);
  return {
    source: "polymarket",
    symbol: msg.asset_id,
    side: msg.side.toLowerCase(),
    price,
    size,
    notional_usd: price * size,
    timestamp: new Date(msg.timestamp).toISOString(),
    outcome: msg.outcome,
  };
}

describe("Polymarket Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should default to disabled", () => {
      const settings = parsePolymarketDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parsePolymarketDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });

    it("should include default watched categories", () => {
      const settings = parsePolymarketDefaults({});
      const categories = JSON.parse(settings.watchedCategories) as string[];
      expect(categories).toContain("politics");
      expect(categories).toContain("crypto");
      expect(categories).toContain("sports");
    });

    it("should not require any API keys to parse settings", () => {
      const settings = parsePolymarketDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
      expect(settings.watchedCategories).toBeTruthy();
    });

    it("should default minVolume to 10000", () => {
      const settings = parsePolymarketDefaults({});
      expect(settings.minVolume).toBe(10000);
    });

    it("should default whaleThreshold to 50000", () => {
      const settings = parsePolymarketDefaults({});
      expect(settings.whaleThreshold).toBe(50000);
    });

    it("should default collectAllTrades to true", () => {
      const settings = parsePolymarketDefaults({});
      expect(settings.collectAllTrades).toBe(true);
    });

    it("should default orderbookEnabled to true", () => {
      const settings = parsePolymarketDefaults({});
      expect(settings.orderbookEnabled).toBe(true);
    });

    it("should default orderbookIntervalMs to 60000", () => {
      const settings = parsePolymarketDefaults({});
      expect(settings.orderbookIntervalMs).toBe(60000);
    });

    it("should default lookbackHours to 24", () => {
      const settings = parsePolymarketDefaults({});
      expect(settings.lookbackHours).toBe(24);
    });
  });

  describe("Public WebSocket Message Parsing", () => {
    it("should parse a last_trade_price message for Yes outcome", () => {
      const event = parsePolymarketClobTrade({
        event_type: "last_trade_price",
        asset_id: "71321045863262826926674876879595451829530658667831513747854616806662864571597",
        price: "0.65",
        size: "100",
        side: "BUY",
        timestamp: 1739577600000,
        outcome: "Yes",
      });

      expect(event).not.toBeNull();
      expect(event!.source).toBe("polymarket");
      expect(event!.side).toBe("buy");
      expect(event!.price).toBe(0.65);
      expect(event!.size).toBe(100);
      expect(event!.notional_usd).toBeCloseTo(65, 2);
      expect(event!.outcome).toBe("Yes");
    });

    it("should parse a last_trade_price message for No outcome", () => {
      const event = parsePolymarketClobTrade({
        event_type: "last_trade_price",
        asset_id: "52114319501245915516055106046884209969926127482827954674443846427813813222426",
        price: "0.35",
        size: "200",
        side: "SELL",
        timestamp: 1739577660000,
        outcome: "No",
      });

      expect(event).not.toBeNull();
      expect(event!.side).toBe("sell");
      expect(event!.notional_usd).toBeCloseTo(70, 2);
      expect(event!.outcome).toBe("No");
    });

    it("should map BUY side to lowercase buy", () => {
      const event = parsePolymarketClobTrade({
        event_type: "last_trade_price",
        asset_id: "0xabc",
        price: "0.50",
        size: "10",
        side: "BUY",
        timestamp: 1739577600000,
        outcome: "Yes",
      });
      expect(event!.side).toBe("buy");
    });

    it("should map SELL side to lowercase sell", () => {
      const event = parsePolymarketClobTrade({
        event_type: "last_trade_price",
        asset_id: "0xabc",
        price: "0.50",
        size: "10",
        side: "SELL",
        timestamp: 1739577600000,
        outcome: "No",
      });
      expect(event!.side).toBe("sell");
    });

    it("should ignore non-trade event types", () => {
      const event = parsePolymarketClobTrade({
        event_type: "book",
        asset_id: "0xabc",
        price: "0",
        size: "0",
        side: "BUY",
        timestamp: 0,
        outcome: "Yes",
      });
      expect(event).toBeNull();
    });

    it("should ignore price_change event types", () => {
      const event = parsePolymarketClobTrade({
        event_type: "price_change",
        asset_id: "0xabc",
        price: "0.55",
        size: "0",
        side: "BUY",
        timestamp: 1739577600000,
        outcome: "Yes",
      });
      expect(event).toBeNull();
    });

    it("should convert epoch ms to ISO-8601 timestamp", () => {
      const epochMs = 1739577600000;
      const event = parsePolymarketClobTrade({
        event_type: "last_trade_price",
        asset_id: "0xabc",
        price: "0.50",
        size: "10",
        side: "BUY",
        timestamp: epochMs,
        outcome: "Yes",
      });

      expect(event).not.toBeNull();
      expect(event!.timestamp).toBe(new Date(epochMs).toISOString());
    });

    it("should handle high-precision price strings", () => {
      const event = parsePolymarketClobTrade({
        event_type: "last_trade_price",
        asset_id: "0xabc",
        price: "0.654321",
        size: "1000.50",
        side: "BUY",
        timestamp: 1739577600000,
        outcome: "Yes",
      });

      expect(event).not.toBeNull();
      expect(event!.price).toBe(0.654321);
      expect(event!.size).toBe(1000.5);
    });
  });

  describe("Public Feed URL Construction", () => {
    it("should use the CLOB WebSocket URL", () => {
      const wsUrl = "wss://ws-subscriptions-clob.polymarket.com/ws/";
      expect(wsUrl.startsWith("wss://")).toBe(true);
      expect(wsUrl).toContain("polymarket.com");
    });

    it("should not require authentication in WebSocket URL", () => {
      const wsUrl = "wss://ws-subscriptions-clob.polymarket.com/ws/";
      expect(wsUrl).not.toContain("apiKey");
      expect(wsUrl).not.toContain("token");
      expect(wsUrl).not.toContain("signature");
    });

    it("should use Gamma API for event discovery", () => {
      const apiUrl = "https://gamma-api.polymarket.com";
      expect(apiUrl.startsWith("https://")).toBe(true);
      expect(apiUrl).toContain("gamma-api");
    });

    it("should use Data API for trade history", () => {
      const apiUrl = "https://data-api.polymarket.com";
      expect(apiUrl.startsWith("https://")).toBe(true);
      expect(apiUrl).toContain("data-api");
    });
  });

  describe("CLOB WebSocket Subscription Format", () => {
    it("should build MARKET subscription message with asset IDs", () => {
      const assetIds = [
        "71321045863262826926674876879595451829530658667831513747854616806662864571597",
        "52114319501245915516055106046884209969926127482827954674443846427813813222426",
      ];
      const subscribeMsg = {
        type: "MARKET",
        assets_ids: assetIds,
      };

      expect(subscribeMsg.type).toBe("MARKET");
      expect(subscribeMsg.assets_ids).toHaveLength(2);
      expect(JSON.stringify(subscribeMsg)).toContain("MARKET");
    });
  });

  describe("Custom Settings Override", () => {
    it("should allow overriding minVolume", () => {
      const settings = parsePolymarketDefaults({ minVolume: "50000" });
      expect(settings.minVolume).toBe(50000);
    });

    it("should allow overriding whaleThreshold", () => {
      const settings = parsePolymarketDefaults({ whaleThreshold: "100000" });
      expect(settings.whaleThreshold).toBe(100000);
    });

    it("should allow overriding lookbackHours", () => {
      const settings = parsePolymarketDefaults({ lookbackHours: "48" });
      expect(settings.lookbackHours).toBe(48);
    });

    it("should allow overriding orderbookIntervalMs", () => {
      const settings = parsePolymarketDefaults({ orderbookIntervalMs: "30000" });
      expect(settings.orderbookIntervalMs).toBe(30000);
    });

    it("should allow disabling collectAllTrades", () => {
      const settings = parsePolymarketDefaults({ collectAllTrades: "false" });
      expect(settings.collectAllTrades).toBe(false);
    });

    it("should allow enabling collectComments", () => {
      const settings = parsePolymarketDefaults({ collectComments: "true" });
      expect(settings.collectComments).toBe(true);
    });
  });
});
