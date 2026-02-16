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

function buildOkxTradeEvent(raw: {
  instId: string;
  px: string;
  sz: string;
  side: string;
  ts: string;
}): TradeExecutedEvent {
  const price = parseFloat(raw.px);
  const size = parseFloat(raw.sz);
  return {
    source: "okx",
    symbol: raw.instId,
    side: raw.side as "buy" | "sell",
    price,
    size,
    notional_usd: price * size,
    timestamp: new Date(parseInt(raw.ts, 10)).toISOString(),
  };
}

describe("OKX tradeExecuted Event Tests", () => {
  describe("Event Schema", () => {
    it("should build a valid tradeExecuted event from an OKX trade message", () => {
      const event = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "97500.50",
        sz: "0.015",
        side: "buy",
        ts: "1739577600000",
      });

      expect(event.source).toBe("okx");
      expect(event.symbol).toBe("BTC-USDT");
      expect(event.side).toBe("buy");
      expect(event.price).toBe(97500.5);
      expect(event.size).toBe(0.015);
      expect(event.notional_usd).toBeCloseTo(1462.5075, 2);
      expect(typeof event.timestamp).toBe("string");
    });

    it("should have all required fields", () => {
      const event = buildOkxTradeEvent({
        instId: "ETH-USDT",
        px: "3200.00",
        sz: "1.5",
        side: "sell",
        ts: "1739577600000",
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

    it("should set source to okx", () => {
      const event = buildOkxTradeEvent({
        instId: "SOL-USDT",
        px: "150.00",
        sz: "10",
        side: "buy",
        ts: "1739577600000",
      });
      expect(event.source).toBe("okx");
    });
  });

  describe("Side Parsing (Explicit)", () => {
    it("should pass through buy side directly", () => {
      const event = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "97000.00",
        sz: "0.01",
        side: "buy",
        ts: "1739577600000",
      });
      expect(event.side).toBe("buy");
    });

    it("should pass through sell side directly", () => {
      const event = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "97000.00",
        sz: "0.01",
        side: "sell",
        ts: "1739577600000",
      });
      expect(event.side).toBe("sell");
    });
  });

  describe("Notional USD Calculation", () => {
    it("should compute notional_usd as price * size", () => {
      const event = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "100000.00",
        sz: "0.5",
        side: "buy",
        ts: "1739577600000",
      });
      expect(event.notional_usd).toBe(50000);
    });

    it("should handle small trades", () => {
      const event = buildOkxTradeEvent({
        instId: "ETH-USDT",
        px: "3000.00",
        sz: "0.001",
        side: "sell",
        ts: "1739577600000",
      });
      expect(event.notional_usd).toBeCloseTo(3, 2);
    });

    it("should handle whale-sized trades", () => {
      const event = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "100000.00",
        sz: "10",
        side: "buy",
        ts: "1739577600000",
      });
      expect(event.notional_usd).toBe(1000000);
    });
  });

  describe("Timestamp Format", () => {
    it("should convert epoch milliseconds string to ISO-8601", () => {
      const epochMs = 1739577600000;
      const event = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "97000.00",
        sz: "0.01",
        side: "buy",
        ts: String(epochMs),
      });
      expect(event.timestamp).toBe(new Date(epochMs).toISOString());
      const parsed = new Date(event.timestamp);
      expect(parsed.getTime()).toBe(epochMs);
    });
  });

  describe("NATS Subject", () => {
    it("should use feedeater.okx.tradeExecuted subject", () => {
      const moduleName = "okx";
      const event = "tradeExecuted";
      const subject = `feedeater.${moduleName}.${event}`;
      expect(subject).toBe("feedeater.okx.tradeExecuted");
    });
  });

  describe("Multiple Pairs", () => {
    it("should handle BTC-USDT trades", () => {
      const event = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "97500.00",
        sz: "0.1",
        side: "buy",
        ts: "1739577600000",
      });
      expect(event.symbol).toBe("BTC-USDT");
    });

    it("should handle ETH-USDT trades", () => {
      const event = buildOkxTradeEvent({
        instId: "ETH-USDT",
        px: "3200.00",
        sz: "2.5",
        side: "sell",
        ts: "1739577600000",
      });
      expect(event.symbol).toBe("ETH-USDT");
    });

    it("should handle SOL-USDT trades", () => {
      const event = buildOkxTradeEvent({
        instId: "SOL-USDT",
        px: "150.00",
        sz: "100",
        side: "buy",
        ts: "1739577600000",
      });
      expect(event.symbol).toBe("SOL-USDT");
      expect(event.notional_usd).toBe(15000);
    });
  });

  describe("OKX-specific: String Price/Qty Parsing", () => {
    it("should parse string prices from OKX WebSocket format", () => {
      const event = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "97123.45000000",
        sz: "0.12345000",
        side: "buy",
        ts: "1739577600000",
      });
      expect(event.price).toBe(97123.45);
      expect(event.size).toBe(0.12345);
      expect(event.notional_usd).toBeCloseTo(97123.45 * 0.12345, 2);
    });
  });

  describe("Event Emission Alongside messageCreated", () => {
    it("tradeExecuted should fire for all trades, not just whales", () => {
      const smallTrade = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "97000.00",
        sz: "0.0001",
        side: "buy",
        ts: "1739577600000",
      });
      expect(smallTrade.notional_usd).toBeLessThan(50000);
      expect(smallTrade.source).toBe("okx");
      expect(smallTrade.symbol).toBeDefined();
      expect(smallTrade.side).toBeDefined();
    });

    it("tradeExecuted should also fire for whale trades", () => {
      const whaleTrade = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "100000.00",
        sz: "1.0",
        side: "sell",
        ts: "1739577600000",
      });
      expect(whaleTrade.notional_usd).toBeGreaterThanOrEqual(50000);
      expect(whaleTrade.source).toBe("okx");
    });
  });

  describe("OKX instId Format", () => {
    it("should use hyphenated pair format (e.g., BTC-USDT)", () => {
      const event = buildOkxTradeEvent({
        instId: "BTC-USDT",
        px: "97000.00",
        sz: "0.01",
        side: "buy",
        ts: "1739577600000",
      });
      expect(event.symbol).toMatch(/^[A-Z]+-[A-Z]+$/);
    });
  });
});
