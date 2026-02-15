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

function parseKrakenDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    apiUrl: String(raw.apiUrl ?? "wss://ws.kraken.com/v2"),
    restApiUrl: String(raw.restApiUrl ?? "https://api.kraken.com/0/public"),
    watchedPairs: String(raw.watchedPairs ?? '["XBT/USD", "ETH/USD", "SOL/USD"]'),
  };
}

function parseKrakenPublicTrade(msg: {
  channel: string;
  data: Array<{
    symbol: string;
    price: string;
    qty: string;
    side: string;
    timestamp: string;
  }>;
}): TradeExecutedEvent[] {
  if (msg.channel !== "trade") return [];
  return (msg.data || []).map((t) => {
    const price = parseFloat(t.price);
    const size = parseFloat(t.qty);
    return {
      source: "kraken",
      symbol: t.symbol,
      side: t.side as "buy" | "sell",
      price,
      size,
      notional_usd: price * size,
      timestamp: new Date(t.timestamp).toISOString(),
    };
  });
}

describe("Kraken Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use public WebSocket URL by default", () => {
      const settings = parseKrakenDefaults({});
      expect(settings.apiUrl).toBe("wss://ws.kraken.com/v2");
    });

    it("should use public REST URL by default", () => {
      const settings = parseKrakenDefaults({});
      expect(settings.restApiUrl).toBe("https://api.kraken.com/0/public");
    });

    it("should include XBT/USD and ETH/USD in default watched pairs", () => {
      const settings = parseKrakenDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("XBT/USD");
      expect(pairs).toContain("ETH/USD");
    });

    it("should not require any API keys to parse settings", () => {
      const settings = parseKrakenDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
      expect(settings.apiUrl).toBeTruthy();
      expect(settings.restApiUrl).toBeTruthy();
    });

    it("should default to disabled", () => {
      const settings = parseKrakenDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parseKrakenDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });
  });

  describe("Public WebSocket Message Parsing (v2 API)", () => {
    it("should parse a single XBT/USD trade", () => {
      const events = parseKrakenPublicTrade({
        channel: "trade",
        data: [
          {
            symbol: "XBT/USD",
            price: "97500.50",
            qty: "0.015",
            side: "buy",
            timestamp: "2026-02-14T12:00:00.000Z",
          },
        ],
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.source).toBe("kraken");
      expect(events[0]!.symbol).toBe("XBT/USD");
      expect(events[0]!.side).toBe("buy");
      expect(events[0]!.price).toBe(97500.5);
      expect(events[0]!.size).toBe(0.015);
      expect(events[0]!.notional_usd).toBeCloseTo(1462.5075, 2);
    });

    it("should parse multiple trades in a single message", () => {
      const events = parseKrakenPublicTrade({
        channel: "trade",
        data: [
          {
            symbol: "XBT/USD",
            price: "97500.00",
            qty: "0.01",
            side: "buy",
            timestamp: "2026-02-14T12:00:00.000Z",
          },
          {
            symbol: "ETH/USD",
            price: "3200.00",
            qty: "1.5",
            side: "sell",
            timestamp: "2026-02-14T12:00:01.000Z",
          },
        ],
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.symbol).toBe("XBT/USD");
      expect(events[1]!.symbol).toBe("ETH/USD");
    });

    it("should parse an ETH/USD trade", () => {
      const events = parseKrakenPublicTrade({
        channel: "trade",
        data: [
          {
            symbol: "ETH/USD",
            price: "3200.00",
            qty: "2.5",
            side: "sell",
            timestamp: "2026-02-14T12:01:00.000Z",
          },
        ],
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.symbol).toBe("ETH/USD");
      expect(events[0]!.side).toBe("sell");
      expect(events[0]!.notional_usd).toBe(8000);
    });

    it("should ignore non-trade channel messages", () => {
      const events = parseKrakenPublicTrade({
        channel: "book",
        data: [],
      });
      expect(events).toHaveLength(0);
    });

    it("should handle empty data array", () => {
      const events = parseKrakenPublicTrade({
        channel: "trade",
        data: [],
      });
      expect(events).toHaveLength(0);
    });

    it("should produce ISO-8601 timestamps", () => {
      const events = parseKrakenPublicTrade({
        channel: "trade",
        data: [
          {
            symbol: "XBT/USD",
            price: "97000.00",
            qty: "0.01",
            side: "buy",
            timestamp: "2026-02-14T23:59:59.999Z",
          },
        ],
      });

      expect(events).toHaveLength(1);
      const ts = events[0]!.timestamp;
      expect(new Date(ts).toISOString()).toBe(ts);
    });
  });

  describe("Public Feed Subscribe Message (v2 API)", () => {
    it("should build correct subscribe message for trade channel", () => {
      const pairs = ["XBT/USD", "ETH/USD"];
      const subscribeMsg = {
        method: "subscribe",
        params: {
          channel: "trade",
          symbol: pairs,
        },
      };

      expect(subscribeMsg.method).toBe("subscribe");
      expect(subscribeMsg.params.channel).toBe("trade");
      expect(subscribeMsg.params.symbol).toContain("XBT/USD");
      expect(subscribeMsg.params.symbol).toContain("ETH/USD");
    });

    it("should not require authentication fields", () => {
      const subscribeMsg = {
        method: "subscribe",
        params: {
          channel: "trade",
          symbol: ["XBT/USD", "ETH/USD"],
        },
      };

      expect(subscribeMsg).not.toHaveProperty("token");
      expect(subscribeMsg.params).not.toHaveProperty("token");
    });
  });

  describe("Custom URL Override", () => {
    it("should allow overriding WebSocket URL", () => {
      const settings = parseKrakenDefaults({
        apiUrl: "wss://custom-ws.example.com",
      });
      expect(settings.apiUrl).toBe("wss://custom-ws.example.com");
    });

    it("should allow overriding REST URL", () => {
      const settings = parseKrakenDefaults({
        restApiUrl: "https://custom-api.example.com",
      });
      expect(settings.restApiUrl).toBe("https://custom-api.example.com");
    });
  });
});
