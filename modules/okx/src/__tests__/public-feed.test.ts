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

function parseOkxDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    apiUrl: String(raw.apiUrl ?? "wss://ws.okx.com:8443/ws/v5/public"),
    restApiUrl: String(raw.restApiUrl ?? "https://www.okx.com/api/v5"),
    watchedPairs: String(raw.watchedPairs ?? '["BTC-USDT", "ETH-USDT", "SOL-USDT"]'),
  };
}

function parseOkxPublicTrade(msg: {
  arg: { channel: string; instId: string };
  data: Array<{
    instId: string;
    tradeId: string;
    px: string;
    sz: string;
    side: string;
    ts: string;
  }>;
}): TradeExecutedEvent[] {
  if (msg.arg.channel !== "trades" || !Array.isArray(msg.data)) return [];

  return msg.data.map((d) => {
    const price = parseFloat(d.px);
    const size = parseFloat(d.sz);
    return {
      source: "okx",
      symbol: d.instId,
      side: d.side as "buy" | "sell",
      price,
      size,
      notional_usd: price * size,
      timestamp: new Date(parseInt(d.ts, 10)).toISOString(),
    };
  });
}

describe("OKX Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use OKX public WebSocket URL by default", () => {
      const settings = parseOkxDefaults({});
      expect(settings.apiUrl).toBe("wss://ws.okx.com:8443/ws/v5/public");
    });

    it("should use OKX public REST URL by default", () => {
      const settings = parseOkxDefaults({});
      expect(settings.restApiUrl).toBe("https://www.okx.com/api/v5");
    });

    it("should include BTC-USDT and ETH-USDT in default watched pairs", () => {
      const settings = parseOkxDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("BTC-USDT");
      expect(pairs).toContain("ETH-USDT");
    });

    it("should include SOL-USDT in default watched pairs", () => {
      const settings = parseOkxDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("SOL-USDT");
    });

    it("should not require any API keys to parse settings", () => {
      const settings = parseOkxDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
      expect(settings.apiUrl).toBeTruthy();
      expect(settings.restApiUrl).toBeTruthy();
    });

    it("should default to disabled", () => {
      const settings = parseOkxDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parseOkxDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });
  });

  describe("Public WebSocket Message Parsing", () => {
    it("should parse a BTC-USDT trade message", () => {
      const events = parseOkxPublicTrade({
        arg: { channel: "trades", instId: "BTC-USDT" },
        data: [
          {
            instId: "BTC-USDT",
            tradeId: "123456",
            px: "97500.50",
            sz: "0.015",
            side: "buy",
            ts: "1739577600000",
          },
        ],
      });

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.source).toBe("okx");
      expect(event.symbol).toBe("BTC-USDT");
      expect(event.side).toBe("buy");
      expect(event.price).toBe(97500.5);
      expect(event.size).toBe(0.015);
      expect(event.notional_usd).toBeCloseTo(1462.5075, 2);
    });

    it("should parse an ETH-USDT trade message", () => {
      const events = parseOkxPublicTrade({
        arg: { channel: "trades", instId: "ETH-USDT" },
        data: [
          {
            instId: "ETH-USDT",
            tradeId: "789012",
            px: "3200.00",
            sz: "2.5",
            side: "sell",
            ts: "1739577660000",
          },
        ],
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.symbol).toBe("ETH-USDT");
      expect(events[0]!.side).toBe("sell");
      expect(events[0]!.notional_usd).toBe(8000);
    });

    it("should parse explicit buy side", () => {
      const events = parseOkxPublicTrade({
        arg: { channel: "trades", instId: "BTC-USDT" },
        data: [
          {
            instId: "BTC-USDT",
            tradeId: "1",
            px: "97000.00",
            sz: "0.01",
            side: "buy",
            ts: "1739577600000",
          },
        ],
      });
      expect(events[0]!.side).toBe("buy");
    });

    it("should parse explicit sell side", () => {
      const events = parseOkxPublicTrade({
        arg: { channel: "trades", instId: "BTC-USDT" },
        data: [
          {
            instId: "BTC-USDT",
            tradeId: "2",
            px: "97000.00",
            sz: "0.01",
            side: "sell",
            ts: "1739577600000",
          },
        ],
      });
      expect(events[0]!.side).toBe("sell");
    });

    it("should ignore non-trade channels", () => {
      const events = parseOkxPublicTrade({
        arg: { channel: "tickers", instId: "BTC-USDT" },
        data: [
          {
            instId: "BTC-USDT",
            tradeId: "0",
            px: "0",
            sz: "0",
            side: "buy",
            ts: "0",
          },
        ],
      });
      expect(events).toHaveLength(0);
    });

    it("should convert epoch ms timestamp to ISO-8601", () => {
      const epochMs = 1739577600000;
      const events = parseOkxPublicTrade({
        arg: { channel: "trades", instId: "BTC-USDT" },
        data: [
          {
            instId: "BTC-USDT",
            tradeId: "3",
            px: "97000.00",
            sz: "0.01",
            side: "buy",
            ts: String(epochMs),
          },
        ],
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.timestamp).toBe(new Date(epochMs).toISOString());
    });

    it("should handle high-precision price and quantity strings", () => {
      const events = parseOkxPublicTrade({
        arg: { channel: "trades", instId: "BTC-USDT" },
        data: [
          {
            instId: "BTC-USDT",
            tradeId: "4",
            px: "97123.45000000",
            sz: "0.00100000",
            side: "buy",
            ts: "1739577600000",
          },
        ],
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.price).toBe(97123.45);
      expect(events[0]!.size).toBe(0.001);
    });

    it("should parse multiple trades in a single push", () => {
      const events = parseOkxPublicTrade({
        arg: { channel: "trades", instId: "BTC-USDT" },
        data: [
          { instId: "BTC-USDT", tradeId: "100", px: "97000.00", sz: "0.01", side: "buy", ts: "1739577600000" },
          { instId: "BTC-USDT", tradeId: "101", px: "97001.00", sz: "0.02", side: "sell", ts: "1739577600100" },
          { instId: "BTC-USDT", tradeId: "102", px: "97002.00", sz: "0.03", side: "buy", ts: "1739577600200" },
        ],
      });

      expect(events).toHaveLength(3);
      expect(events[0]!.price).toBe(97000);
      expect(events[1]!.price).toBe(97001);
      expect(events[2]!.price).toBe(97002);
    });
  });

  describe("OKX Subscription Format", () => {
    it("should build correct subscription message for trades", () => {
      const pairs = ["BTC-USDT", "ETH-USDT"];
      const args = pairs.map((instId) => ({ channel: "trades", instId }));
      const subscribeMsg = JSON.stringify({ op: "subscribe", args });

      const parsed = JSON.parse(subscribeMsg);
      expect(parsed.op).toBe("subscribe");
      expect(parsed.args).toHaveLength(2);
      expect(parsed.args[0].channel).toBe("trades");
      expect(parsed.args[0].instId).toBe("BTC-USDT");
      expect(parsed.args[1].instId).toBe("ETH-USDT");
    });

    it("should not require authentication for public trades channel", () => {
      const subscribeMsg = JSON.stringify({
        op: "subscribe",
        args: [{ channel: "trades", instId: "BTC-USDT" }],
      });
      expect(subscribeMsg).not.toContain("apiKey");
      expect(subscribeMsg).not.toContain("passphrase");
      expect(subscribeMsg).not.toContain("sign");
    });
  });

  describe("Custom URL Override", () => {
    it("should allow overriding WebSocket URL", () => {
      const settings = parseOkxDefaults({
        apiUrl: "wss://custom-ws.example.com",
      });
      expect(settings.apiUrl).toBe("wss://custom-ws.example.com");
    });

    it("should allow overriding REST URL", () => {
      const settings = parseOkxDefaults({
        restApiUrl: "https://custom-api.example.com",
      });
      expect(settings.restApiUrl).toBe("https://custom-api.example.com");
    });
  });

  describe("OKX instId Format", () => {
    it("should use hyphenated format (BTC-USDT not BTCUSDT)", () => {
      const settings = parseOkxDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      for (const pair of pairs) {
        expect(pair).toMatch(/^[A-Z]+-[A-Z]+$/);
      }
    });
  });
});
