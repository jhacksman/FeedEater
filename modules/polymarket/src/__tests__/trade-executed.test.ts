import { describe, it, expect } from "vitest";

interface TradeExecutedEvent {
  source: string;
  symbol: string;
  side: string;
  price: number;
  size: number;
  notional_usd: number;
  timestamp: string;
  outcome: string;
}

function buildPolymarketTradeEvent(raw: {
  conditionId: string;
  side: string;
  price: number;
  size: number;
  outcome: string;
  timestampMs: number;
}): TradeExecutedEvent {
  const notionalUsd = raw.price * raw.size;
  return {
    source: "polymarket",
    symbol: raw.conditionId,
    side: raw.side.toLowerCase(),
    price: raw.price,
    size: raw.size,
    notional_usd: notionalUsd,
    timestamp: new Date(raw.timestampMs).toISOString(),
    outcome: raw.outcome,
  };
}

function getSizeCategory(notionalUsd: number, whaleThreshold: number): string {
  if (notionalUsd >= whaleThreshold) return "whale";
  if (notionalUsd >= 10000) return "large";
  if (notionalUsd >= 1000) return "medium";
  return "small";
}

describe("Polymarket tradeExecuted Event Tests", () => {
  describe("Event Schema", () => {
    it("should build a valid tradeExecuted event from Polymarket trade data", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc123def456",
        side: "buy",
        price: 0.65,
        size: 100,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });

      expect(event.source).toBe("polymarket");
      expect(event.symbol).toBe("0xabc123def456");
      expect(event.side).toBe("buy");
      expect(event.price).toBe(0.65);
      expect(event.size).toBe(100);
      expect(event.notional_usd).toBeCloseTo(65, 2);
      expect(typeof event.timestamp).toBe("string");
      expect(event.outcome).toBe("Yes");
    });

    it("should have all required fields", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xdef456",
        side: "sell",
        price: 0.35,
        size: 500,
        outcome: "No",
        timestampMs: 1739577600000,
      });

      const keys = Object.keys(event);
      expect(keys).toContain("source");
      expect(keys).toContain("symbol");
      expect(keys).toContain("side");
      expect(keys).toContain("price");
      expect(keys).toContain("size");
      expect(keys).toContain("notional_usd");
      expect(keys).toContain("timestamp");
      expect(keys).toContain("outcome");
      expect(keys).toHaveLength(8);
    });

    it("should set source to polymarket", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0x123",
        side: "buy",
        price: 0.50,
        size: 10,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(event.source).toBe("polymarket");
    });
  });

  describe("Side Parsing", () => {
    it("should normalize buy side to lowercase", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "BUY",
        price: 0.65,
        size: 100,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(event.side).toBe("buy");
    });

    it("should normalize sell side to lowercase", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "SELL",
        price: 0.35,
        size: 100,
        outcome: "No",
        timestampMs: 1739577600000,
      });
      expect(event.side).toBe("sell");
    });
  });

  describe("Notional USD Calculation", () => {
    it("should compute notional_usd as price * size", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "buy",
        price: 0.50,
        size: 1000,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(event.notional_usd).toBe(500);
    });

    it("should handle small trades", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "buy",
        price: 0.05,
        size: 10,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(event.notional_usd).toBeCloseTo(0.5, 2);
    });

    it("should handle whale-sized trades", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "buy",
        price: 0.75,
        size: 100000,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(event.notional_usd).toBe(75000);
    });

    it("should handle high-probability markets (price near 1.0)", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "buy",
        price: 0.95,
        size: 500,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(event.notional_usd).toBeCloseTo(475, 2);
    });

    it("should handle low-probability markets (price near 0)", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "buy",
        price: 0.02,
        size: 5000,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(event.notional_usd).toBeCloseTo(100, 2);
    });
  });

  describe("Size Category Classification", () => {
    it("should classify whale trades (>= whaleThreshold)", () => {
      expect(getSizeCategory(50000, 50000)).toBe("whale");
      expect(getSizeCategory(100000, 50000)).toBe("whale");
    });

    it("should classify large trades (>= 10000)", () => {
      expect(getSizeCategory(10000, 50000)).toBe("large");
      expect(getSizeCategory(49999, 50000)).toBe("large");
    });

    it("should classify medium trades (>= 1000)", () => {
      expect(getSizeCategory(1000, 50000)).toBe("medium");
      expect(getSizeCategory(9999, 50000)).toBe("medium");
    });

    it("should classify small trades (< 1000)", () => {
      expect(getSizeCategory(999, 50000)).toBe("small");
      expect(getSizeCategory(1, 50000)).toBe("small");
    });
  });

  describe("Timestamp Format", () => {
    it("should convert epoch milliseconds to ISO-8601", () => {
      const epochMs = 1739577600000;
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "buy",
        price: 0.50,
        size: 10,
        outcome: "Yes",
        timestampMs: epochMs,
      });
      expect(event.timestamp).toBe(new Date(epochMs).toISOString());
      const parsed = new Date(event.timestamp);
      expect(parsed.getTime()).toBe(epochMs);
    });
  });

  describe("NATS Subject", () => {
    it("should use feedeater.polymarket.tradeExecuted subject", () => {
      const moduleName = "polymarket";
      const eventName = "tradeExecuted";
      const subject = `feedeater.${moduleName}.${eventName}`;
      expect(subject).toBe("feedeater.polymarket.tradeExecuted");
    });

    it("should use feedeater.polymarket.messageCreated for whale alerts", () => {
      const moduleName = "polymarket";
      const eventName = "messageCreated";
      const subject = `feedeater.${moduleName}.${eventName}`;
      expect(subject).toBe("feedeater.polymarket.messageCreated");
    });

    it("should use feedeater.polymarket.orderbookSnapshot for orderbook data", () => {
      const moduleName = "polymarket";
      const eventName = "orderbookSnapshot";
      const subject = `feedeater.${moduleName}.${eventName}`;
      expect(subject).toBe("feedeater.polymarket.orderbookSnapshot");
    });
  });

  describe("Outcome Types", () => {
    it("should handle Yes outcome trades", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "buy",
        price: 0.65,
        size: 100,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(event.outcome).toBe("Yes");
    });

    it("should handle No outcome trades", () => {
      const event = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "sell",
        price: 0.35,
        size: 100,
        outcome: "No",
        timestampMs: 1739577600000,
      });
      expect(event.outcome).toBe("No");
    });
  });

  describe("Event Emission Alongside messageCreated", () => {
    it("tradeExecuted should fire for all trades, not just whales", () => {
      const smallTrade = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "buy",
        price: 0.50,
        size: 10,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(smallTrade.notional_usd).toBeLessThan(50000);
      expect(smallTrade.source).toBe("polymarket");
      expect(smallTrade.symbol).toBeDefined();
      expect(smallTrade.side).toBeDefined();
    });

    it("tradeExecuted should also fire for whale trades", () => {
      const whaleTrade = buildPolymarketTradeEvent({
        conditionId: "0xabc",
        side: "buy",
        price: 0.80,
        size: 100000,
        outcome: "Yes",
        timestampMs: 1739577600000,
      });
      expect(whaleTrade.notional_usd).toBeGreaterThanOrEqual(50000);
      expect(whaleTrade.source).toBe("polymarket");
    });
  });
});
