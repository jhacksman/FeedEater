import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const GEMINI_WS_URL = "wss://api.gemini.com/v2/marketdata";
const CONNECTION_TIMEOUT = 10000;
const MESSAGE_TIMEOUT = 30000;
const TRADE_TIMEOUT = 60000;

interface GeminiTradeMessage {
  type: "trade";
  symbol: string;
  event_id: number;
  timestamp: number;
  price: string;
  quantity: string;
  side: "buy" | "sell";
  tid: number;
}

interface GeminiL2Update {
  type: "l2_updates";
  symbol: string;
  changes: [string, string, string][];
  trades?: GeminiTradeMessage[];
}

describe("Gemini WebSocket Integration Tests", () => {
  describe("WebSocket Connection", () => {
    it("should connect to Gemini WebSocket v2", { timeout: CONNECTION_TIMEOUT }, async () => {
      const connected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(GEMINI_WS_URL);
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

    it("should accept l2 subscription for multiple symbols", { timeout: CONNECTION_TIMEOUT }, async () => {
      const subscribed = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(GEMINI_WS_URL);
        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, CONNECTION_TIMEOUT);

        ws.on("open", () => {
          const msg = {
            type: "subscribe",
            subscriptions: [{ name: "l2", symbols: ["BTCUSD", "ETHUSD"] }],
          };
          ws.send(JSON.stringify(msg));
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

      expect(subscribed).toBe(true);
    });
  });

  describe("Trade Stream Parsing", () => {
    it("should receive trade messages after subscribing to l2", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ received: boolean; trade: GeminiTradeMessage | null }>((resolve) => {
        const ws = new WebSocket(GEMINI_WS_URL);
        let trade: GeminiTradeMessage | null = null;

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, trade: null });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          const msg = {
            type: "subscribe",
            subscriptions: [{ name: "l2", symbols: ["BTCUSD"] }],
          };
          ws.send(JSON.stringify(msg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());

            if (msg.type === "trade") {
              trade = msg;
              clearTimeout(timeout);
              ws.close();
              resolve({ received: true, trade });
              return;
            }

            if (msg.type === "l2_updates" && Array.isArray(msg.trades) && msg.trades.length > 0) {
              trade = msg.trades[0];
              clearTimeout(timeout);
              ws.close();
              resolve({ received: true, trade });
              return;
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
        expect(result.trade.type).toBe("trade");
        expect(typeof result.trade.symbol).toBe("string");
        expect(typeof result.trade.price).toBe("string");
        expect(typeof result.trade.quantity).toBe("string");
        expect(["buy", "sell"]).toContain(result.trade.side);
        expect(typeof result.trade.tid).toBe("number");

        const price = parseFloat(result.trade.price);
        const quantity = parseFloat(result.trade.quantity);
        expect(price).toBeGreaterThan(0);
        expect(quantity).toBeGreaterThan(0);
      }
    });

    it("should correctly provide trade side as buy or sell", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<GeminiTradeMessage | null>((resolve) => {
        const ws = new WebSocket(GEMINI_WS_URL);

        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          const msg = {
            type: "subscribe",
            subscriptions: [{ name: "l2", symbols: ["BTCUSD"] }],
          };
          ws.send(JSON.stringify(msg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "trade") {
              clearTimeout(timeout);
              ws.close();
              resolve(msg);
              return;
            }
            if (msg.type === "l2_updates" && Array.isArray(msg.trades) && msg.trades.length > 0) {
              clearTimeout(timeout);
              ws.close();
              resolve(msg.trades[0]);
              return;
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
      expect(["buy", "sell"]).toContain(result!.side);
    });
  });

  describe("L2 Order Book Updates", () => {
    it("should receive l2_updates messages", { timeout: MESSAGE_TIMEOUT }, async () => {
      const result = await new Promise<{ received: boolean; update: GeminiL2Update | null }>((resolve) => {
        const ws = new WebSocket(GEMINI_WS_URL);
        let update: GeminiL2Update | null = null;

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, update: null });
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          const msg = {
            type: "subscribe",
            subscriptions: [{ name: "l2", symbols: ["BTCUSD"] }],
          };
          ws.send(JSON.stringify(msg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "l2_updates") {
              update = msg;
              clearTimeout(timeout);
              ws.close();
              resolve({ received: true, update });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ received: false, update: null });
        });
      });

      expect(result.received).toBe(true);
      expect(result.update).not.toBeNull();

      if (result.update) {
        expect(result.update.type).toBe("l2_updates");
        expect(result.update.symbol).toBe("BTCUSD");
        expect(Array.isArray(result.update.changes)).toBe(true);
      }
    });

    it("should parse orderbook level changes correctly", { timeout: MESSAGE_TIMEOUT }, async () => {
      const result = await new Promise<GeminiL2Update | null>((resolve) => {
        const ws = new WebSocket(GEMINI_WS_URL);

        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          const msg = {
            type: "subscribe",
            subscriptions: [{ name: "l2", symbols: ["BTCUSD"] }],
          };
          ws.send(JSON.stringify(msg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "l2_updates" && msg.changes && msg.changes.length > 0) {
              clearTimeout(timeout);
              ws.close();
              resolve(msg);
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
        for (const change of result.changes) {
          expect(change.length).toBeGreaterThanOrEqual(3);
          expect(["buy", "sell"]).toContain(change[0]);
          const price = parseFloat(change[1]);
          const size = parseFloat(change[2]);
          expect(price).toBeGreaterThanOrEqual(0);
          expect(size).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe("Multi-Symbol Subscription", () => {
    it("should receive data for multiple symbols on a single connection", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ symbols: Set<string> }>((resolve) => {
        const ws = new WebSocket(GEMINI_WS_URL);
        const symbols = new Set<string>();

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ symbols });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          const msg = {
            type: "subscribe",
            subscriptions: [{ name: "l2", symbols: ["BTCUSD", "ETHUSD"] }],
          };
          ws.send(JSON.stringify(msg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.symbol) {
              symbols.add(msg.symbol);
            }
            if (symbols.size >= 2) {
              clearTimeout(timeout);
              ws.close();
              resolve({ symbols });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ symbols });
        });
      });

      expect(result.symbols.size).toBeGreaterThanOrEqual(2);
      expect(result.symbols.has("BTCUSD")).toBe(true);
      expect(result.symbols.has("ETHUSD")).toBe(true);
    });
  });
});
