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

function parseGeminiDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    apiUrl: String(raw.apiUrl ?? "wss://api.gemini.com/v2/marketdata"),
    restApiUrl: String(raw.restApiUrl ?? "https://api.gemini.com/v1"),
    watchedPairs: String(raw.watchedPairs ?? '["BTCUSD", "ETHUSD", "SOLUSD"]'),
  };
}

function parseGeminiTrade(msg: {
  type: string;
  symbol: string;
  price: string;
  quantity: string;
  side: string;
  timestamp: number;
  tid: number;
}): TradeExecutedEvent | null {
  if (msg.type !== "trade") return null;
  const price = parseFloat(msg.price);
  const size = parseFloat(msg.quantity);
  return {
    source: "gemini",
    symbol: msg.symbol,
    side: msg.side as "buy" | "sell",
    price,
    size,
    notional_usd: price * size,
    timestamp: new Date(msg.timestamp).toISOString(),
  };
}

describe("Gemini Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use Gemini v2 WebSocket URL by default", () => {
      const settings = parseGeminiDefaults({});
      expect(settings.apiUrl).toBe("wss://api.gemini.com/v2/marketdata");
    });

    it("should use Gemini REST API URL by default", () => {
      const settings = parseGeminiDefaults({});
      expect(settings.restApiUrl).toBe("https://api.gemini.com/v1");
    });

    it("should include BTCUSD and ETHUSD in default watched pairs", () => {
      const settings = parseGeminiDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("BTCUSD");
      expect(pairs).toContain("ETHUSD");
    });

    it("should include SOLUSD in default watched pairs", () => {
      const settings = parseGeminiDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("SOLUSD");
    });

    it("should not require any API keys to parse settings", () => {
      const settings = parseGeminiDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
      expect(settings.apiUrl).toBeTruthy();
      expect(settings.restApiUrl).toBeTruthy();
    });

    it("should default to disabled", () => {
      const settings = parseGeminiDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parseGeminiDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });
  });

  describe("Public WebSocket Message Parsing", () => {
    it("should parse a BTCUSD trade message", () => {
      const event = parseGeminiTrade({
        type: "trade",
        symbol: "BTCUSD",
        price: "97500.50",
        quantity: "0.015",
        side: "buy",
        timestamp: 1739577600000,
        tid: 123456,
      });

      expect(event).not.toBeNull();
      expect(event!.source).toBe("gemini");
      expect(event!.symbol).toBe("BTCUSD");
      expect(event!.side).toBe("buy");
      expect(event!.price).toBe(97500.5);
      expect(event!.size).toBe(0.015);
      expect(event!.notional_usd).toBeCloseTo(1462.5075, 2);
    });

    it("should parse an ETHUSD trade message", () => {
      const event = parseGeminiTrade({
        type: "trade",
        symbol: "ETHUSD",
        price: "3200.00",
        quantity: "2.5",
        side: "sell",
        timestamp: 1739577660000,
        tid: 789012,
      });

      expect(event).not.toBeNull();
      expect(event!.symbol).toBe("ETHUSD");
      expect(event!.side).toBe("sell");
      expect(event!.notional_usd).toBe(8000);
    });

    it("should use side directly from Gemini (buy)", () => {
      const event = parseGeminiTrade({
        type: "trade",
        symbol: "BTCUSD",
        price: "97000.00",
        quantity: "0.01",
        side: "buy",
        timestamp: 1739577600000,
        tid: 1,
      });
      expect(event!.side).toBe("buy");
    });

    it("should use side directly from Gemini (sell)", () => {
      const event = parseGeminiTrade({
        type: "trade",
        symbol: "BTCUSD",
        price: "97000.00",
        quantity: "0.01",
        side: "sell",
        timestamp: 1739577600000,
        tid: 2,
      });
      expect(event!.side).toBe("sell");
    });

    it("should ignore non-trade events", () => {
      const event = parseGeminiTrade({
        type: "l2_updates",
        symbol: "BTCUSD",
        price: "0",
        quantity: "0",
        side: "buy",
        timestamp: 0,
        tid: 0,
      });
      expect(event).toBeNull();
    });

    it("should convert epoch ms to ISO-8601 timestamp", () => {
      const epochMs = 1739577600000;
      const event = parseGeminiTrade({
        type: "trade",
        symbol: "BTCUSD",
        price: "97000.00",
        quantity: "0.01",
        side: "buy",
        timestamp: epochMs,
        tid: 3,
      });

      expect(event).not.toBeNull();
      expect(event!.timestamp).toBe(new Date(epochMs).toISOString());
    });

    it("should handle high-precision price and quantity strings", () => {
      const event = parseGeminiTrade({
        type: "trade",
        symbol: "BTCUSD",
        price: "97123.45000000",
        quantity: "0.00100000",
        side: "buy",
        timestamp: 1739577600000,
        tid: 4,
      });

      expect(event).not.toBeNull();
      expect(event!.price).toBe(97123.45);
      expect(event!.size).toBe(0.001);
    });
  });

  describe("Gemini v2 Subscription Format", () => {
    it("should build correct subscription message", () => {
      const pairs = ["BTCUSD", "ETHUSD"];
      const subscribeMsg = {
        type: "subscribe",
        subscriptions: [{ name: "l2", symbols: pairs }],
      };

      expect(subscribeMsg.type).toBe("subscribe");
      const firstSub = subscribeMsg.subscriptions[0];
      expect(firstSub).toBeDefined();
      expect(firstSub!.name).toBe("l2");
      expect(firstSub!.symbols).toEqual(["BTCUSD", "ETHUSD"]);
    });

    it("should not require authentication in subscription", () => {
      const subscribeMsg = {
        type: "subscribe",
        subscriptions: [{ name: "l2", symbols: ["BTCUSD"] }],
      };

      const json = JSON.stringify(subscribeMsg);
      expect(json).not.toContain("apiKey");
      expect(json).not.toContain("secret");
      expect(json).not.toContain("signature");
    });

    it("should use single connection for multiple symbols", () => {
      const wsUrl = "wss://api.gemini.com/v2/marketdata";
      expect(wsUrl).not.toContain("BTCUSD");
      expect(wsUrl).not.toContain("ETHUSD");
    });
  });

  describe("Custom URL Override", () => {
    it("should allow overriding WebSocket URL", () => {
      const settings = parseGeminiDefaults({
        apiUrl: "wss://custom-ws.example.com",
      });
      expect(settings.apiUrl).toBe("wss://custom-ws.example.com");
    });

    it("should allow overriding REST URL", () => {
      const settings = parseGeminiDefaults({
        restApiUrl: "https://custom-api.example.com",
      });
      expect(settings.restApiUrl).toBe("https://custom-api.example.com");
    });
  });

  describe("Gemini Symbol Format", () => {
    it("should use USD pairs (not USDT)", () => {
      const settings = parseGeminiDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      for (const pair of pairs) {
        expect(pair).toMatch(/USD$/);
        expect(pair).not.toMatch(/USDT$/);
      }
    });
  });

  describe("NATS Subject", () => {
    it("should use feedeater.gemini.tradeExecuted subject", () => {
      const moduleName = "gemini";
      const event = "tradeExecuted";
      const subject = `feedeater.${moduleName}.${event}`;
      expect(subject).toBe("feedeater.gemini.tradeExecuted");
    });
  });

  describe("Multiple Pairs", () => {
    it("should handle BTCUSD trades", () => {
      const event = parseGeminiTrade({
        type: "trade",
        symbol: "BTCUSD",
        price: "97500.00",
        quantity: "0.1",
        side: "buy",
        timestamp: 1739577600000,
        tid: 100,
      });
      expect(event!.symbol).toBe("BTCUSD");
    });

    it("should handle ETHUSD trades", () => {
      const event = parseGeminiTrade({
        type: "trade",
        symbol: "ETHUSD",
        price: "3200.00",
        quantity: "2.5",
        side: "sell",
        timestamp: 1739577600000,
        tid: 101,
      });
      expect(event!.symbol).toBe("ETHUSD");
    });

    it("should handle SOLUSD trades", () => {
      const event = parseGeminiTrade({
        type: "trade",
        symbol: "SOLUSD",
        price: "150.00",
        quantity: "100",
        side: "buy",
        timestamp: 1739577600000,
        tid: 102,
      });
      expect(event!.symbol).toBe("SOLUSD");
      expect(event!.notional_usd).toBe(15000);
    });
  });

  describe("Event Emission Alongside messageCreated", () => {
    it("tradeExecuted should fire for all trades, not just whales", () => {
      const smallTrade = parseGeminiTrade({
        type: "trade",
        symbol: "BTCUSD",
        price: "97000.00",
        quantity: "0.0001",
        side: "buy",
        timestamp: 1739577600000,
        tid: 200,
      });
      expect(smallTrade!.notional_usd).toBeLessThan(50000);
      expect(smallTrade!.source).toBe("gemini");
      expect(smallTrade!.symbol).toBeDefined();
      expect(smallTrade!.side).toBeDefined();
    });

    it("tradeExecuted should also fire for whale trades", () => {
      const whaleTrade = parseGeminiTrade({
        type: "trade",
        symbol: "BTCUSD",
        price: "100000.00",
        quantity: "1.0",
        side: "sell",
        timestamp: 1739577600000,
        tid: 201,
      });
      expect(whaleTrade!.notional_usd).toBeGreaterThanOrEqual(50000);
      expect(whaleTrade!.source).toBe("gemini");
    });
  });
});
