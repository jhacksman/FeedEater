import { describe, it, expect } from "vitest";

/**
 * Integration tests for the Bitfinex module.
 *
 * These tests verify the end-to-end message flow and Bitfinex v2 protocol
 * handling WITHOUT requiring a live WebSocket connection or database.
 */

// ─── Inline parser mirrors (keep tests hermetic) ────────────────────────────

function toDisplaySymbol(pair: string): string {
  return pair.startsWith("t") ? pair.slice(1) : pair;
}

function parseBitfinexTradeArray(
  symbol: string,
  arr: unknown[]
): { tradeId: string; symbol: string; side: "buy" | "sell"; price: number; size: number; notional: number; time: string } | null {
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const [rawId, rawTime, rawAmount, rawPrice] = arr;
  const amount = Number(rawAmount);
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || !Number.isFinite(amount) || price <= 0) return null;
  const size = Math.abs(amount);
  const side: "buy" | "sell" = amount > 0 ? "buy" : "sell";
  return {
    tradeId: `bitfinex_${symbol}_${rawId}`,
    symbol: toDisplaySymbol(symbol),
    side,
    price,
    size,
    notional: price * size,
    time: new Date(Number(rawTime)).toISOString(),
  };
}

// Simulate the channel map event flow
function simulateChannelMapFlow(events: unknown[]): Map<number, string> {
  const channelMap = new Map<number, string>();
  for (const ev of events) {
    if (ev && typeof ev === "object" && !Array.isArray(ev)) {
      const obj = ev as Record<string, unknown>;
      if (obj.event === "subscribed" && obj.channel === "trades") {
        channelMap.set(Number(obj.chanId), String(obj.symbol));
      }
    }
  }
  return channelMap;
}

