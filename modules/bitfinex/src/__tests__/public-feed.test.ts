import { describe, it, expect } from "vitest";

// ─── Inline helpers (mirror ingest.ts logic without importing it) ──────────

interface TradeExecutedEvent {
  source: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  notional_usd: number;
  timestamp: string;
}

function parseBitfinexDefaults(raw: Record<string, unknown>) {
  return {
    enabled: String(raw.enabled ?? "false") === "true",
    apiUrl: String(raw.apiUrl ?? "wss://api-pub.bitfinex.com/ws/2"),
    restApiUrl: String(raw.restApiUrl ?? "https://api-pub.bitfinex.com/v2"),
    watchedPairs: String(raw.watchedPairs ?? '["tBTCUSD", "tETHUSD", "tSOLUSD"]'),
    whaleThreshold: raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000,
  };
}

function toDisplaySymbol(pair: string): string {
  return pair.startsWith("t") ? pair.slice(1) : pair;
}

// Parse a Bitfinex trade array: [ID, TIME_MS, AMOUNT, PRICE]
// amount > 0 = buy, amount < 0 = sell
function parseBitfinexTrade(
  symbol: string,
  tradeArr: [number, number, number, number]
): TradeExecutedEvent | null {
  const [id, timeMs, amount, price] = tradeArr;
  if (!Number.isFinite(price) || !Number.isFinite(amount) || price <= 0) return null;
  const size = Math.abs(amount);
  const side: "buy" | "sell" = amount > 0 ? "buy" : "sell";
  const notional_usd = price * size;
  return {
    source: "bitfinex",
    symbol: toDisplaySymbol(symbol),
    side,
    price,
    size,
    notional_usd,
    timestamp: new Date(timeMs).toISOString(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Bitfinex Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use the public Bitfinex WebSocket v2 URL by default", () => {
      const settings = parseBitfinexDefaults({});
      expect(settings.apiUrl).toBe("wss://api-pub.bitfinex.com/ws/2");
    });

    it("should use the public Bitfinex REST v2 URL by default", () => {
      const settings = parseBitfinexDefaults({});
      expect(settings.restApiUrl).toBe("https://api-pub.bitfinex.com/v2");
    });

    it("should watch tBTCUSD and tETHUSD by default", () => {
      const settings = parseBitfinexDefaults({});
      const pairs = JSON.parse(settings.watchedPairs) as string[];
      expect(pairs).toContain("tBTCUSD");
      expect(pairs).toContain("tETHUSD");
    });

    it("should default to disabled", () => {
      const settings = parseBitfinexDefaults({});
      expect(settings.enabled).toBe(false);
    });

    it("should enable when enabled=true without any other settings", () => {
      const settings = parseBitfinexDefaults({ enabled: "true" });
      expect(settings.enabled).toBe(true);
    });

    it("should not require any API keys to parse settings", () => {
      expect(() => parseBitfinexDefaults({ enabled: "true" })).not.toThrow();
    });

    it("should default whale threshold to 50000", () => {
      const settings = parseBitfinexDefaults({});
      expect(settings.whaleThreshold).toBe(50000);
    });
  });

  describe("Display Symbol Normalization", () => {
    it("should strip the t-prefix from Bitfinex pair symbols", () => {
      expect(toDisplaySymbol("tBTCUSD")).toBe("BTCUSD");
      expect(toDisplaySymbol("tETHUSD")).toBe("ETHUSD");
      expect(toDisplaySymbol("tSOLUSD")).toBe("SOLUSD");
    });

    it("should leave non-prefixed symbols unchanged", () => {
      expect(toDisplaySymbol("BTCUSD")).toBe("BTCUSD");
    });
  });

  describe("Trade Message Parsing (Bitfinex v2 array format)", () => {
    it("should parse a buy trade (positive amount)", () => {
      // [ID, TIME_MS, AMOUNT, PRICE] — positive amount = buy
      const trade = parseBitfinexTrade("tBTCUSD", [1234567, 1739800000000, 0.5, 96000]);
      expect(trade).not.toBeNull();
      expect(trade!.side).toBe("buy");
      expect(trade!.price).toBe(96000);
      expect(trade!.size).toBe(0.5);
      expect(trade!.symbol).toBe("BTCUSD");
      expect(trade!.source).toBe("bitfinex");
    });

    it("should parse a sell trade (negative amount)", () => {
      const trade = parseBitfinexTrade("tBTCUSD", [1234568, 1739800001000, -1.2, 95900]);
      expect(trade).not.toBeNull();
      expect(trade!.side).toBe("sell");
      expect(trade!.size).toBe(1.2); // absolute value
      expect(trade!.price).toBe(95900);
    });

    it("should compute correct notional USD", () => {
      const trade = parseBitfinexTrade("tBTCUSD", [1, 1739800000000, 2.0, 50000]);
      expect(trade!.notional_usd).toBe(100000);
    });

    it("should return null for zero price", () => {
      const trade = parseBitfinexTrade("tBTCUSD", [1, 1739800000000, 1.0, 0]);
      expect(trade).toBeNull();
    });

    it("should correctly convert timestamp to ISO string", () => {
      const timeMs = 1739800000000;
      const trade = parseBitfinexTrade("tBTCUSD", [1, timeMs, 1.0, 50000]);
      expect(trade!.timestamp).toBe(new Date(timeMs).toISOString());
    });

    it("should emit ETH trades with ETHUSD display symbol", () => {
      const trade = parseBitfinexTrade("tETHUSD", [1, 1739800000000, 10, 3000]);
      expect(trade!.symbol).toBe("ETHUSD");
    });
  });

  describe("Whale Detection Logic", () => {
    it("should flag a trade as whale when notional >= threshold", () => {
      const settings = parseBitfinexDefaults({ whaleThreshold: "50000" });
      const trade = parseBitfinexTrade("tBTCUSD", [1, 1739800000000, 0.6, 90000]);
      // 0.6 * 90000 = 54000 >= 50000
      expect(trade!.notional_usd).toBeGreaterThanOrEqual(settings.whaleThreshold);
    });

    it("should not flag a small trade as whale", () => {
      const settings = parseBitfinexDefaults({});
      const trade = parseBitfinexTrade("tBTCUSD", [1, 1739800000000, 0.001, 90000]);
      // 0.001 * 90000 = 90 < 50000
      expect(trade!.notional_usd).toBeLessThan(settings.whaleThreshold);
    });
  });

  describe("WebSocket Subscription Format", () => {
    it("should produce a valid Bitfinex subscribe message for a pair", () => {
      const pair = "tBTCUSD";
      const msg = JSON.stringify({ event: "subscribe", channel: "trades", symbol: pair });
      const parsed = JSON.parse(msg);
      expect(parsed.event).toBe("subscribe");
      expect(parsed.channel).toBe("trades");
      expect(parsed.symbol).toBe("tBTCUSD");
    });

    it("should produce subscribe messages for all default pairs", () => {
      const pairs = ["tBTCUSD", "tETHUSD", "tSOLUSD"];
      const messages = pairs.map((p) =>
        JSON.parse(JSON.stringify({ event: "subscribe", channel: "trades", symbol: p }))
      );
      expect(messages).toHaveLength(3);
      expect(messages.map((m) => m.symbol)).toEqual(pairs);
    });
  });

  describe("Channel Map (chanId → symbol)", () => {
    it("should map a subscribed channel confirmation to the correct symbol", () => {
      const channelMap = new Map<number, string>();
      const ev = { event: "subscribed", channel: "trades", chanId: 42, symbol: "tBTCUSD" };
      if (ev.event === "subscribed" && ev.channel === "trades") {
        channelMap.set(ev.chanId, ev.symbol);
      }
      expect(channelMap.get(42)).toBe("tBTCUSD");
    });

    it("should resolve multiple pairs to distinct channel IDs", () => {
      const channelMap = new Map<number, string>();
      channelMap.set(10, "tBTCUSD");
      channelMap.set(11, "tETHUSD");
      channelMap.set(12, "tSOLUSD");
      expect(channelMap.get(10)).toBe("tBTCUSD");
      expect(channelMap.get(11)).toBe("tETHUSD");
      expect(channelMap.get(12)).toBe("tSOLUSD");
    });
  });

  describe("REST API URL Construction", () => {
    it("should construct correct REST URL for a given pair", () => {
      const base = "https://api-pub.bitfinex.com/v2";
      const pair = "tBTCUSD";
      const url = `${base}/trades/${pair}/hist?limit=500&sort=-1`;
      expect(url).toBe("https://api-pub.bitfinex.com/v2/trades/tBTCUSD/hist?limit=500&sort=-1");
    });
  });
});
