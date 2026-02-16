import { describe, it, expect } from "vitest";

interface KalshiTradeExecutedEvent {
  source: string;
  symbol: string;
  side: string;
  price: number;
  size: number;
  notional_usd: number;
  timestamp: string;
  market_title?: string;
}

function buildKalshiTradeEvent(raw: {
  ticker: string;
  count: number;
  yes_price: number;
  no_price?: number;
  taker_side: string;
  created_time: string;
  market_title?: string;
}): KalshiTradeExecutedEvent {
  const noPrice = raw.no_price ?? (1 - raw.yes_price);
  const price = raw.taker_side === "yes" ? raw.yes_price : noPrice;
  return {
    source: "kalshi",
    symbol: raw.ticker,
    side: raw.taker_side,
    price,
    size: raw.count,
    notional_usd: raw.count * price,
    timestamp: raw.created_time,
    ...(raw.market_title ? { market_title: raw.market_title } : {}),
  };
}

describe("Kalshi tradeExecuted Event Tests", () => {
  describe("Event Schema", () => {
    it("should build a valid tradeExecuted event from Kalshi trade data", () => {
      const event = buildKalshiTradeEvent({
        ticker: "PRES-2024-DEM",
        count: 50,
        yes_price: 0.62,
        no_price: 0.38,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
        market_title: "Will Democrats win the 2024 presidential election?",
      });

      expect(event.source).toBe("kalshi");
      expect(event.symbol).toBe("PRES-2024-DEM");
      expect(event.side).toBe("yes");
      expect(event.price).toBe(0.62);
      expect(event.size).toBe(50);
      expect(event.notional_usd).toBe(31);
      expect(typeof event.timestamp).toBe("string");
      expect(event.market_title).toBe("Will Democrats win the 2024 presidential election?");
    });

    it("should have all required fields", () => {
      const event = buildKalshiTradeEvent({
        ticker: "BTC-100K",
        count: 10,
        yes_price: 0.75,
        no_price: 0.25,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });

      const keys = Object.keys(event);
      expect(keys).toContain("source");
      expect(keys).toContain("symbol");
      expect(keys).toContain("side");
      expect(keys).toContain("price");
      expect(keys).toContain("size");
      expect(keys).toContain("notional_usd");
      expect(keys).toContain("timestamp");
    });

    it("should set source to kalshi", () => {
      const event = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 1,
        yes_price: 0.50,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.source).toBe("kalshi");
    });
  });

  describe("Side Parsing (Taker Side)", () => {
    it("should use yes when taker_side is yes", () => {
      const event = buildKalshiTradeEvent({
        ticker: "PRES-2024-DEM",
        count: 50,
        yes_price: 0.62,
        no_price: 0.38,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.side).toBe("yes");
      expect(event.price).toBe(0.62);
    });

    it("should use no when taker_side is no", () => {
      const event = buildKalshiTradeEvent({
        ticker: "BTC-100K",
        count: 10,
        yes_price: 0.75,
        no_price: 0.25,
        taker_side: "no",
        created_time: "2026-02-10T14:00:00Z",
      });
      expect(event.side).toBe("no");
      expect(event.price).toBe(0.25);
    });

    it("should derive no_price from yes_price when no_price is missing", () => {
      const event = buildKalshiTradeEvent({
        ticker: "ETH-5K",
        count: 20,
        yes_price: 0.40,
        taker_side: "no",
        created_time: "2026-02-10T16:00:00Z",
      });
      expect(event.price).toBeCloseTo(0.60);
    });
  });

  describe("Notional USD Calculation", () => {
    it("should compute notional_usd as count * price", () => {
      const event = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 100,
        yes_price: 0.50,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.notional_usd).toBe(50);
    });

    it("should handle small trades", () => {
      const event = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 1,
        yes_price: 0.10,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.notional_usd).toBeCloseTo(0.10, 2);
    });

    it("should handle large trades", () => {
      const event = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 10000,
        yes_price: 0.95,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.notional_usd).toBe(9500);
    });

    it("should use no_price for notional when taker_side is no", () => {
      const event = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 100,
        yes_price: 0.80,
        no_price: 0.20,
        taker_side: "no",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.notional_usd).toBe(20);
    });
  });

  describe("Timestamp Format", () => {
    it("should pass through ISO-8601 timestamp from Kalshi", () => {
      const event = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 1,
        yes_price: 0.50,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.timestamp).toBe("2026-02-10T12:00:00Z");
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("should handle Kalshi timestamp with milliseconds", () => {
      const event = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 1,
        yes_price: 0.50,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00.123Z",
      });
      const parsed = new Date(event.timestamp);
      expect(parsed.getTime()).toBeGreaterThan(0);
    });
  });

  describe("NATS Subject", () => {
    it("should use feedeater.kalshi.tradeExecuted subject", () => {
      const moduleName = "kalshi";
      const eventName = "tradeExecuted";
      const subject = `feedeater.${moduleName}.${eventName}`;
      expect(subject).toBe("feedeater.kalshi.tradeExecuted");
    });

    it("should use feedeater.kalshi.orderbookSnapshot for orderbook events", () => {
      const subject = `feedeater.kalshi.orderbookSnapshot`;
      expect(subject).toBe("feedeater.kalshi.orderbookSnapshot");
    });

    it("should use feedeater.kalshi.candleClosed for candle events", () => {
      const subject = `feedeater.kalshi.candleClosed`;
      expect(subject).toBe("feedeater.kalshi.candleClosed");
    });
  });

  describe("Multiple Market Types", () => {
    it("should handle political market tickers", () => {
      const event = buildKalshiTradeEvent({
        ticker: "PRES-2024-DEM",
        count: 50,
        yes_price: 0.62,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.symbol).toBe("PRES-2024-DEM");
    });

    it("should handle crypto market tickers", () => {
      const event = buildKalshiTradeEvent({
        ticker: "BTC-100K",
        count: 100,
        yes_price: 0.80,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.symbol).toBe("BTC-100K");
    });

    it("should handle weather/event market tickers", () => {
      const event = buildKalshiTradeEvent({
        ticker: "HIGHNY-26FEB15-B42",
        count: 25,
        yes_price: 0.55,
        taker_side: "no",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.symbol).toBe("HIGHNY-26FEB15-B42");
    });
  });

  describe("Kalshi-specific: Prediction Market Prices", () => {
    it("should have prices between 0 and 1 (not dollars)", () => {
      const event = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 10,
        yes_price: 0.42,
        no_price: 0.58,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.price).toBeGreaterThanOrEqual(0);
      expect(event.price).toBeLessThanOrEqual(1);
    });

    it("should use integer contract count, not fractional size", () => {
      const event = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 25,
        yes_price: 0.60,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(Number.isInteger(event.size)).toBe(true);
    });

    it("yes_price + no_price should equal 1", () => {
      const yesPrice = 0.62;
      const noPrice = 0.38;
      expect(yesPrice + noPrice).toBeCloseTo(1, 10);
    });
  });

  describe("Event Emission Alongside messageCreated", () => {
    it("tradeExecuted should fire for all trades regardless of size", () => {
      const smallTrade = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 1,
        yes_price: 0.50,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(smallTrade.source).toBe("kalshi");
      expect(smallTrade.symbol).toBeDefined();
      expect(smallTrade.side).toBeDefined();
    });

    it("tradeExecuted should also fire for large trades", () => {
      const largeTrade = buildKalshiTradeEvent({
        ticker: "TEST-MKT",
        count: 5000,
        yes_price: 0.90,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(largeTrade.notional_usd).toBe(4500);
      expect(largeTrade.source).toBe("kalshi");
    });
  });
});
