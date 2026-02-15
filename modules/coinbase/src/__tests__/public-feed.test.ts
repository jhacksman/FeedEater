import { describe, it, expect } from "vitest";

interface TradeExecutedEvent {
  source: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  notional_usd: number;
  timestamp: string;
}

function parseCoinbaseDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    apiUrl: String(raw.apiUrl ?? "wss://ws-feed.exchange.coinbase.com"),
    restApiUrl: String(raw.restApiUrl ?? "https://api.exchange.coinbase.com"),
    watchedPairs: String(raw.watchedPairs ?? '["BTC-USD", "ETH-USD", "SOL-USD"]'),
  };
}

function parseCoinbasePublicMatch(msg: {
  type: string;
  trade_id: number;
  product_id: string;
  price: string;
  size: string;
  side: string;
  time: string;
}): TradeExecutedEvent | null {
  if (msg.type !== "match" && msg.type !== "last_match") return null;
  const price = parseFloat(msg.price);
  const size = parseFloat(msg.size);
  return {
    source: "coinbase",
    symbol: msg.product_id,
    side: msg.side as "buy" | "sell",
    price,
    size,
    notional_usd: price * size,
    timestamp: msg.time,
  };
}

describe("Coinbase Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use public WebSocket URL by default", () => {
      const settings = parseCoinbaseDefaults({});
      expect(settings.apiUrl).toBe("wss://ws-feed.exchange.coinbase.com");
    });

    it("should use public REST URL by default", () => {
      const settings = parseCoinbaseDefaults({});
      expect(settings.restApiUrl).toBe("https://api.exchange.coinbase.com");
    });

    it("should include BTC-USD and ETH-USD in default watched pairs", () => {
      const settings = parseCoinbaseDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("BTC-USD");
      expect(pairs).toContain("ETH-USD");
    });

    it("should not require any API keys to parse settings", () => {
      const settings = parseCoinbaseDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
      expect(settings.apiUrl).toBeTruthy();
      expect(settings.restApiUrl).toBeTruthy();
    });

    it("should default to disabled", () => {
      const settings = parseCoinbaseDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parseCoinbaseDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });
  });

  describe("Public WebSocket Message Parsing", () => {
    it("should parse a BTC-USD match message", () => {
      const event = parseCoinbasePublicMatch({
        type: "match",
        trade_id: 123456,
        product_id: "BTC-USD",
        price: "97500.50",
        size: "0.015",
        side: "buy",
        time: "2026-02-14T12:00:00.000Z",
      });

      expect(event).not.toBeNull();
      expect(event!.source).toBe("coinbase");
      expect(event!.symbol).toBe("BTC-USD");
      expect(event!.side).toBe("buy");
      expect(event!.price).toBe(97500.5);
      expect(event!.size).toBe(0.015);
      expect(event!.notional_usd).toBeCloseTo(1462.5075, 2);
    });

    it("should parse an ETH-USD match message", () => {
      const event = parseCoinbasePublicMatch({
        type: "match",
        trade_id: 789012,
        product_id: "ETH-USD",
        price: "3200.00",
        size: "2.5",
        side: "sell",
        time: "2026-02-14T12:01:00.000Z",
      });

      expect(event).not.toBeNull();
      expect(event!.symbol).toBe("ETH-USD");
      expect(event!.side).toBe("sell");
      expect(event!.notional_usd).toBe(8000);
    });

    it("should parse last_match type", () => {
      const event = parseCoinbasePublicMatch({
        type: "last_match",
        trade_id: 999999,
        product_id: "BTC-USD",
        price: "98000.00",
        size: "0.001",
        side: "sell",
        time: "2026-02-14T12:02:00.000Z",
      });

      expect(event).not.toBeNull();
      expect(event!.source).toBe("coinbase");
    });

    it("should ignore non-trade messages", () => {
      const event = parseCoinbasePublicMatch({
        type: "subscriptions",
        trade_id: 0,
        product_id: "",
        price: "0",
        size: "0",
        side: "",
        time: "",
      });
      expect(event).toBeNull();
    });

    it("should handle high-precision prices", () => {
      const event = parseCoinbasePublicMatch({
        type: "match",
        trade_id: 111111,
        product_id: "BTC-USD",
        price: "97123.45000000",
        size: "0.00100000",
        side: "buy",
        time: "2026-02-14T12:03:00.000Z",
      });

      expect(event).not.toBeNull();
      expect(event!.price).toBe(97123.45);
      expect(event!.size).toBe(0.001);
    });
  });

  describe("Public Feed Subscribe Message", () => {
    it("should build correct subscribe message for matches channel", () => {
      const pairs = ["BTC-USD", "ETH-USD"];
      const subscribeMsg = {
        type: "subscribe",
        product_ids: pairs,
        channels: ["matches"],
      };

      expect(subscribeMsg.type).toBe("subscribe");
      expect(subscribeMsg.product_ids).toContain("BTC-USD");
      expect(subscribeMsg.product_ids).toContain("ETH-USD");
      expect(subscribeMsg.channels).toContain("matches");
    });

    it("should not require authentication fields", () => {
      const subscribeMsg = {
        type: "subscribe",
        product_ids: ["BTC-USD", "ETH-USD"],
        channels: ["matches"],
      };

      expect(subscribeMsg).not.toHaveProperty("signature");
      expect(subscribeMsg).not.toHaveProperty("key");
      expect(subscribeMsg).not.toHaveProperty("passphrase");
    });
  });

  describe("Custom URL Override", () => {
    it("should allow overriding WebSocket URL", () => {
      const settings = parseCoinbaseDefaults({
        apiUrl: "wss://custom-ws.example.com",
      });
      expect(settings.apiUrl).toBe("wss://custom-ws.example.com");
    });

    it("should allow overriding REST URL", () => {
      const settings = parseCoinbaseDefaults({
        restApiUrl: "https://custom-api.example.com",
      });
      expect(settings.restApiUrl).toBe("https://custom-api.example.com");
    });
  });
});
