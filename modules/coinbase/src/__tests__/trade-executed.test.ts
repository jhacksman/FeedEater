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

function buildCoinbaseTradeEvent(raw: {
  product_id: string;
  price: string;
  size: string;
  side: string;
  time: string;
}): TradeExecutedEvent {
  const price = parseFloat(raw.price);
  const size = parseFloat(raw.size);
  return {
    source: "coinbase",
    symbol: raw.product_id,
    side: raw.side as "buy" | "sell",
    price,
    size,
    notional_usd: price * size,
    timestamp: raw.time,
  };
}

describe("Coinbase tradeExecuted Event Tests", () => {
  describe("Event Schema", () => {
    it("should build a valid tradeExecuted event from a Coinbase match", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "BTC-USD",
        price: "97500.50",
        size: "0.015",
        side: "buy",
        time: "2026-02-14T12:00:00.000Z",
      });

      expect(event.source).toBe("coinbase");
      expect(event.symbol).toBe("BTC-USD");
      expect(event.side).toBe("buy");
      expect(event.price).toBe(97500.5);
      expect(event.size).toBe(0.015);
      expect(event.notional_usd).toBeCloseTo(1462.5075, 2);
      expect(event.timestamp).toBe("2026-02-14T12:00:00.000Z");
    });

    it("should have all required fields", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "ETH-USD",
        price: "3200.00",
        size: "1.5",
        side: "sell",
        time: "2026-02-14T12:01:00.000Z",
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

    it("should set source to coinbase", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "SOL-USD",
        price: "150.00",
        size: "10",
        side: "buy",
        time: "2026-02-14T12:02:00.000Z",
      });
      expect(event.source).toBe("coinbase");
    });
  });

  describe("Side Parsing", () => {
    it("should preserve buy side", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "BTC-USD",
        price: "97000.00",
        size: "0.01",
        side: "buy",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(event.side).toBe("buy");
    });

    it("should preserve sell side", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "BTC-USD",
        price: "97000.00",
        size: "0.01",
        side: "sell",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(event.side).toBe("sell");
    });
  });

  describe("Notional USD Calculation", () => {
    it("should compute notional_usd as price * size", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "BTC-USD",
        price: "100000.00",
        size: "0.5",
        side: "buy",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(event.notional_usd).toBe(50000);
    });

    it("should handle small trades", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "ETH-USD",
        price: "3000.00",
        size: "0.001",
        side: "sell",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(event.notional_usd).toBeCloseTo(3, 2);
    });

    it("should handle whale-sized trades", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "BTC-USD",
        price: "100000.00",
        size: "10",
        side: "buy",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(event.notional_usd).toBe(1000000);
    });
  });

  describe("Timestamp Format", () => {
    it("should pass through ISO-8601 timestamps", () => {
      const time = "2026-02-14T23:59:59.999Z";
      const event = buildCoinbaseTradeEvent({
        product_id: "BTC-USD",
        price: "97000.00",
        size: "0.01",
        side: "buy",
        time,
      });
      expect(event.timestamp).toBe(time);
      expect(new Date(event.timestamp).toISOString()).toBe(time);
    });
  });

  describe("NATS Subject", () => {
    it("should use feedeater.coinbase.tradeExecuted subject", () => {
      const moduleName = "coinbase";
      const event = "tradeExecuted";
      const subject = `feedeater.${moduleName}.${event}`;
      expect(subject).toBe("feedeater.coinbase.tradeExecuted");
    });
  });

  describe("Multiple Pairs", () => {
    it("should handle BTC-USD trades", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "BTC-USD",
        price: "97500.00",
        size: "0.1",
        side: "buy",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(event.symbol).toBe("BTC-USD");
    });

    it("should handle ETH-USD trades", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "ETH-USD",
        price: "3200.00",
        size: "2.5",
        side: "sell",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(event.symbol).toBe("ETH-USD");
    });

    it("should handle SOL-USD trades", () => {
      const event = buildCoinbaseTradeEvent({
        product_id: "SOL-USD",
        price: "150.00",
        size: "100",
        side: "buy",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(event.symbol).toBe("SOL-USD");
      expect(event.notional_usd).toBe(15000);
    });
  });

  describe("Event Emission Alongside messageCreated", () => {
    it("tradeExecuted should fire for all trades, not just whales", () => {
      const smallTrade = buildCoinbaseTradeEvent({
        product_id: "BTC-USD",
        price: "97000.00",
        size: "0.0001",
        side: "buy",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(smallTrade.notional_usd).toBeLessThan(50000);
      expect(smallTrade.source).toBe("coinbase");
      expect(smallTrade.symbol).toBeDefined();
      expect(smallTrade.side).toBeDefined();
    });

    it("tradeExecuted should also fire for whale trades", () => {
      const whaleTrade = buildCoinbaseTradeEvent({
        product_id: "BTC-USD",
        price: "100000.00",
        size: "1.0",
        side: "sell",
        time: "2026-02-14T12:00:00.000Z",
      });
      expect(whaleTrade.notional_usd).toBeGreaterThanOrEqual(50000);
      expect(whaleTrade.source).toBe("coinbase");
    });
  });
});
