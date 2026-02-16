import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const OKX_WS_URL = "wss://ws.okx.com:8443/ws/v5/public";
const TEST_PAIR = "BTC-USDT";
const CONNECTION_TIMEOUT = 10000;
const MESSAGE_TIMEOUT = 30000;
const TRADE_TIMEOUT = 60000;

interface OkxTradeData {
  instId: string;
  tradeId: string;
  px: string;
  sz: string;
  side: string;
  ts: string;
}

interface OkxTradeMessage {
  arg: { channel: string; instId: string };
  data: OkxTradeData[];
}

interface OkxEventMessage {
  event: string;
  arg?: { channel: string; instId: string };
  code?: string;
  msg?: string;
}

describe("OKX WebSocket Integration Tests", () => {
  describe("WebSocket Connection", () => {
    it("should connect to OKX public WebSocket", { timeout: CONNECTION_TIMEOUT }, async () => {
      const connected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(OKX_WS_URL);
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

    it("should receive subscription confirmation", { timeout: MESSAGE_TIMEOUT }, async () => {
      const result = await new Promise<{ confirmed: boolean; arg: any }>((resolve) => {
        const ws = new WebSocket(OKX_WS_URL);
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ confirmed: false, arg: null });
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              op: "subscribe",
              args: [{ channel: "trades", instId: TEST_PAIR }],
            })
          );
        });

        ws.on("message", (data: Buffer) => {
          try {
            const raw = data.toString();
            if (raw === "pong") return;
            const msg = JSON.parse(raw) as OkxEventMessage;
            if (msg.event === "subscribe") {
              clearTimeout(timeout);
              ws.close();
              resolve({ confirmed: true, arg: msg.arg });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ confirmed: false, arg: null });
        });
      });

      expect(result.confirmed).toBe(true);
      expect(result.arg).toBeDefined();
      if (result.arg) {
        expect(result.arg.channel).toBe("trades");
        expect(result.arg.instId).toBe(TEST_PAIR);
      }
    });
  });

  describe("Trade Stream Parsing", () => {
    it("should receive and parse trade messages", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ received: boolean; trade: OkxTradeData | null }>((resolve) => {
        const ws = new WebSocket(OKX_WS_URL);
        let trade: OkxTradeData | null = null;

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, trade: null });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              op: "subscribe",
              args: [{ channel: "trades", instId: TEST_PAIR }],
            })
          );
        });

        ws.on("message", (data: Buffer) => {
          try {
            const raw = data.toString();
            if (raw === "pong") return;
            const msg = JSON.parse(raw);
            if (msg.arg && msg.arg.channel === "trades" && Array.isArray(msg.data) && msg.data.length > 0) {
              trade = msg.data[0];
              clearTimeout(timeout);
              ws.close();
              resolve({ received: true, trade });
            }
          } catch {
            // ignore
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
        expect(result.trade.instId).toBe(TEST_PAIR);
        expect(typeof result.trade.tradeId).toBe("string");
        expect(typeof result.trade.px).toBe("string");
        expect(typeof result.trade.sz).toBe("string");
        expect(typeof result.trade.side).toBe("string");
        expect(typeof result.trade.ts).toBe("string");

        const price = parseFloat(result.trade.px);
        const size = parseFloat(result.trade.sz);
        expect(price).toBeGreaterThan(0);
        expect(size).toBeGreaterThan(0);
        expect(["buy", "sell"]).toContain(result.trade.side);
      }
    });

    it("should correctly provide explicit trade side", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<OkxTradeData | null>((resolve) => {
        const ws = new WebSocket(OKX_WS_URL);

        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              op: "subscribe",
              args: [{ channel: "trades", instId: TEST_PAIR }],
            })
          );
        });

        ws.on("message", (data: Buffer) => {
          try {
            const raw = data.toString();
            if (raw === "pong") return;
            const msg = JSON.parse(raw);
            if (msg.arg && msg.arg.channel === "trades" && Array.isArray(msg.data) && msg.data.length > 0) {
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
      expect(["buy", "sell"]).toContain(result!.side);
    });
  });

  describe("Ping/Pong Keepalive", () => {
    it("should receive pong response to ping", { timeout: CONNECTION_TIMEOUT }, async () => {
      const result = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(OKX_WS_URL);

        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, CONNECTION_TIMEOUT);

        ws.on("open", () => {
          ws.send("ping");
        });

        ws.on("message", (data: Buffer) => {
          const raw = data.toString();
          if (raw === "pong") {
            clearTimeout(timeout);
            ws.close();
            resolve(true);
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

  describe("Multiple Pairs Subscription", () => {
    it("should subscribe to multiple pairs simultaneously", { timeout: MESSAGE_TIMEOUT }, async () => {
      const pairs = ["BTC-USDT", "ETH-USDT", "SOL-USDT"];

      const result = await new Promise<{ confirmedPairs: string[] }>((resolve) => {
        const ws = new WebSocket(OKX_WS_URL);
        const confirmedPairs: string[] = [];

        const timeout = setTimeout(() => {
          ws.close();
          resolve({ confirmedPairs });
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              op: "subscribe",
              args: pairs.map((instId) => ({ channel: "trades", instId })),
            })
          );
        });

        ws.on("message", (data: Buffer) => {
          try {
            const raw = data.toString();
            if (raw === "pong") return;
            const msg = JSON.parse(raw) as OkxEventMessage;
            if (msg.event === "subscribe" && msg.arg) {
              confirmedPairs.push(msg.arg.instId);
              if (confirmedPairs.length === pairs.length) {
                clearTimeout(timeout);
                ws.close();
                resolve({ confirmedPairs });
              }
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ confirmedPairs });
        });
      });

      expect(result.confirmedPairs).toContain("BTC-USDT");
      expect(result.confirmedPairs).toContain("ETH-USDT");
      expect(result.confirmedPairs).toContain("SOL-USDT");
    });
  });
});
