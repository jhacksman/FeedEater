import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";
const TEST_PAIR = "BTC/USD";
const CONNECTION_TIMEOUT = 10000;
const MESSAGE_TIMEOUT = 30000;
const TRADE_TIMEOUT = 60000;

interface KrakenTradeData {
  symbol: string;
  price: number;
  qty: number;
  side: string;
  timestamp: string;
}

interface KrakenTradeMessage {
  channel: string;
  type: string;
  data: KrakenTradeData[];
}

interface KrakenBookLevel {
  price: string;
  qty: string;
}

interface KrakenBookData {
  symbol: string;
  bids: KrakenBookLevel[];
  asks: KrakenBookLevel[];
}

interface KrakenBookMessage {
  channel: string;
  type: string;
  data: KrakenBookData[];
}

describe("Kraken WebSocket Integration Tests", () => {
  describe("WebSocket Connection", () => {
    it("should connect to Kraken WebSocket v2", async () => {
      const connected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(KRAKEN_WS_URL);
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

    it("should receive heartbeat or status message after connection", async () => {
      const result = await new Promise<{ received: boolean; messageType: string | null }>((resolve) => {
        const ws = new WebSocket(KRAKEN_WS_URL);
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, messageType: null });
        }, CONNECTION_TIMEOUT);

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            clearTimeout(timeout);
            ws.close();
            resolve({ received: true, messageType: msg.channel || msg.method || "unknown" });
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ received: false, messageType: null });
        });
      });

      expect(result.received).toBe(true);
    });
  });

  describe("Trade Stream Subscription", () => {
    it("should subscribe to trade channel and receive trades", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ subscribed: boolean; trade: KrakenTradeMessage | null }>((resolve) => {
        const ws = new WebSocket(KRAKEN_WS_URL);
        let subscribed = false;
        let trade: KrakenTradeMessage | null = null;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ subscribed, trade });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          const subscribeMsg = {
            method: "subscribe",
            params: {
              channel: "trade",
              symbol: [TEST_PAIR],
            },
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            
            if (msg.method === "subscribe" && msg.success === true) {
              subscribed = true;
            }
            
            if (msg.channel === "trade" && msg.data && msg.data.length > 0) {
              trade = msg;
              clearTimeout(timeout);
              ws.close();
              resolve({ subscribed: true, trade });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ subscribed: false, trade: null });
        });
      });

      expect(result.subscribed).toBe(true);
      
      if (result.trade) {
        expect(result.trade.channel).toBe("trade");
        expect(Array.isArray(result.trade.data)).toBe(true);
        expect(result.trade.data.length).toBeGreaterThan(0);
        
        const tradeData = result.trade.data[0];
        expect(tradeData.symbol).toBe(TEST_PAIR);
        expect(typeof tradeData.price).toBe("number");
        expect(typeof tradeData.qty).toBe("number");
        expect(["buy", "sell"]).toContain(tradeData.side);
        
        expect(tradeData.price).toBeGreaterThan(0);
        expect(tradeData.qty).toBeGreaterThan(0);
      }
    });

    it("should parse trade side correctly", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<KrakenTradeData | null>((resolve) => {
        const ws = new WebSocket(KRAKEN_WS_URL);
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          const subscribeMsg = {
            method: "subscribe",
            params: {
              channel: "trade",
              symbol: [TEST_PAIR],
            },
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.channel === "trade" && msg.data && msg.data.length > 0) {
              clearTimeout(timeout);
              ws.close();
              resolve(msg.data[0]);
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

      if (result) {
        expect(["buy", "sell"]).toContain(result.side);
      }
    });
  });

  describe("Orderbook Stream Subscription", () => {
    it("should subscribe to book channel and receive orderbook data", async () => {
      const result = await new Promise<{ subscribed: boolean; book: KrakenBookMessage | null }>((resolve) => {
        const ws = new WebSocket(KRAKEN_WS_URL);
        let subscribed = false;
        let book: KrakenBookMessage | null = null;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ subscribed, book });
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          const subscribeMsg = {
            method: "subscribe",
            params: {
              channel: "book",
              symbol: [TEST_PAIR],
              depth: 25,
            },
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            
            if (msg.method === "subscribe" && msg.success === true) {
              subscribed = true;
            }
            
            if (msg.channel === "book" && msg.data && msg.data.length > 0) {
              book = msg;
              clearTimeout(timeout);
              ws.close();
              resolve({ subscribed: true, book });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ subscribed: false, book: null });
        });
      });

      expect(result.subscribed).toBe(true);
      
      if (result.book) {
        expect(result.book.channel).toBe("book");
        expect(Array.isArray(result.book.data)).toBe(true);
        expect(result.book.data.length).toBeGreaterThan(0);
        
        const bookData = result.book.data[0];
        expect(bookData.symbol).toBe(TEST_PAIR);
      }
    });

    it("should parse orderbook levels correctly", async () => {
      const result = await new Promise<KrakenBookData | null>((resolve) => {
        const ws = new WebSocket(KRAKEN_WS_URL);
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          const subscribeMsg = {
            method: "subscribe",
            params: {
              channel: "book",
              symbol: [TEST_PAIR],
              depth: 25,
            },
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.channel === "book" && msg.data && msg.data.length > 0) {
              const bookData = msg.data[0];
              if ((bookData.bids && bookData.bids.length > 0) || (bookData.asks && bookData.asks.length > 0)) {
                clearTimeout(timeout);
                ws.close();
                resolve(bookData);
              }
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

      if (result) {
        if (result.bids && result.bids.length > 0) {
          for (const bid of result.bids) {
            const price = parseFloat(bid.price);
            const qty = parseFloat(bid.qty);
            expect(price).toBeGreaterThan(0);
            expect(qty).toBeGreaterThanOrEqual(0);
          }
        }
        
        if (result.asks && result.asks.length > 0) {
          for (const ask of result.asks) {
            const price = parseFloat(ask.price);
            const qty = parseFloat(ask.qty);
            expect(price).toBeGreaterThan(0);
            expect(qty).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  });

  describe("Combined Subscriptions", () => {
    it("should receive both trade and book messages", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ trades: number; books: number }>((resolve) => {
        const ws = new WebSocket(KRAKEN_WS_URL);
        let trades = 0;
        let books = 0;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ trades, books });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          const tradeSubscribe = {
            method: "subscribe",
            params: {
              channel: "trade",
              symbol: [TEST_PAIR],
            },
          };
          ws.send(JSON.stringify(tradeSubscribe));
          
          const bookSubscribe = {
            method: "subscribe",
            params: {
              channel: "book",
              symbol: [TEST_PAIR],
              depth: 25,
            },
          };
          ws.send(JSON.stringify(bookSubscribe));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.channel === "trade" && msg.data) {
              trades++;
            } else if (msg.channel === "book" && msg.data) {
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

      expect(result.books).toBeGreaterThan(0);
    });
  });
});
