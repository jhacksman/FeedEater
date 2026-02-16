import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const BYBIT_WS_URL = "wss://stream.bybit.com/v5/public/spot";
const TEST_PAIR = "BTCUSDT";
const CONNECTION_TIMEOUT = 10000;
const MESSAGE_TIMEOUT = 30000;
const TRADE_TIMEOUT = 60000;

interface BybitTradeData {
  T: number;
  s: string;
  S: string;
  v: string;
  p: string;
  i: string;
  BT: boolean;
}

interface BybitTradeMessage {
  topic: string;
  type: string;
  ts: number;
  data: BybitTradeData[];
}

interface BybitOrderbookMessage {
  topic: string;
  type: string;
  ts: number;
  data: {
    s: string;
    b: [string, string][];
    a: [string, string][];
    u: number;
    seq: number;
  };
}

describe("Bybit WebSocket Integration Tests", () => {
  describe("WebSocket Connection", () => {
    it("should connect to Bybit WebSocket", { timeout: CONNECTION_TIMEOUT }, async () => {
      const connected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(BYBIT_WS_URL);
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

    it("should accept subscription message", { timeout: CONNECTION_TIMEOUT }, async () => {
      const result = await new Promise<{ connected: boolean; subscribed: boolean }>((resolve) => {
        const ws = new WebSocket(BYBIT_WS_URL);
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ connected: false, subscribed: false });
        }, CONNECTION_TIMEOUT);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            op: "subscribe",
            args: [`publicTrade.${TEST_PAIR}`],
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.op === "subscribe" && msg.success === true) {
              clearTimeout(timeout);
              ws.close();
              resolve({ connected: true, subscribed: true });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ connected: false, subscribed: false });
        });
      });

      expect(result.connected).toBe(true);
      expect(result.subscribed).toBe(true);
    });
  });

  describe("Trade Stream Parsing", () => {
    it("should receive and parse trade messages", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ received: boolean; trade: BybitTradeData | null }>((resolve) => {
        const ws = new WebSocket(BYBIT_WS_URL);
        let trade: BybitTradeData | null = null;

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, trade: null });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            op: "subscribe",
            args: [`publicTrade.${TEST_PAIR}`],
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.topic && msg.topic.startsWith("publicTrade.") && msg.data) {
              trade = msg.data[0];
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
        expect(result.trade.s).toBe("BTCUSDT");
        expect(typeof result.trade.p).toBe("string");
        expect(typeof result.trade.v).toBe("string");
        expect(typeof result.trade.S).toBe("string");
        expect(["Buy", "Sell"]).toContain(result.trade.S);
        expect(typeof result.trade.T).toBe("number");
        expect(typeof result.trade.i).toBe("string");

        const price = parseFloat(result.trade.p);
        const quantity = parseFloat(result.trade.v);
        expect(price).toBeGreaterThan(0);
        expect(quantity).toBeGreaterThan(0);
      }
    });

    it("should correctly parse trade side from S field", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<BybitTradeData | null>((resolve) => {
        const ws = new WebSocket(BYBIT_WS_URL);

        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            op: "subscribe",
            args: [`publicTrade.${TEST_PAIR}`],
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.topic && msg.topic.startsWith("publicTrade.") && msg.data) {
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

      expect(result).not.toBeNull();
      expect(["Buy", "Sell"]).toContain(result!.S);
      const side = result!.S.toLowerCase();
      expect(["buy", "sell"]).toContain(side);
    });
  });

  describe("Ping/Pong Keepalive", () => {
    it("should respond to ping with pong", { timeout: CONNECTION_TIMEOUT }, async () => {
      const result = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(BYBIT_WS_URL);

        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, CONNECTION_TIMEOUT);

        ws.on("open", () => {
          ws.send(JSON.stringify({ op: "ping" }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.op === "pong") {
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

      expect(result).toBe(true);
    });
  });

  describe("Combined Stream", () => {
    it("should receive trade messages for multiple pairs", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ btc: number; eth: number }>((resolve) => {
        const ws = new WebSocket(BYBIT_WS_URL);
        let btc = 0;
        let eth = 0;

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ btc, eth });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            op: "subscribe",
            args: ["publicTrade.BTCUSDT", "publicTrade.ETHUSDT"],
          }));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.topic === "publicTrade.BTCUSDT" && msg.data) {
              btc += msg.data.length;
            } else if (msg.topic === "publicTrade.ETHUSDT" && msg.data) {
              eth += msg.data.length;
            }

            if (btc > 0 && eth > 0) {
              clearTimeout(timeout);
              ws.close();
              resolve({ btc, eth });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ btc, eth });
        });
      });

      expect(result.btc).toBeGreaterThan(0);
      expect(result.eth).toBeGreaterThan(0);
    });
  });
});
