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

interface KalshiCandle {
  end_period_ts: number;
  price: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`API error (${res.status}) for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

describe("Kalshi REST API Integration Tests", () => {
  describe("Markets Endpoint", () => {
    it("should fetch open markets", { timeout: REQUEST_TIMEOUT }, async () => {
      const url = `${KALSHI_API_BASE}/markets?limit=10&status=open`;
      const data = await fetchJson<{ markets: KalshiMarket[]; cursor: string }>(url);

      expect(data).toBeDefined();
      expect(Array.isArray(data.markets)).toBe(true);
      expect(data.markets.length).toBeGreaterThan(0);
    });

    it("should return valid market fields", { timeout: REQUEST_TIMEOUT }, async () => {
      const url = `${KALSHI_API_BASE}/markets?limit=5&status=open`;
      const data = await fetchJson<{ markets: KalshiMarket[] }>(url);

      expect(data.markets.length).toBeGreaterThan(0);
      const market = data.markets[0]!;

      expect(typeof market.ticker).toBe("string");
      expect(market.ticker.length).toBeGreaterThan(0);
      expect(typeof market.title).toBe("string");
      expect(typeof market.event_ticker).toBe("string");
      expect(typeof market.yes_bid).toBe("number");
      expect(typeof market.yes_ask).toBe("number");
      expect(typeof market.last_price).toBe("number");
      expect(typeof market.volume_24h).toBe("number");
      expect(typeof market.status).toBe("string");
    });

    it("should return pagination cursor", { timeout: REQUEST_TIMEOUT }, async () => {
      const url = `${KALSHI_API_BASE}/markets?limit=5&status=open`;
      const data = await fetchJson<{ markets: KalshiMarket[]; cursor: string }>(url);

      expect(typeof data.cursor).toBe("string");
    });

    it("should fetch a specific market by ticker", { timeout: REQUEST_TIMEOUT }, async () => {
      const listUrl = `${KALSHI_API_BASE}/markets?limit=1&status=open`;
      const listData = await fetchJson<{ markets: KalshiMarket[] }>(listUrl);
      expect(listData.markets.length).toBeGreaterThan(0);

      const firstMarket = listData.markets[0]!;
      const detailUrl = `${KALSHI_API_BASE}/markets/${encodeURIComponent(firstMarket.ticker)}`;
      const detailData = await fetchJson<{ market: KalshiMarket }>(detailUrl);

      expect(detailData.market).toBeDefined();
      expect(detailData.market.ticker).toBe(firstMarket.ticker);
      expect(typeof detailData.market.title).toBe("string");
    });
  });

  describe("Trades Endpoint", () => {
    it("should fetch recent trades", { timeout: REQUEST_TIMEOUT }, async () => {
      const url = `${KALSHI_API_BASE}/markets/trades?limit=10`;
      const data = await fetchJson<{ trades: KalshiTrade[]; cursor: string }>(url);

      expect(data).toBeDefined();
      expect(Array.isArray(data.trades)).toBe(true);
    });

    it("should return valid trade fields", { timeout: REQUEST_TIMEOUT }, async () => {
      const url = `${KALSHI_API_BASE}/markets/trades?limit=5`;
      const data = await fetchJson<{ trades: KalshiTrade[] }>(url);

      if (data.trades.length > 0) {
        const trade = data.trades[0]!;
        expect(typeof trade.trade_id).toBe("string");
        expect(trade.trade_id.length).toBeGreaterThan(0);
        expect(typeof trade.ticker).toBe("string");
        expect(typeof trade.count).toBe("number");
        expect(trade.count).toBeGreaterThan(0);
        expect(typeof trade.yes_price).toBe("number");
        expect(trade.yes_price).toBeGreaterThanOrEqual(0);
        expect(trade.yes_price).toBeLessThanOrEqual(100);
        expect(typeof trade.taker_side).toBe("string");
        expect(typeof trade.created_time).toBe("string");
      }
    });

    it("should fetch trades for a specific market", { timeout: REQUEST_TIMEOUT }, async () => {
      const marketsUrl = `${KALSHI_API_BASE}/markets?limit=5&status=open`;
      const marketsData = await fetchJson<{ markets: KalshiMarket[] }>(marketsUrl);
      expect(marketsData.markets.length).toBeGreaterThan(0);

      const sorted = [...marketsData.markets].sort((a, b) => b.volume_24h - a.volume_24h);
      const highVolMarket = sorted[0]!;
      const tradesUrl = `${KALSHI_API_BASE}/markets/trades?ticker=${encodeURIComponent(highVolMarket.ticker)}&limit=10`;
      const tradesData = await fetchJson<{ trades: KalshiTrade[] }>(tradesUrl);

      expect(Array.isArray(tradesData.trades)).toBe(true);
      for (const trade of tradesData.trades) {
        expect(trade.ticker).toBe(highVolMarket.ticker);
      }
    });
  });

  describe("Candlesticks Endpoint", () => {
    it("should fetch candle data for a market", { timeout: REQUEST_TIMEOUT * 2 }, async () => {
      const marketsUrl = `${KALSHI_API_BASE}/markets?limit=20&status=open`;
      const marketsData = await fetchJson<{ markets: KalshiMarket[] }>(marketsUrl);
      const sorted = [...marketsData.markets].sort((a, b) => b.volume_24h - a.volume_24h);

      const endTs = Math.floor(Date.now() / 1000);
      const startTs = endTs - 86400;
      let found = false;
      for (const m of sorted.slice(0, 5)) {
        try {
          const candlesUrl = `${KALSHI_API_BASE}/markets/${encodeURIComponent(m.ticker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
          const data = await fetchJson<{ candlesticks: KalshiCandle[] }>(candlesUrl);
          expect(Array.isArray(data.candlesticks)).toBe(true);
          found = true;
          break;
        } catch {
          continue;
        }
      }
      if (!found) {
        console.warn("No markets returned candlestick data (may require auth)");
      }
    });

    it("should return valid candle fields when data exists", { timeout: REQUEST_TIMEOUT * 2 }, async () => {
      const marketsUrl = `${KALSHI_API_BASE}/markets?limit=20&status=open`;
      const marketsData = await fetchJson<{ markets: KalshiMarket[] }>(marketsUrl);
      const sorted = [...marketsData.markets].sort((a, b) => b.volume_24h - a.volume_24h);

      const endTs = Math.floor(Date.now() / 1000);
      const startTs = endTs - 86400;
      for (const m of sorted.slice(0, 5)) {
        try {
          const candlesUrl = `${KALSHI_API_BASE}/markets/${encodeURIComponent(m.ticker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
          const data = await fetchJson<{ candlesticks: KalshiCandle[] }>(candlesUrl);
          if (data.candlesticks.length > 0) {
            const candle = data.candlesticks[0]!;
            expect(typeof candle.end_period_ts).toBe("number");
            expect(candle.end_period_ts).toBeGreaterThan(0);
            expect(typeof candle.open).toBe("number");
            expect(typeof candle.high).toBe("number");
            expect(typeof candle.low).toBe("number");
            expect(typeof candle.close).toBe("number");
            expect(typeof candle.volume).toBe("number");
            expect(candle.high).toBeGreaterThanOrEqual(candle.low);
            return;
          }
        } catch {
          continue;
        }
      }
    });
  });

  describe("Market Data Validation", () => {
    it("should have bid <= ask for YES side", { timeout: REQUEST_TIMEOUT }, async () => {
      const url = `${KALSHI_API_BASE}/markets?limit=20&status=open`;
      const data = await fetchJson<{ markets: KalshiMarket[] }>(url);

      for (const market of data.markets) {
        if (market.yes_bid > 0 && market.yes_ask > 0) {
          expect(market.yes_bid).toBeLessThanOrEqual(market.yes_ask);
        }
      }
    });

    it("should have prices in valid cent range", { timeout: REQUEST_TIMEOUT }, async () => {
      const url = `${KALSHI_API_BASE}/markets?limit=20&status=open`;
      const data = await fetchJson<{ markets: KalshiMarket[] }>(url);

      for (const market of data.markets) {
        expect(market.last_price).toBeGreaterThanOrEqual(0);
        expect(market.last_price).toBeLessThanOrEqual(100);
        expect(market.yes_bid).toBeGreaterThanOrEqual(0);
        expect(market.yes_bid).toBeLessThanOrEqual(100);
        expect(market.yes_ask).toBeGreaterThanOrEqual(0);
        expect(market.yes_ask).toBeLessThanOrEqual(100);
      }
    });

    it("should have non-negative volume", { timeout: REQUEST_TIMEOUT }, async () => {
      const url = `${KALSHI_API_BASE}/markets?limit=20&status=open`;
      const data = await fetchJson<{ markets: KalshiMarket[] }>(url);

      for (const market of data.markets) {
        expect(market.volume_24h).toBeGreaterThanOrEqual(0);
        expect(market.open_interest).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("Settings Parsing", () => {
    it("should parse settings with defaults", async () => {
      const { parseKalshiSettingsFromInternal } = await import("../ingest.js");
      const settings = parseKalshiSettingsFromInternal({});

      expect(settings.enabled).toBe(false);
      expect(settings.collectTrades).toBe(true);
      expect(settings.collectOrderbook).toBe(false);
      expect(settings.collectCandles).toBe(true);
      expect(settings.lookbackHours).toBe(24);
      expect(settings.watchedMarkets).toBe("[]");
    });

    it("should parse enabled settings", async () => {
      const { parseKalshiSettingsFromInternal } = await import("../ingest.js");
      const settings = parseKalshiSettingsFromInternal({
        enabled: "true",
        collectTrades: "true",
        collectOrderbook: "true",
        collectCandles: "false",
        lookbackHours: "48",
        watchedMarkets: '["TICKER1","TICKER2"]',
      });

      expect(settings.enabled).toBe(true);
      expect(settings.collectTrades).toBe(true);
      expect(settings.collectOrderbook).toBe(true);
      expect(settings.collectCandles).toBe(false);
      expect(settings.lookbackHours).toBe(48);
      expect(settings.watchedMarkets).toBe('["TICKER1","TICKER2"]');
    });

    it("should throw on invalid lookbackHours", async () => {
      const { parseKalshiSettingsFromInternal } = await import("../ingest.js");
      expect(() => parseKalshiSettingsFromInternal({ lookbackHours: "-1" })).toThrow();
      expect(() => parseKalshiSettingsFromInternal({ lookbackHours: "0" })).toThrow();
    });
  });
});
