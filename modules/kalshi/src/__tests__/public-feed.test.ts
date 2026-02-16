import { describe, it, expect } from "vitest";

const KALSHI_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const REQUEST_TIMEOUT = 15000;

interface KalshiMarket {
  ticker: string;
  title: string;
  subtitle: string;
  event_ticker: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  status: string;
  close_time: string;
  result: string;
}

interface KalshiTrade {
  trade_id: string;
  ticker: string;
  count: number;
  yes_price: number;
  no_price: number;
  taker_side: string;
  created_time: string;
}

function parseKalshiDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    apiBase: String(raw.apiBase ?? KALSHI_API_BASE),
    watchedMarkets: String(raw.watchedMarkets ?? "[]"),
    collectTrades: String(raw.collectTrades ?? "true") !== "false",
    collectOrderbook: String(raw.collectOrderbook ?? "false") === "true",
    collectCandles: String(raw.collectCandles ?? "true") !== "false",
    lookbackHours: raw.lookbackHours ? Number(raw.lookbackHours) : 24,
  };
}

function parseKalshiTrade(trade: KalshiTrade, marketTitle?: string) {
  const noPrice = trade.no_price ?? (1 - trade.yes_price);
  const price = trade.taker_side === "yes" ? trade.yes_price : noPrice;
  return {
    source: "kalshi",
    symbol: trade.ticker,
    side: trade.taker_side,
    price,
    size: trade.count,
    notional_usd: trade.count * price,
    timestamp: trade.created_time,
    ...(marketTitle ? { market_title: marketTitle } : {}),
  };
}

