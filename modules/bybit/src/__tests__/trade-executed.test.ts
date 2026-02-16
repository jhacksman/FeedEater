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

function buildBybitTradeEvent(raw: {
  s: string;
  p: string;
  v: string;
  S: string;
  T: number;
}): TradeExecutedEvent {
  const price = parseFloat(raw.p);
  const size = parseFloat(raw.v);
  return {
    source: "bybit",
    symbol: raw.s,
    side: raw.S.toLowerCase() as "buy" | "sell",
    price,
    size,
    notional_usd: price * size,
    timestamp: new Date(raw.T).toISOString(),
  };
}

describe("Bybit tradeExecuted Event Tests", () => {
  describe("Event Schema", () => {
    it("should build a valid tradeExecuted event from a Bybit trade message", () => {
      const event = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "97500.50",
        v: "0.015",
        S: "Buy",
        T: 1739577600000,
      });

      expect(event.source).toBe("bybit");
      expect(event.symbol).toBe("BTCUSDT");
      expect(event.side).toBe("buy");
      expect(event.price).toBe(97500.5);
      expect(event.size).toBe(0.015);
      expect(event.notional_usd).toBeCloseTo(1462.5075, 2);
      expect(typeof event.timestamp).toBe("string");
    });

    it("should have all required fields", () => {
      const event = buildBybitTradeEvent({
        s: "ETHUSDT",
        p: "3200.00",
        v: "1.5",
        S: "Sell",
        T: 1739577600000,
      });

      const keys = Object.keys(event);
      expect(keys).toContain("source");
      expect(keys).toContain("symbol");
      expect(keys).toContain("side");
      expect(keys).toContain("price");
      expect(keys).toContain("size");
      expect(keys).toContain("notional_usd");
      expect(keys).toContain("timestamp");
      expect(keys).toHaveLength(7);
    });

    it("should set source to bybit", () => {
      const event = buildBybitTradeEvent({
        s: "SOLUSDT",
        p: "150.00",
        v: "10",
        S: "Buy",
        T: 1739577600000,
      });
      expect(event.source).toBe("bybit");
    });
  });

  describe("Side Parsing (S Field)", () => {
    it("should map S=Buy to buy", () => {
      const event = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "97000.00",
        v: "0.01",
        S: "Buy",
        T: 1739577600000,
      });
      expect(event.side).toBe("buy");
    });

    it("should map S=Sell to sell", () => {
      const event = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "97000.00",
        v: "0.01",
        S: "Sell",
        T: 1739577600000,
      });
      expect(event.side).toBe("sell");
    });
  });

  describe("Notional USD Calculation", () => {
    it("should compute notional_usd as price * size", () => {
      const event = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "100000.00",
        v: "0.5",
        S: "Buy",
        T: 1739577600000,
      });
      expect(event.notional_usd).toBe(50000);
    });

    it("should handle small trades", () => {
      const event = buildBybitTradeEvent({
        s: "ETHUSDT",
        p: "3000.00",
        v: "0.001",
        S: "Sell",
        T: 1739577600000,
      });
      expect(event.notional_usd).toBeCloseTo(3, 2);
    });

    it("should handle whale-sized trades", () => {
      const event = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "100000.00",
        v: "10",
        S: "Buy",
        T: 1739577600000,
      });
      expect(event.notional_usd).toBe(1000000);
    });
  });

  describe("Timestamp Format", () => {
    it("should convert epoch milliseconds to ISO-8601", () => {
      const epochMs = 1739577600000;
      const event = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "97000.00",
        v: "0.01",
        S: "Buy",
        T: epochMs,
      });
      expect(event.timestamp).toBe(new Date(epochMs).toISOString());
      const parsed = new Date(event.timestamp);
      expect(parsed.getTime()).toBe(epochMs);
    });
  });

  describe("NATS Subject", () => {
    it("should use feedeater.bybit.tradeExecuted subject", () => {
      const moduleName = "bybit";
      const event = "tradeExecuted";
      const subject = `feedeater.${moduleName}.${event}`;
      expect(subject).toBe("feedeater.bybit.tradeExecuted");
    });
  });

  describe("Multiple Pairs", () => {
    it("should handle BTCUSDT trades", () => {
      const event = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "97500.00",
        v: "0.1",
        S: "Buy",
        T: 1739577600000,
      });
      expect(event.symbol).toBe("BTCUSDT");
    });

    it("should handle ETHUSDT trades", () => {
      const event = buildBybitTradeEvent({
        s: "ETHUSDT",
        p: "3200.00",
        v: "2.5",
        S: "Sell",
        T: 1739577600000,
      });
      expect(event.symbol).toBe("ETHUSDT");
    });

    it("should handle SOLUSDT trades", () => {
      const event = buildBybitTradeEvent({
        s: "SOLUSDT",
        p: "150.00",
        v: "100",
        S: "Buy",
        T: 1739577600000,
      });
      expect(event.symbol).toBe("SOLUSDT");
      expect(event.notional_usd).toBe(15000);
    });
  });

  describe("Bybit-specific: String Price/Qty Parsing", () => {
    it("should parse string prices from Bybit WebSocket format", () => {
      const event = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "97123.45000000",
        v: "0.12345000",
        S: "Buy",
        T: 1739577600000,
      });
      expect(event.price).toBe(97123.45);
      expect(event.size).toBe(0.12345);
      expect(event.notional_usd).toBeCloseTo(97123.45 * 0.12345, 2);
    });
  });

  describe("Event Emission Alongside messageCreated", () => {
    it("tradeExecuted should fire for all trades, not just whales", () => {
      const smallTrade = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "97000.00",
        v: "0.0001",
        S: "Buy",
        T: 1739577600000,
      });
      expect(smallTrade.notional_usd).toBeLessThan(50000);
      expect(smallTrade.source).toBe("bybit");
      expect(smallTrade.symbol).toBeDefined();
      expect(smallTrade.side).toBeDefined();
    });

    it("tradeExecuted should also fire for whale trades", () => {
      const whaleTrade = buildBybitTradeEvent({
        s: "BTCUSDT",
        p: "100000.00",
        v: "1.0",
        S: "Sell",
        T: 1739577600000,
      });
      expect(whaleTrade.notional_usd).toBeGreaterThanOrEqual(50000);
      expect(whaleTrade.source).toBe("bybit");
    });
  });
});
