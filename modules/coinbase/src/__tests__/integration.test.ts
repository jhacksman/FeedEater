import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com";
const TEST_PAIR = "BTC-USD";
const CONNECTION_TIMEOUT = 10000;
const MESSAGE_TIMEOUT = 30000;
const TRADE_TIMEOUT = 60000;

interface CoinbaseMatchMessage {
  type: string;
  trade_id: number;
  product_id: string;
  price: string;
  size: string;
  side: string;
  time: string;
}

interface CoinbaseL2UpdateMessage {
  type: string;
  product_id: string;
  changes: [string, string, string][];
}

interface CoinbaseSnapshotMessage {
  type: string;
  product_id: string;
  bids: [string, string][];
  asks: [string, string][];
}

interface CoinbaseSubscriptionsMessage {
  type: string;
  channels: { name: string; product_ids: string[] }[];
}

describe("Coinbase WebSocket Integration Tests", () => {
  describe("WebSocket Connection", () => {
    it("should connect to Coinbase WebSocket", { timeout: CONNECTION_TIMEOUT }, async () => {
      const connected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(COINBASE_WS_URL);
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

    it("should receive subscriptions confirmation after subscribing", { timeout: CONNECTION_TIMEOUT }, async () => {
      const result = await new Promise<{ subscribed: boolean; channels: string[] }>((resolve) => {
        const ws = new WebSocket(COINBASE_WS_URL);
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ subscribed: false, channels: [] });
        }, CONNECTION_TIMEOUT);

        ws.on("open", () => {
          const subscribeMsg = {
            type: "subscribe",
            product_ids: [TEST_PAIR],
            channels: ["matches"],
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "subscriptions") {
              clearTimeout(timeout);
              ws.close();
              const channels = msg.channels?.map((c: any) => c.name) || [];
              resolve({ subscribed: true, channels });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ subscribed: false, channels: [] });
        });
      });

      expect(result.subscribed).toBe(true);
      expect(result.channels).toContain("matches");
    });
  });

  describe("Trade Stream (Matches)", () => {
    it("should receive and parse match messages", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ received: boolean; match: CoinbaseMatchMessage | null }>((resolve) => {
        const ws = new WebSocket(COINBASE_WS_URL);
        let match: CoinbaseMatchMessage | null = null;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, match: null });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          const subscribeMsg = {
            type: "subscribe",
            product_ids: [TEST_PAIR],
            channels: ["matches"],
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "match" || msg.type === "last_match") {
              match = msg;
              clearTimeout(timeout);
              ws.close();
              resolve({ received: true, match });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ received: false, match: null });
        });
      });

      expect(result.received).toBe(true);
      
      if (result.match) {
        expect(["match", "last_match"]).toContain(result.match.type);
        expect(result.match.product_id).toBe(TEST_PAIR);
        expect(typeof result.match.trade_id).toBe("number");
        expect(typeof result.match.price).toBe("string");
        expect(typeof result.match.size).toBe("string");
        expect(["buy", "sell"]).toContain(result.match.side);
        expect(typeof result.match.time).toBe("string");
        
        const price = parseFloat(result.match.price);
        const size = parseFloat(result.match.size);
        expect(price).toBeGreaterThan(0);
        expect(size).toBeGreaterThan(0);
      }
    });

    it("should parse trade side correctly", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<CoinbaseMatchMessage | null>((resolve) => {
        const ws = new WebSocket(COINBASE_WS_URL);
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          const subscribeMsg = {
            type: "subscribe",
            product_ids: [TEST_PAIR],
            channels: ["matches"],
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "match" || msg.type === "last_match") {
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
      expect(["buy", "sell"]).toContain(result!.side);
    });
  });

  describe("Orderbook Stream (Level2)", () => {
    it("should receive orderbook snapshot after subscribing to level2", { timeout: MESSAGE_TIMEOUT }, async () => {
      const result = await new Promise<{ received: boolean; snapshot: CoinbaseSnapshotMessage | null }>((resolve) => {
        const ws = new WebSocket(COINBASE_WS_URL);
        let snapshot: CoinbaseSnapshotMessage | null = null;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ received: false, snapshot: null });
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          const subscribeMsg = {
            type: "subscribe",
            product_ids: [TEST_PAIR],
            channels: ["level2_batch"],
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "snapshot") {
              snapshot = msg;
              clearTimeout(timeout);
              ws.close();
              resolve({ received: true, snapshot });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ received: false, snapshot: null });
        });
      });

      expect(result.received).toBe(true);
      
      if (result.snapshot) {
        expect(result.snapshot.type).toBe("snapshot");
        expect(result.snapshot.product_id).toBe(TEST_PAIR);
        expect(Array.isArray(result.snapshot.bids)).toBe(true);
        expect(Array.isArray(result.snapshot.asks)).toBe(true);
        expect(result.snapshot.bids.length).toBeGreaterThan(0);
        expect(result.snapshot.asks.length).toBeGreaterThan(0);
      }
    });

    it("should parse orderbook snapshot levels correctly", { timeout: MESSAGE_TIMEOUT }, async () => {
      const result = await new Promise<CoinbaseSnapshotMessage | null>((resolve) => {
        const ws = new WebSocket(COINBASE_WS_URL);
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          const subscribeMsg = {
            type: "subscribe",
            product_ids: [TEST_PAIR],
            channels: ["level2_batch"],
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "snapshot") {
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
        for (const bid of result.bids.slice(0, 10)) {
          expect(bid.length).toBe(2);
          const price = parseFloat(bid[0]);
          const size = parseFloat(bid[1]);
          expect(price).toBeGreaterThan(0);
          expect(size).toBeGreaterThanOrEqual(0);
        }
        
        for (const ask of result.asks.slice(0, 10)) {
          expect(ask.length).toBe(2);
          const price = parseFloat(ask[0]);
          const size = parseFloat(ask[1]);
          expect(price).toBeGreaterThan(0);
          expect(size).toBeGreaterThanOrEqual(0);
        }
        
        if (result.bids.length > 0 && result.asks.length > 0) {
          const bestBid = parseFloat(result.bids[0][0]);
          const bestAsk = parseFloat(result.asks[0][0]);
          expect(bestBid).toBeLessThan(bestAsk);
        }
      }
    });

    it("should receive l2update messages after snapshot", { timeout: MESSAGE_TIMEOUT }, async () => {
      const result = await new Promise<{ snapshot: boolean; updates: number }>((resolve) => {
        const ws = new WebSocket(COINBASE_WS_URL);
        let snapshot = false;
        let updates = 0;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ snapshot, updates });
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          const subscribeMsg = {
            type: "subscribe",
            product_ids: [TEST_PAIR],
            channels: ["level2_batch"],
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "snapshot") {
              snapshot = true;
            } else if (msg.type === "l2update") {
              updates++;
              if (updates >= 3) {
                clearTimeout(timeout);
                ws.close();
                resolve({ snapshot, updates });
              }
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ snapshot, updates });
        });
      });

      expect(result.snapshot).toBe(true);
      expect(result.updates).toBeGreaterThan(0);
    });

    it("should parse l2update changes correctly", { timeout: MESSAGE_TIMEOUT }, async () => {
      const result = await new Promise<CoinbaseL2UpdateMessage | null>((resolve) => {
        const ws = new WebSocket(COINBASE_WS_URL);
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, MESSAGE_TIMEOUT);

        ws.on("open", () => {
          const subscribeMsg = {
            type: "subscribe",
            product_ids: [TEST_PAIR],
            channels: ["level2_batch"],
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "l2update" && msg.changes && msg.changes.length > 0) {
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
      expect(result!.type).toBe("l2update");
      expect(result!.product_id).toBe(TEST_PAIR);
      expect(Array.isArray(result!.changes)).toBe(true);
      
      for (const change of result!.changes) {
        expect(change.length).toBe(3);
        const side = change[0];
        const price = parseFloat(change[1]);
        const size = parseFloat(change[2]);
        
        expect(["buy", "sell"]).toContain(side);
        expect(price).toBeGreaterThan(0);
        expect(size).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("Combined Subscriptions", () => {
    it("should receive both matches and level2 data", { timeout: TRADE_TIMEOUT }, async () => {
      const result = await new Promise<{ matches: number; snapshots: number; updates: number }>((resolve) => {
        const ws = new WebSocket(COINBASE_WS_URL);
        let matches = 0;
        let snapshots = 0;
        let updates = 0;
        
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ matches, snapshots, updates });
        }, TRADE_TIMEOUT - 1000);

        ws.on("open", () => {
          const subscribeMsg = {
            type: "subscribe",
            product_ids: [TEST_PAIR],
            channels: ["matches", "level2_batch"],
          };
          ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "match" || msg.type === "last_match") {
              matches++;
            } else if (msg.type === "snapshot") {
              snapshots++;
            } else if (msg.type === "l2update") {
              updates++;
            }
            
            if (matches > 0 && snapshots > 0 && updates > 0) {
              clearTimeout(timeout);
              ws.close();
              resolve({ matches, snapshots, updates });
            }
          } catch {
            // ignore
          }
        });

        ws.on("error", () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ matches, snapshots, updates });
        });
      });

      expect(result.matches).toBeGreaterThan(0);
      expect(result.snapshots).toBeGreaterThan(0);
      expect(result.updates).toBeGreaterThan(0);
    });
  });
});