describe("Kalshi Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use Kalshi elections API base by default", () => {
      const settings = parseKalshiDefaults({});
      expect(settings.apiBase).toBe("https://api.elections.kalshi.com/trade-api/v2");
    });

    it("should default to disabled", () => {
      const settings = parseKalshiDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parseKalshiDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });

    it("should default to collecting trades and candles but not orderbook", () => {
      const settings = parseKalshiDefaults({});
      expect(settings.collectTrades).toBe(true);
      expect(settings.collectCandles).toBe(true);
      expect(settings.collectOrderbook).toBe(false);
    });

    it("should not require any API keys to parse settings", () => {
      const settings = parseKalshiDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
      expect(settings.apiBase).toBeTruthy();
    });

    it("should default to empty watched markets", () => {
      const settings = parseKalshiDefaults({});
      const markets = JSON.parse(settings.watchedMarkets) as string[];
      expect(markets).toEqual([]);
    });

    it("should default lookbackHours to 24", () => {
      const settings = parseKalshiDefaults({});
      expect(settings.lookbackHours).toBe(24);
    });
  });

  describe("Public REST API Connectivity", () => {
    it("should fetch markets without authentication", { timeout: REQUEST_TIMEOUT }, async () => {
      const res = await fetch(`${KALSHI_API_BASE}/markets?limit=1&status=open`, {
        headers: { accept: "application/json" },
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { markets: KalshiMarket[] };
      expect(Array.isArray(data.markets)).toBe(true);
    });

    it("should fetch trades without authentication", { timeout: REQUEST_TIMEOUT }, async () => {
      const res = await fetch(`${KALSHI_API_BASE}/markets/trades?limit=1`, {
        headers: { accept: "application/json" },
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
    });

    it("should return valid market structure", { timeout: REQUEST_TIMEOUT }, async () => {
      const res = await fetch(`${KALSHI_API_BASE}/markets?limit=5&status=open`, {
        headers: { accept: "application/json" },
      });
      const data = (await res.json()) as { markets: KalshiMarket[] };
      expect(data.markets.length).toBeGreaterThan(0);
      const market = data.markets[0]!;
      expect(typeof market.ticker).toBe("string");
      expect(typeof market.title).toBe("string");
      expect(typeof market.last_price).toBe("number");
      expect(typeof market.volume_24h).toBe("number");
    });

    it("should return pagination cursor", { timeout: REQUEST_TIMEOUT }, async () => {
      const res = await fetch(`${KALSHI_API_BASE}/markets?limit=5&status=open`, {
        headers: { accept: "application/json" },
      });
      const data = (await res.json()) as { markets: KalshiMarket[]; cursor: string };
      expect(typeof data.cursor).toBe("string");
    });
  });

  describe("Trade Message Parsing", () => {
    it("should parse a YES taker trade", () => {
      const event = parseKalshiTrade({
        trade_id: "abc-123",
        ticker: "PRES-2024-DEM",
        count: 50,
        yes_price: 0.62,
        no_price: 0.38,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });

      expect(event.source).toBe("kalshi");
      expect(event.symbol).toBe("PRES-2024-DEM");
      expect(event.side).toBe("yes");
      expect(event.price).toBe(0.62);
      expect(event.size).toBe(50);
      expect(event.notional_usd).toBe(31);
    });

    it("should parse a NO taker trade", () => {
      const event = parseKalshiTrade({
        trade_id: "def-456",
        ticker: "BTC-100K",
        count: 10,
        yes_price: 0.75,
        no_price: 0.25,
        taker_side: "no",
        created_time: "2026-02-10T14:00:00Z",
      });

      expect(event.side).toBe("no");
      expect(event.price).toBe(0.25);
      expect(event.notional_usd).toBe(2.5);
    });

    it("should compute no_price from yes_price when no_price is missing", () => {
      const event = parseKalshiTrade({
        trade_id: "ghi-789",
        ticker: "ETH-5K",
        count: 20,
        yes_price: 0.40,
        no_price: undefined as unknown as number,
        taker_side: "no",
        created_time: "2026-02-10T16:00:00Z",
      });

      expect(event.price).toBeCloseTo(0.60);
      expect(event.notional_usd).toBeCloseTo(12);
    });

    it("should include market_title when provided", () => {
      const event = parseKalshiTrade(
        {
          trade_id: "jkl-012",
          ticker: "PRES-2024-DEM",
          count: 5,
          yes_price: 0.50,
          no_price: 0.50,
          taker_side: "yes",
          created_time: "2026-02-10T18:00:00Z",
        },
        "Will Democrats win?"
      );

      expect(event.market_title).toBe("Will Democrats win?");
    });
  });

  describe("Custom Settings Override", () => {
    it("should allow overriding API base URL", () => {
      const settings = parseKalshiDefaults({
        apiBase: "https://custom-api.example.com",
      });
      expect(settings.apiBase).toBe("https://custom-api.example.com");
    });

    it("should allow overriding watched markets", () => {
      const settings = parseKalshiDefaults({
        watchedMarkets: '["TICKER1","TICKER2"]',
      });
      const markets = JSON.parse(settings.watchedMarkets) as string[];
      expect(markets).toEqual(["TICKER1", "TICKER2"]);
    });

    it("should allow overriding lookback hours", () => {
      const settings = parseKalshiDefaults({ lookbackHours: "48" });
      expect(settings.lookbackHours).toBe(48);
    });
  });

  describe("Kalshi-specific: Prediction Market Format", () => {
    it("should have prices in 0-1 range (fractional cents)", () => {
      const event = parseKalshiTrade({
        trade_id: "test-1",
        ticker: "TEST-MKT",
        count: 100,
        yes_price: 0.42,
        no_price: 0.58,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.price).toBeGreaterThanOrEqual(0);
      expect(event.price).toBeLessThanOrEqual(1);
    });

    it("should use ticker format with hyphens (not slash pairs)", () => {
      const event = parseKalshiTrade({
        trade_id: "test-2",
        ticker: "PRES-2024-DEM",
        count: 10,
        yes_price: 0.50,
        no_price: 0.50,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(event.symbol).toContain("-");
      expect(event.symbol).not.toContain("/");
    });

    it("should use count (contracts) as size, not fractional amounts", () => {
      const event = parseKalshiTrade({
        trade_id: "test-3",
        ticker: "TEST-MKT",
        count: 25,
        yes_price: 0.60,
        no_price: 0.40,
        taker_side: "yes",
        created_time: "2026-02-10T12:00:00Z",
      });
      expect(Number.isInteger(event.size)).toBe(true);
      expect(event.size).toBe(25);
    });
  });
});
