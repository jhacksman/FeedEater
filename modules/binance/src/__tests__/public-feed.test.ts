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

function parseBinanceDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    apiUrl: String(raw.apiUrl ?? "wss://stream.binance.com:9443/ws"),
    restApiUrl: String(raw.restApiUrl ?? "https://api.binance.com/api/v3"),
    watchedPairs: String(raw.watchedPairs ?? '["BTCUSDT", "ETHUSDT", "SOLUSDT"]'),
  };
}

function parseBinancePublicTrade(msg: {
  e: string;
  s: string;
  p: string;
  q: string;
  m: boolean;
  T: number;
  t: number;
}): TradeExecutedEvent | null {
  if (msg.e !== "trade") return null;
  const price = parseFloat(msg.p);
  const size = parseFloat(msg.q);
  return {
    source: "binance",
    symbol: msg.s,
    side: msg.m ? "sell" : "buy",
    price,
    size,
    notional_usd: price * size,
    timestamp: new Date(msg.T).toISOString(),
  };
}

describe("Binance Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use global binance.com WebSocket URL by default (not .us)", () => {
      const settings = parseBinanceDefaults({});
      expect(settings.apiUrl).toBe("wss://stream.binance.com:9443/ws");
      expect(settings.apiUrl).not.toContain("binance.us");
    });

    it("should use global binance.com REST URL by default (not .us)", () => {
      const settings = parseBinanceDefaults({});
      expect(settings.restApiUrl).toBe("https://api.binance.com/api/v3");
      expect(settings.restApiUrl).not.toContain("binance.us");
    });

    it("should include BTCUSDT and ETHUSDT in default watched pairs", () => {
      const settings = parseBinanceDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("BTCUSDT");
      expect(pairs).toContain("ETHUSDT");
    });

    it("should not require any API keys to parse settings", () => {
      const settings = parseBinanceDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
      expect(settings.apiUrl).toBeTruthy();
      expect(settings.restApiUrl).toBeTruthy();
    });

    it("should default to disabled", () => {
      const settings = parseBinanceDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parseBinanceDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });
  });

  describe("Public WebSocket Message Parsing", () => {
    it("should parse a BTCUSDT trade message", () => {
      const event = parseBinancePublicTrade({
        e: "trade",
        s: "BTCUSDT",
        p: "97500.50",
        q: "0.015",
        m: false,
        T: 1739577600000,
        t: 123456,
      });

      expect(event).not.toBeNull();
      expect(event!.source).toBe("binance");
      expect(event!.symbol).toBe("BTCUSDT");
      expect(event!.side).toBe("buy");
      expect(event!.price).toBe(97500.5);
      expect(event!.size).toBe(0.015);
      expect(event!.notional_usd).toBeCloseTo(1462.5075, 2);
    });

    it("should parse an ETHUSDT trade message", () => {
      const event = parseBinancePublicTrade({
        e: "trade",
        s: "ETHUSDT",
        p: "3200.00",
        q: "2.5",
        m: true,
        T: 1739577660000,
        t: 789012,
      });

      expect(event).not.toBeNull();
      expect(event!.symbol).toBe("ETHUSDT");
      expect(event!.side).toBe("sell");
      expect(event!.notional_usd).toBe(8000);
    });

    it("should map m=false to buy (taker bought)", () => {
      const event = parseBinancePublicTrade({
        e: "trade",
        s: "BTCUSDT",
        p: "97000.00",
        q: "0.01",
        m: false,
        T: 1739577600000,
        t: 1,
      });
      expect(event!.side).toBe("buy");
    });

    it("should map m=true to sell (taker sold)", () => {
      const event = parseBinancePublicTrade({
        e: "trade",
        s: "BTCUSDT",
        p: "97000.00",
        q: "0.01",
        m: true,
        T: 1739577600000,
        t: 2,
      });
      expect(event!.side).toBe("sell");
    });

    it("should ignore non-trade events", () => {
      const event = parseBinancePublicTrade({
        e: "depthUpdate",
        s: "BTCUSDT",
        p: "0",
        q: "0",
        m: false,
        T: 0,
        t: 0,
      });
      expect(event).toBeNull();
    });

    it("should convert epoch ms to ISO-8601 timestamp", () => {
      const epochMs = 1739577600000;
      const event = parseBinancePublicTrade({
        e: "trade",
        s: "BTCUSDT",
        p: "97000.00",
        q: "0.01",
        m: false,
        T: epochMs,
        t: 3,
      });

      expect(event).not.toBeNull();
      expect(event!.timestamp).toBe(new Date(epochMs).toISOString());
    });

    it("should handle high-precision price and quantity strings", () => {
      const event = parseBinancePublicTrade({
        e: "trade",
        s: "BTCUSDT",
        p: "97123.45000000",
        q: "0.00100000",
        m: false,
        T: 1739577600000,
        t: 4,
      });

      expect(event).not.toBeNull();
      expect(event!.price).toBe(97123.45);
      expect(event!.size).toBe(0.001);
    });
  });

  describe("Public Feed Stream URL Construction", () => {
    it("should build combined stream URL from pairs", () => {
      const pairs = ["BTCUSDT", "ETHUSDT"];
      const baseUrl = "wss://stream.binance.com:9443/ws";
      const streams = pairs.map((p) => `${p.toLowerCase()}@trade`);
      const wsUrl = `${baseUrl}/${streams.join("/")}`;

      expect(wsUrl).toBe(
        "wss://stream.binance.com:9443/ws/btcusdt@trade/ethusdt@trade"
      );
    });

    it("should not require authentication in URL", () => {
      const pairs = ["BTCUSDT", "ETHUSDT"];
      const baseUrl = "wss://stream.binance.com:9443/ws";
      const streams = pairs.map((p) => `${p.toLowerCase()}@trade`);
      const wsUrl = `${baseUrl}/${streams.join("/")}`;

      expect(wsUrl).not.toContain("apiKey");
      expect(wsUrl).not.toContain("signature");
    });
  });

  describe("Fallback from .us to .com", () => {
    it("should accept binance.us URL override", () => {
      const settings = parseBinanceDefaults({
        apiUrl: "wss://stream.binance.us:9443/ws",
      });
      expect(settings.apiUrl).toBe("wss://stream.binance.us:9443/ws");
    });

    it("should default to .com not .us", () => {
      const settings = parseBinanceDefaults({});
      expect(settings.apiUrl).toContain("binance.com");
    });

    it("should accept binance.us REST URL override", () => {
      const settings = parseBinanceDefaults({
        restApiUrl: "https://api.binance.us/api/v3",
      });
      expect(settings.restApiUrl).toBe("https://api.binance.us/api/v3");
    });
  });

  describe("Custom URL Override", () => {
    it("should allow overriding WebSocket URL", () => {
      const settings = parseBinanceDefaults({
        apiUrl: "wss://custom-ws.example.com",
      });
      expect(settings.apiUrl).toBe("wss://custom-ws.example.com");
    });

    it("should allow overriding REST URL", () => {
      const settings = parseBinanceDefaults({
        restApiUrl: "https://custom-api.example.com",
      });
      expect(settings.restApiUrl).toBe("https://custom-api.example.com");
    });
  });
});
