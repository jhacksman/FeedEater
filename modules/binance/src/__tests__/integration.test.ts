import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const BINANCE_WS_URL = "wss://stream.binance.us:9443/ws";
const TEST_PAIR = "btcusdt";
const CONNECTION_TIMEOUT = 10000;
const MESSAGE_TIMEOUT = 30000;
const TRADE_TIMEOUT = 60000;

interface BinanceTradeMessage {
  e: string;
  s: string;
  p: string;
  q: string;
  m: boolean;
  T: number;
  t: number;
}

interface BinanceDepthMessage {
  e: string;
  s: string;
  b: [string, string][];
  a: [string, string][];
}

describe("Binance WebSocket Integration Tests", () => {
  describe("WebSocket Connection", () => {
    it("should connect to Binance WebSocket", async () => {
      const wsUrl = `${BINANCE_WS_URL}/${TEST_PAIR}@trade`;
      
      const connected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl);
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

    it("should handle connection to multiple streams", async () => {
      const streams = [`${TEST_PAIR}@trade`, `${TEST_PAIR}@depth@100ms`];
      const wsUrl = `${BINANCE_WS_URL}/${streams.join("/")}`;
      
      const connected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl);
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
  });

  describe("Trade Stream Parsing", () => {
    it("should receive and parse trade messages", { timeout: TRADE_TIMEOUT }, async () => {
      const wsUrl = `${BINANCE_WS_URL}/${TEST_PAIR}@trade`;
      
      const result = await new Promise<{ received: boolean; trade: BinanceTradeMessage | null }>((resolve) => {
        const ws = new WebSocket(wsUrl);
        let trade: BinanceTradeMessage | null = null;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, trade: null });
        }, TRADE_TIMEOUT - 1000);

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.e === "trade") {
              trade = msg;
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
        expect(result.trade.e).toBe("trade");
        expect(result.trade.s).toBe("BTCUSDT");
        expect(typeof result.trade.p).toBe("string");
        expect(typeof result.trade.q).toBe("string");
        expect(typeof result.trade.m).toBe("boolean");
        expect(typeof result.trade.T).toBe("number");
        expect(typeof result.trade.t).toBe("number");
        
        const price = parseFloat(result.trade.p);
        const quantity = parseFloat(result.trade.q);
        expect(price).toBeGreaterThan(0);
        expect(quantity).toBeGreaterThan(0);
      }
    });

    it("should correctly determine trade side from maker flag", { timeout: TRADE_TIMEOUT }, async () => {
      const wsUrl = `${BINANCE_WS_URL}/${TEST_PAIR}@trade`;
      
      const result = await new Promise<BinanceTradeMessage | null>((resolve) => {
        const ws = new WebSocket(wsUrl);
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, TRADE_TIMEOUT - 1000);

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.e === "trade") {
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
        const side = result.m ? "sell" : "buy";
        expect(["buy", "sell"]).toContain(side);
      }
    });
  });

  describe("Orderbook Snapshot Parsing", () => {
    it("should receive and parse depth update messages", async () => {
      const wsUrl = `${BINANCE_WS_URL}/${TEST_PAIR}@depth@100ms`;
      
      const result = await new Promise<{ received: boolean; depth: BinanceDepthMessage | null }>((resolve) => {
        const ws = new WebSocket(wsUrl);
        let depth: BinanceDepthMessage | null = null;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, depth: null });
        }, MESSAGE_TIMEOUT);

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.e === "depthUpdate") {
              depth = msg;
              clearTimeout(timeout);
              ws.close();
              resolve({ received: true, depth });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ received: false, depth: null });
        });
      });

      expect(result.received).toBe(true);
      expect(result.depth).not.toBeNull();
      
      if (result.depth) {
        expect(result.depth.e).toBe("depthUpdate");
        expect(result.depth.s).toBe("BTCUSDT");
        expect(Array.isArray(result.depth.b)).toBe(true);
        expect(Array.isArray(result.depth.a)).toBe(true);
      }
    });

    it("should parse orderbook levels correctly", async () => {
      const wsUrl = `${BINANCE_WS_URL}/${TEST_PAIR}@depth@100ms`;
      
      const result = await new Promise<BinanceDepthMessage | null>((resolve) => {
        const ws = new WebSocket(wsUrl);
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, MESSAGE_TIMEOUT);

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.e === "depthUpdate" && (msg.b.length > 0 || msg.a.length > 0)) {
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
        for (const bid of result.b) {
          expect(bid.length).toBe(2);
          const price = parseFloat(bid[0]);
          const size = parseFloat(bid[1]);
          expect(price).toBeGreaterThanOrEqual(0);
          expect(size).toBeGreaterThanOrEqual(0);
        }
        
        for (const ask of result.a) {
          expect(ask.length).toBe(2);
          const price = parseFloat(ask[0]);
          const size = parseFloat(ask[1]);
          expect(price).toBeGreaterThanOrEqual(0);
          expect(size).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe("Combined Stream", () => {
    it("should receive both trade and depth messages on combined stream", { timeout: TRADE_TIMEOUT }, async () => {
      const streams = [`${TEST_PAIR}@trade`, `${TEST_PAIR}@depth@100ms`];
      const wsUrl = `${BINANCE_WS_URL}/${streams.join("/")}`;
      
      const result = await new Promise<{ trades: number; depths: number }>((resolve) => {
        const ws = new WebSocket(wsUrl);
        let trades = 0;
        let depths = 0;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ trades, depths });
        }, TRADE_TIMEOUT - 1000);

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.e === "trade") {
              trades++;
            } else if (msg.e === "depthUpdate") {
              depths++;
            }
            
            if (trades > 0 && depths > 0) {
              clearTimeout(timeout);
              ws.close();
              resolve({ trades, depths });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ trades, depths });
        });
      });

      expect(result.trades).toBeGreaterThan(0);
      expect(result.depths).toBeGreaterThan(0);
    });
  });
});
