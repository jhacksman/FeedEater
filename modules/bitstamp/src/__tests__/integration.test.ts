import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const BITSTAMP_WS_URL = "wss://ws.bitstamp.net";
const TEST_PAIR = "btcusd";
const CONNECTION_TIMEOUT = 10000;
const MESSAGE_TIMEOUT = 30000;
const TRADE_TIMEOUT = 60000;

interface BitstampTradeData {
  id: number;
  amount: number;
  amount_str: string;
  price: number;
  price_str: string;
  type: number;
  timestamp: string;
  microtimestamp: string;
  buy_order_id: number;
  sell_order_id: number;
}

interface BitstampMessage {
  event: string;
  channel: string;
  data: BitstampTradeData | Record<string, unknown>;
}

interface BitstampOrderbookData {
  bids: [string, string][];
  asks: [string, string][];
  timestamp: string;
  microtimestamp: string;
}

describe("Bitstamp WebSocket Integration Tests", () => {
  describe("WebSocket Connection", () => {
    it("should connect to Bitstamp WebSocket", { timeout: CONNECTION_TIMEOUT }, async () => {
      const connected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(BITSTAMP_WS_URL);
        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, CONNECTION_TIMEOUT);

        ws.on("open", () => {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve(false);
        });
      });

      expect(connected).toBe(true);
    });

    it("should subscribe to a live_trades channel", { timeout: CONNECTION_TIMEOUT }, async () => {
      const subscribed = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(BITSTAMP_WS_URL);
        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, CONNECTION_TIMEOUT);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            event: "bts:subscribe",
            data: { channel: `live_trades_${TEST_PAIR}` },
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.event === "bts:subscription_succeeded" && msg.channel === `live_trades_${TEST_PAIR}`) {
              clearTimeout(timeout);
              ws.close();
              resolve(true);
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve(false);
        });
      });

      expect(subscribed).toBe(true);
    });
  });

  describe("Trade Stream Parsing", () => {
    it("should receive and parse trade messages", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ received: boolean; trade: BitstampTradeData | null }>((resolve) => {
        const ws = new WebSocket(BITSTAMP_WS_URL);
        let trade: BitstampTradeData | null = null;

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, trade: null });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            event: "bts:subscribe",
            data: { channel: `live_trades_${TEST_PAIR}` },
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString()) as BitstampMessage;
            if (msg.event === "trade" && msg.channel === `live_trades_${TEST_PAIR}`) {
              trade = msg.data as BitstampTradeData;
              clearTimeout(timeout);
              ws.close();
              resolve({ received: true, trade });
            }
          } catch {
            // ignore parse errors
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ received: false, trade: null });
        });
      });

      expect(result.received).toBe(true);
      expect(result.trade).not.toBeNull();

      if (result.trade) {
        expect(typeof result.trade.id).toBe("number");
        expect(typeof result.trade.price).toBe("number");
        expect(typeof result.trade.amount).toBe("number");
        expect(typeof result.trade.type).toBe("number");
        expect([0, 1]).toContain(result.trade.type);
        expect(typeof result.trade.timestamp).toBe("string");
        expect(typeof result.trade.microtimestamp).toBe("string");
        expect(result.trade.price).toBeGreaterThan(0);
        expect(result.trade.amount).toBeGreaterThan(0);
      }
    });

    it("should correctly determine trade side from type field", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<BitstampTradeData | null>((resolve) => {
        const ws = new WebSocket(BITSTAMP_WS_URL);

        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            event: "bts:subscribe",
            data: { channel: `live_trades_${TEST_PAIR}` },
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString()) as BitstampMessage;
            if (msg.event === "trade") {
              clearTimeout(timeout);
              ws.close();
              resolve(msg.data as BitstampTradeData);
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        });
      });

      expect(result).not.toBeNull();
      expect([0, 1]).toContain(result!.type);
      const side = result!.type === 0 ? "buy" : "sell";
      expect(["buy", "sell"]).toContain(side);
    });
  });

  describe("Order Book Parsing", () => {
    it("should receive and parse order book data", { timeout: MESSAGE_TIMEOUT }, async () => {
      const result = await new Promise<{ received: boolean; book: BitstampOrderbookData | null }>((resolve) => {
        const ws = new WebSocket(BITSTAMP_WS_URL);
        let book: BitstampOrderbookData | null = null;

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, book: null });
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            event: "bts:subscribe",
            data: { channel: `order_book_${TEST_PAIR}` },
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.event === "data" && msg.channel === `order_book_${TEST_PAIR}`) {
              book = msg.data as BitstampOrderbookData;
              clearTimeout(timeout);
              ws.close();
              resolve({ received: true, book });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ received: false, book: null });
        });
      });

      expect(result.received).toBe(true);
      expect(result.book).not.toBeNull();

      if (result.book) {
        expect(Array.isArray(result.book.bids)).toBe(true);
        expect(Array.isArray(result.book.asks)).toBe(true);
        expect(result.book.bids.length).toBeGreaterThan(0);
        expect(result.book.asks.length).toBeGreaterThan(0);
      }
    });

    it("should parse orderbook levels correctly", { timeout: MESSAGE_TIMEOUT }, async () => {
      const result = await new Promise<BitstampOrderbookData | null>((resolve) => {
        const ws = new WebSocket(BITSTAMP_WS_URL);

        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            event: "bts:subscribe",
            data: { channel: `order_book_${TEST_PAIR}` },
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.event === "data" && msg.channel === `order_book_${TEST_PAIR}` && msg.data.bids?.length > 0) {
              clearTimeout(timeout);
              ws.close();
              resolve(msg.data as BitstampOrderbookData);
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        });
      });

      expect(result).not.toBeNull();
      if (result) {
        for (const bid of result.bids) {
          expect(bid.length).toBe(2);
          const price = parseFloat(bid[0]);
          const size = parseFloat(bid[1]);
          expect(price).toBeGreaterThan(0);
          expect(size).toBeGreaterThanOrEqual(0);
        }

        for (const ask of result.asks) {
          expect(ask.length).toBe(2);
          const price = parseFloat(ask[0]);
          const size = parseFloat(ask[1]);
          expect(price).toBeGreaterThan(0);
          expect(size).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe("Combined Streams", () => {
    it("should receive both trade and orderbook messages", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ trades: number; books: number }>((resolve) => {
        const ws = new WebSocket(BITSTAMP_WS_URL);
        let trades = 0;
        let books = 0;

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ trades, books });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            event: "bts:subscribe",
            data: { channel: `live_trades_${TEST_PAIR}` },
          }));
          ws.send(JSON.stringify({
            event: "bts:subscribe",
            data: { channel: `order_book_${TEST_PAIR}` },
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.event === "trade") {
              trades++;
            } else if (msg.event === "data" && msg.channel?.startsWith("order_book_")) {
              books++;
            }

            if (trades > 0 && books > 0) {
              clearTimeout(timeout);
              ws.close();
              resolve({ trades, books });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ trades, books });
        });
      });

      expect(result.trades).toBeGreaterThan(0);
      expect(result.books).toBeGreaterThan(0);
    });
  });
});