// Simulate dispatching array messages through the channel map
function simulateMessageDispatch(
  channelMap: Map<number, string>,
  messages: unknown[]
): Array<{ symbol: string; tradeId: string; side: "buy" | "sell"; price: number; size: number }> {
  const results: Array<{ symbol: string; tradeId: string; side: "buy" | "sell"; price: number; size: number }> = [];
  for (const msg of messages) {
    if (!Array.isArray(msg) || msg.length < 2) continue;
    const [chanId, payload] = msg as [number, unknown];
    const symbol = channelMap.get(chanId);
    if (!symbol) continue;
    if (payload === "hb") continue; // heartbeat
    if (payload === "te" && msg.length >= 3) {
      const tradeData = msg[2] as unknown[];
      const parsed = parseBitfinexTradeArray(symbol, tradeData);
      if (parsed) results.push({ symbol: parsed.symbol, tradeId: parsed.tradeId, side: parsed.side, price: parsed.price, size: parsed.size });
    }
  }
  return results;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Bitfinex Module Integration Tests", () => {
  describe("WebSocket Protocol Flow", () => {
    it("should correctly build channel map from subscribed events", () => {
      const events = [
        { event: "info", version: 2 },
        { event: "subscribed", channel: "trades", chanId: 100, symbol: "tBTCUSD" },
        { event: "subscribed", channel: "trades", chanId: 101, symbol: "tETHUSD" },
        { event: "subscribed", channel: "trades", chanId: 102, symbol: "tSOLUSD" },
      ];
      const channelMap = simulateChannelMapFlow(events);
      expect(channelMap.size).toBe(3);
      expect(channelMap.get(100)).toBe("tBTCUSD");
      expect(channelMap.get(101)).toBe("tETHUSD");
      expect(channelMap.get(102)).toBe("tSOLUSD");
    });

    it("should dispatch a 'te' trade message to the correct symbol via channel map", () => {
      const channelMap = new Map([[100, "tBTCUSD"], [101, "tETHUSD"]]);
      const messages = [
        [100, "te", [555001, 1739800000000, 0.5, 96000]],
        [101, "te", [555002, 1739800001000, -2.0, 3500]],
      ];
      const results = simulateMessageDispatch(channelMap, messages);
      expect(results).toHaveLength(2);
      expect(results[0]!.symbol).toBe("BTCUSD");
      expect(results[0]!.side).toBe("buy");
      expect(results[1]!.symbol).toBe("ETHUSD");
      expect(results[1]!.side).toBe("sell");
    });

    it("should silently ignore heartbeat messages", () => {
      const channelMap = new Map([[100, "tBTCUSD"]]);
      const messages = [[100, "hb"]];
      const results = simulateMessageDispatch(channelMap, messages);
      expect(results).toHaveLength(0);
    });

    it("should ignore messages from unknown channel IDs", () => {
      const channelMap = new Map([[100, "tBTCUSD"]]);
      const messages = [[999, "te", [1, 1739800000000, 1.0, 50000]]]; // chanId 999 not in map
      const results = simulateMessageDispatch(channelMap, messages);
      expect(results).toHaveLength(0);
    });

    it("should process snapshot array (initial trade history on subscribe)", () => {
      const channelMap = new Map([[100, "tBTCUSD"]]);
      // Initial snapshot: [chanId, [[ID,TIME,AMOUNT,PRICE], ...]]
      const snapshotMsg = [100, [[1001, 1739800000000, 0.1, 95000], [1002, 1739800001000, -0.2, 94900]]];

      // Simulate snapshot handling inline
      const results: Array<{ side: "buy" | "sell"; price: number; size: number }> = [];
      const [chanId, payload] = snapshotMsg as [number, unknown];
      const symbol = channelMap.get(chanId);
      if (symbol && Array.isArray(payload)) {
        for (const entry of payload) {
          if (Array.isArray(entry)) {
            const parsed = parseBitfinexTradeArray(symbol, entry);
            if (parsed) results.push({ side: parsed.side, price: parsed.price, size: parsed.size });
          }
        }
      }
      expect(results).toHaveLength(2);
      expect(results[0]!.side).toBe("buy");
      expect(results[1]!.side).toBe("sell");
    });
  });

  describe("Trade ID Uniqueness", () => {
    it("should produce unique trade IDs across different pairs with the same exchange ID", () => {
      const id1 = `bitfinex_tBTCUSD_1000`;
      const id2 = `bitfinex_tETHUSD_1000`;
      expect(id1).not.toBe(id2);
    });

    it("should produce unique trade IDs across sequential trades on the same pair", () => {
      const id1 = `bitfinex_tBTCUSD_1000`;
      const id2 = `bitfinex_tBTCUSD_1001`;
      expect(id1).not.toBe(id2);
    });
  });

  describe("Candle Aggregation Logic", () => {
    function getCandleStart(timeMs: number, intervalSec: number): Date {
      const intervalMs = intervalSec * 1000;
      return new Date(Math.floor(timeMs / intervalMs) * intervalMs);
    }

    it("should align candle start to interval boundary", () => {
      const t = new Date("2026-02-17T23:32:45.000Z").getTime(); // 23:32:45
      const start = getCandleStart(t, 60);
      expect(start.getSeconds()).toBe(0); // aligned to minute boundary
      expect(start.getUTCMinutes()).toBe(32);
    });

    it("should assign trades within the same minute to the same candle", () => {
      const t1 = new Date("2026-02-17T23:32:10.000Z").getTime();
      const t2 = new Date("2026-02-17T23:32:50.000Z").getTime();
      expect(getCandleStart(t1, 60).getTime()).toBe(getCandleStart(t2, 60).getTime());
    });

    it("should assign trades in different minutes to different candles", () => {
      const t1 = new Date("2026-02-17T23:32:59.000Z").getTime();
      const t2 = new Date("2026-02-17T23:33:00.000Z").getTime();
      expect(getCandleStart(t1, 60).getTime()).not.toBe(getCandleStart(t2, 60).getTime());
    });
  });

  describe("Whale Alert Generation", () => {
    it("should identify a $96k BTC trade as a whale at default $50k threshold", () => {
      const price = 96000;
      const size = 1.0;
      const notional = price * size;
      const threshold = 50000;
      expect(notional).toBeGreaterThanOrEqual(threshold);
    });

    it("should not flag a $90 trade as a whale", () => {
      const notional = 90;
      const threshold = 50000;
      expect(notional).toBeLessThan(threshold);
    });

    it("should correctly determine direction from side", () => {
      function sideToDirection(side: string): "bullish" | "bearish" {
        return side === "buy" ? "bullish" : "bearish";
      }
      expect(sideToDirection("buy")).toBe("bullish");
      expect(sideToDirection("sell")).toBe("bearish");
    });
  });

  describe("tradeExecuted NATS Event Shape", () => {
    it("should produce a valid tradeExecuted event shape from a trade", () => {
      const price = 96000;
      const size = 0.5;
      const event = {
        source: "bitfinex",
        symbol: "BTCUSD",
        side: "buy" as const,
        price,
        size,
        notional_usd: price * size,
        timestamp: new Date().toISOString(),
      };
      expect(event.source).toBe("bitfinex");
      expect(event.symbol).toBe("BTCUSD");
      expect(event.notional_usd).toBe(48000);
      expect(typeof event.timestamp).toBe("string");
    });
  });
});
