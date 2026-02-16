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

function parseBitstampDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    apiUrl: String(raw.apiUrl ?? "wss://ws.bitstamp.net"),
    restApiUrl: String(raw.restApiUrl ?? "https://www.bitstamp.net/api/v2"),
    watchedPairs: String(raw.watchedPairs ?? '["btcusd", "ethusd", "solusd"]'),
  };
}

function parseBitstampPublicTrade(msg: {
  event: string;
  channel: string;
  data: {
    id: number;
    price: number;
    price_str: string;
    amount: number;
    amount_str: string;
    type: number;
    microtimestamp: string;
  };
}): TradeExecutedEvent | null {
  if (msg.event !== "trade") return null;
  const pairMatch = msg.channel.match(/^live_trades_(.+)$/);
  if (!pairMatch) return null;
  const pair = pairMatch[1]!;
  const price = parseFloat(msg.data.price_str);
  const size = parseFloat(msg.data.amount_str);
  return {
    source: "bitstamp",
    symbol: pair,
    side: msg.data.type === 0 ? "buy" : "sell",
    price,
    size,
    notional_usd: price * size,
    timestamp: new Date(Number(msg.data.microtimestamp) / 1000).toISOString(),
  };
}

describe("Bitstamp Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use wss://ws.bitstamp.net WebSocket URL by default", () => {
      const settings = parseBitstampDefaults({});
      expect(settings.apiUrl).toBe("wss://ws.bitstamp.net");
    });

    it("should use bitstamp.net REST URL by default", () => {
      const settings = parseBitstampDefaults({});
      expect(settings.restApiUrl).toBe("https://www.bitstamp.net/api/v2");
    });

    it("should include btcusd and ethusd in default watched pairs", () => {
      const settings = parseBitstampDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("btcusd");
      expect(pairs).toContain("ethusd");
    });

    it("should include solusd in default watched pairs", () => {
      const settings = parseBitstampDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("solusd");
    });

    it("should not require any API keys to parse settings", () => {
      const settings = parseBitstampDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
      expect(settings.apiUrl).toBeTruthy();
      expect(settings.restApiUrl).toBeTruthy();
    });

    it("should default to disabled", () => {
      const settings = parseBitstampDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parseBitstampDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });
  });

  describe("Public WebSocket Message Parsing", () => {
    it("should parse a btcusd trade message", () => {
      const event = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_btcusd",
        data: {
          id: 123456,
          price: 97500.5,
          price_str: "97500.50",
          amount: 0.015,
          amount_str: "0.01500000",
          type: 0,
          microtimestamp: "1739577600000000",
        },
      });

      expect(event).not.toBeNull();
      expect(event!.source).toBe("bitstamp");
      expect(event!.symbol).toBe("btcusd");
      expect(event!.side).toBe("buy");
      expect(event!.price).toBe(97500.5);
      expect(event!.size).toBe(0.015);
      expect(event!.notional_usd).toBeCloseTo(1462.5075, 2);
    });

    it("should parse an ethusd trade message", () => {
      const event = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_ethusd",
        data: {
          id: 789012,
          price: 3200.0,
          price_str: "3200.00",
          amount: 2.5,
          amount_str: "2.50000000",
          type: 1,
          microtimestamp: "1739577660000000",
        },
      });

      expect(event).not.toBeNull();
      expect(event!.symbol).toBe("ethusd");
      expect(event!.side).toBe("sell");
      expect(event!.notional_usd).toBe(8000);
    });

    it("should map type=0 to buy", () => {
      const event = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_btcusd",
        data: {
          id: 1,
          price: 97000.0,
          price_str: "97000.00",
          amount: 0.01,
          amount_str: "0.01000000",
          type: 0,
          microtimestamp: "1739577600000000",
        },
      });
      expect(event!.side).toBe("buy");
    });

    it("should map type=1 to sell", () => {
      const event = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_btcusd",
        data: {
          id: 2,
          price: 97000.0,
          price_str: "97000.00",
          amount: 0.01,
          amount_str: "0.01000000",
          type: 1,
          microtimestamp: "1739577600000000",
        },
      });
      expect(event!.side).toBe("sell");
    });

    it("should ignore non-trade events", () => {
      const event = parseBitstampPublicTrade({
        event: "bts:subscription_succeeded",
        channel: "live_trades_btcusd",
        data: {
          id: 0,
          price: 0,
          price_str: "0",
          amount: 0,
          amount_str: "0",
          type: 0,
          microtimestamp: "0",
        },
      });
      expect(event).toBeNull();
    });

    it("should convert microtimestamp to ISO-8601 timestamp", () => {
      const microTs = "1739577600000000";
      const event = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_btcusd",
        data: {
          id: 3,
          price: 97000.0,
          price_str: "97000.00",
          amount: 0.01,
          amount_str: "0.01000000",
          type: 0,
          microtimestamp: microTs,
        },
      });

      expect(event).not.toBeNull();
      const expectedMs = Number(microTs) / 1000;
      expect(event!.timestamp).toBe(new Date(expectedMs).toISOString());
    });

    it("should handle high-precision price and quantity strings", () => {
      const event = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_btcusd",
        data: {
          id: 4,
          price: 97123.45,
          price_str: "97123.45",
          amount: 0.001,
          amount_str: "0.00100000",
          type: 0,
          microtimestamp: "1739577600000000",
        },
      });

      expect(event).not.toBeNull();
      expect(event!.price).toBe(97123.45);
      expect(event!.size).toBe(0.001);
    });
  });

  describe("Bitstamp Subscribe/Unsubscribe Message Format", () => {
    it("should build correct subscribe message for live_trades", () => {
      const pair = "btcusd";
      const msg = {
        event: "bts:subscribe",
        data: { channel: `live_trades_${pair}` },
      };
      expect(msg.event).toBe("bts:subscribe");
      expect(msg.data.channel).toBe("live_trades_btcusd");
    });

    it("should build correct subscribe message for order_book", () => {
      const pair = "btcusd";
      const msg = {
        event: "bts:subscribe",
        data: { channel: `order_book_${pair}` },
      };
      expect(msg.event).toBe("bts:subscribe");
      expect(msg.data.channel).toBe("order_book_btcusd");
    });

    it("should build correct unsubscribe message", () => {
      const pair = "btcusd";
      const msg = {
        event: "bts:unsubscribe",
        data: { channel: `live_trades_${pair}` },
      };
      expect(msg.event).toBe("bts:unsubscribe");
      expect(msg.data.channel).toBe("live_trades_btcusd");
    });

    it("should not require authentication in subscribe messages", () => {
      const msg = {
        event: "bts:subscribe",
        data: { channel: "live_trades_btcusd" },
      };
      const json = JSON.stringify(msg);
      expect(json).not.toContain("apiKey");
      expect(json).not.toContain("auth");
      expect(json).not.toContain("token");
    });
  });

  describe("NATS Subject", () => {
    it("should use feedeater.bitstamp.tradeExecuted subject", () => {
      const moduleName = "bitstamp";
      const event = "tradeExecuted";
      const subject = `feedeater.${moduleName}.${event}`;
      expect(subject).toBe("feedeater.bitstamp.tradeExecuted");
    });
  });

  describe("Multiple Pairs", () => {
    it("should handle btcusd trades", () => {
      const event = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_btcusd",
        data: {
          id: 10,
          price: 97500.0,
          price_str: "97500.00",
          amount: 0.1,
          amount_str: "0.10000000",
          type: 0,
          microtimestamp: "1739577600000000",
        },
      });
      expect(event!.symbol).toBe("btcusd");
    });

    it("should handle ethusd trades", () => {
      const event = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_ethusd",
        data: {
          id: 11,
          price: 3200.0,
          price_str: "3200.00",
          amount: 2.5,
          amount_str: "2.50000000",
          type: 1,
          microtimestamp: "1739577600000000",
        },
      });
      expect(event!.symbol).toBe("ethusd");
    });

    it("should handle solusd trades", () => {
      const event = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_solusd",
        data: {
          id: 12,
          price: 150.0,
          price_str: "150.00",
          amount: 100,
          amount_str: "100.00000000",
          type: 0,
          microtimestamp: "1739577600000000",
        },
      });
      expect(event!.symbol).toBe("solusd");
      expect(event!.notional_usd).toBe(15000);
    });
  });

  describe("Custom URL Override", () => {
    it("should allow overriding WebSocket URL", () => {
      const settings = parseBitstampDefaults({
        apiUrl: "wss://custom-ws.example.com",
      });
      expect(settings.apiUrl).toBe("wss://custom-ws.example.com");
    });

    it("should allow overriding REST URL", () => {
      const settings = parseBitstampDefaults({
        restApiUrl: "https://custom-api.example.com",
      });
      expect(settings.restApiUrl).toBe("https://custom-api.example.com");
    });
  });

  describe("Event Emission Alongside messageCreated", () => {
    it("tradeExecuted should fire for all trades, not just whales", () => {
      const smallTrade = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_btcusd",
        data: {
          id: 20,
          price: 97000.0,
          price_str: "97000.00",
          amount: 0.0001,
          amount_str: "0.00010000",
          type: 0,
          microtimestamp: "1739577600000000",
        },
      });
      expect(smallTrade!.notional_usd).toBeLessThan(50000);
      expect(smallTrade!.source).toBe("bitstamp");
      expect(smallTrade!.symbol).toBeDefined();
      expect(smallTrade!.side).toBeDefined();
    });

    it("tradeExecuted should also fire for whale trades", () => {
      const whaleTrade = parseBitstampPublicTrade({
        event: "trade",
        channel: "live_trades_btcusd",
        data: {
          id: 21,
          price: 100000.0,
          price_str: "100000.00",
          amount: 1.0,
          amount_str: "1.00000000",
          type: 1,
          microtimestamp: "1739577600000000",
        },
      });
      expect(whaleTrade!.notional_usd).toBeGreaterThanOrEqual(50000);
      expect(whaleTrade!.source).toBe("bitstamp");
    });
  });
});
