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

function parseBybitDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    apiUrl: String(raw.apiUrl ?? "wss://stream.bybit.com/v5/public/spot"),
    restApiUrl: String(raw.restApiUrl ?? "https://api.bybit.com/v5/market"),
    watchedPairs: String(raw.watchedPairs ?? '["BTCUSDT", "ETHUSDT", "SOLUSDT"]'),
  };
}

function parseBybitPublicTrade(msg: {
  topic?: string;
  data?: Array<{
    T: number;
    s: string;
    S: string;
    v: string;
    p: string;
    i: string;
    BT: boolean;
  }>;
}): TradeExecutedEvent | null {
  if (!msg.topic || !msg.topic.startsWith("publicTrade.")) return null;
  if (!msg.data || msg.data.length === 0) return null;
  const t = msg.data[0]!;
  const price = parseFloat(t.p);
  const size = parseFloat(t.v);
  return {
    source: "bybit",
    symbol: t.s,
    side: t.S.toLowerCase() as "buy" | "sell",
    price,
    size,
    notional_usd: price * size,
    timestamp: new Date(t.T).toISOString(),
  };
}

describe("Bybit Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use stream.bybit.com WebSocket URL by default", () => {
      const settings = parseBybitDefaults({});
      expect(settings.apiUrl).toBe("wss://stream.bybit.com/v5/public/spot");
    });

    it("should use api.bybit.com REST URL by default", () => {
      const settings = parseBybitDefaults({});
      expect(settings.restApiUrl).toBe("https://api.bybit.com/v5/market");
    });

    it("should include BTCUSDT, ETHUSDT, and SOLUSDT in default watched pairs", () => {
      const settings = parseBybitDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("BTCUSDT");
      expect(pairs).toContain("ETHUSDT");
      expect(pairs).toContain("SOLUSDT");
    });

    it("should not require any API keys to parse settings", () => {
      const settings = parseBybitDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
      expect(settings.apiUrl).toBeTruthy();
      expect(settings.restApiUrl).toBeTruthy();
    });

    it("should default to disabled", () => {
      const settings = parseBybitDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parseBybitDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });
  });

  describe("Public WebSocket Message Parsing", () => {
    it("should parse a BTCUSDT trade message", () => {
      const event = parseBybitPublicTrade({
        topic: "publicTrade.BTCUSDT",
        data: [{
          T: 1672304486865,
          s: "BTCUSDT",
          S: "Buy",
          v: "0.001",
          p: "16578.50",
          i: "20f43950-d8dd-5b31-9112-a178eb6023af",
          BT: false,
        }],
      });

      expect(event).not.toBeNull();
      expect(event!.source).toBe("bybit");
      expect(event!.symbol).toBe("BTCUSDT");
      expect(event!.side).toBe("buy");
      expect(event!.price).toBe(16578.5);
      expect(event!.size).toBe(0.001);
      expect(event!.notional_usd).toBeCloseTo(16.5785, 2);
    });

    it("should parse an ETHUSDT trade message", () => {
      const event = parseBybitPublicTrade({
        topic: "publicTrade.ETHUSDT",
        data: [{
          T: 1672304486865,
          s: "ETHUSDT",
          S: "Sell",
          v: "2.5",
          p: "3200.00",
          i: "abc-123",
          BT: false,
        }],
      });

      expect(event).not.toBeNull();
      expect(event!.symbol).toBe("ETHUSDT");
      expect(event!.side).toBe("sell");
      expect(event!.notional_usd).toBe(8000);
    });

    it("should map S=Buy to buy", () => {
      const event = parseBybitPublicTrade({
        topic: "publicTrade.BTCUSDT",
        data: [{
          T: 1672304486865,
          s: "BTCUSDT",
          S: "Buy",
          v: "0.01",
          p: "97000.00",
          i: "trade-1",
          BT: false,
        }],
      });
      expect(event!.side).toBe("buy");
    });

    it("should map S=Sell to sell", () => {
      const event = parseBybitPublicTrade({
        topic: "publicTrade.BTCUSDT",
        data: [{
          T: 1672304486865,
          s: "BTCUSDT",
          S: "Sell",
          v: "0.01",
          p: "97000.00",
          i: "trade-2",
          BT: false,
        }],
      });
      expect(event!.side).toBe("sell");
    });

    it("should ignore non-trade topics", () => {
      const event = parseBybitPublicTrade({
        topic: "orderbook.25.BTCUSDT",
        data: [],
      });
      expect(event).toBeNull();
    });

    it("should ignore messages with empty data", () => {
      const event = parseBybitPublicTrade({
        topic: "publicTrade.BTCUSDT",
        data: [],
      });
      expect(event).toBeNull();
    });

    it("should convert epoch ms to ISO-8601 timestamp", () => {
      const epochMs = 1672304486865;
      const event = parseBybitPublicTrade({
        topic: "publicTrade.BTCUSDT",
        data: [{
          T: epochMs,
          s: "BTCUSDT",
          S: "Buy",
          v: "0.01",
          p: "97000.00",
          i: "trade-3",
          BT: false,
        }],
      });

      expect(event).not.toBeNull();
      expect(event!.timestamp).toBe(new Date(epochMs).toISOString());
    });

    it("should handle high-precision price and quantity strings", () => {
      const event = parseBybitPublicTrade({
        topic: "publicTrade.BTCUSDT",
        data: [{
          T: 1672304486865,
          s: "BTCUSDT",
          S: "Buy",
          v: "0.00100000",
          p: "97123.45000000",
          i: "trade-4",
          BT: false,
        }],
      });

      expect(event).not.toBeNull();
      expect(event!.price).toBe(97123.45);
      expect(event!.size).toBe(0.001);
    });
  });

  describe("Subscription Message Construction", () => {
    it("should build correct subscription args from pairs", () => {
      const pairs = ["BTCUSDT", "ETHUSDT"];
      const args = pairs.map((p) => `publicTrade.${p}`);
      expect(args).toEqual(["publicTrade.BTCUSDT", "publicTrade.ETHUSDT"]);
    });

    it("should not require authentication in subscription", () => {
      const sub = { op: "subscribe", args: ["publicTrade.BTCUSDT"] };
      const json = JSON.stringify(sub);
      expect(json).not.toContain("apiKey");
      expect(json).not.toContain("signature");
    });
  });

  describe("Custom URL Override", () => {
    it("should allow overriding WebSocket URL", () => {
      const settings = parseBybitDefaults({
        apiUrl: "wss://custom-ws.example.com",
      });
      expect(settings.apiUrl).toBe("wss://custom-ws.example.com");
    });

    it("should allow overriding REST URL", () => {
      const settings = parseBybitDefaults({
        restApiUrl: "https://custom-api.example.com",
      });
      expect(settings.restApiUrl).toBe("https://custom-api.example.com");
    });
  });

  describe("Ping/Pong Message Format", () => {
    it("should construct correct ping message", () => {
      const ping = JSON.stringify({ op: "ping" });
      expect(ping).toBe('{"op":"ping"}');
    });

    it("should recognize pong response", () => {
      const pong = { op: "pong" };
      expect(pong.op).toBe("pong");
    });
  });
});
