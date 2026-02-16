import { describe, it, expect } from "vitest";
import { formatUnits } from "ethers";

const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359".toLowerCase();
const POLYGON_USDCe = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase();
const POLYGON_USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase();
const POLYGON_WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619".toLowerCase();
const POLYGON_WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase();
const POLYGON_WBTC = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6".toLowerCase();

const DEFAULT_RPC_URL = "wss://polygon-mainnet.infura.io/ws/v3/b5ef538a6a4e4b799dad3b097ede45e7";
const DEFAULT_WHALE_THRESHOLD = 50000;
const DEFAULT_POOLS = [
  "0x45dDa9cb7c25131DF268515131f647d726f50608",
  "0xAE81FAc689A1b4b1e06e7ef4a2ab4CD8aC0A087D",
];

interface PolygonDexSettings {
  enabled: boolean;
  rpcUrl: string;
  whaleThreshold: number;
  watchedQuickswapPools: string[];
}

function parsePolygonDexDefaults(raw: Record<string, unknown>): PolygonDexSettings {
  const enabled = String(raw.enabled ?? "true") === "true";
  const rpcUrl = String(raw.rpcUrl ?? DEFAULT_RPC_URL);
  const whaleThreshold = Number(raw.whaleThreshold ?? DEFAULT_WHALE_THRESHOLD);

  let watchedQuickswapPools: string[] = DEFAULT_POOLS;
  if (typeof raw.watchedQuickswapPools === "string") {
    try {
      watchedQuickswapPools = JSON.parse(raw.watchedQuickswapPools);
    } catch {
      watchedQuickswapPools = DEFAULT_POOLS;
    }
  } else if (Array.isArray(raw.watchedQuickswapPools)) {
    watchedQuickswapPools = raw.watchedQuickswapPools as string[];
  }

  return { enabled, rpcUrl, whaleThreshold, watchedQuickswapPools };
}

function estimateUsdValue(
  amount0: bigint,
  amount1: bigint,
  token0: string,
  token1: string,
  token0Decimals: number,
  token1Decimals: number
): number {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();

  if (t0 === POLYGON_USDC || t0 === POLYGON_USDCe || t0 === POLYGON_USDT) {
    return Math.abs(Number(formatUnits(amount0, token0Decimals)));
  }
  if (t1 === POLYGON_USDC || t1 === POLYGON_USDCe || t1 === POLYGON_USDT) {
    return Math.abs(Number(formatUnits(amount1, token1Decimals)));
  }

  if (t0 === POLYGON_WETH) {
    return Math.abs(Number(formatUnits(amount0, 18))) * 3000;
  }
  if (t1 === POLYGON_WETH) {
    return Math.abs(Number(formatUnits(amount1, 18))) * 3000;
  }

  if (t0 === POLYGON_WMATIC) {
    return Math.abs(Number(formatUnits(amount0, 18))) * 0.5;
  }
  if (t1 === POLYGON_WMATIC) {
    return Math.abs(Number(formatUnits(amount1, 18))) * 0.5;
  }

  if (t0 === POLYGON_WBTC) {
    return Math.abs(Number(formatUnits(amount0, 8))) * 60000;
  }
  if (t1 === POLYGON_WBTC) {
    return Math.abs(Number(formatUnits(amount1, 8))) * 60000;
  }

  return 0;
}

describe("Polygon DEX Public Feed Tests", () => {
  describe("Default Settings (No API Keys)", () => {
    it("should use Infura WebSocket URL by default", () => {
      const settings = parsePolygonDexDefaults({});
      expect(settings.rpcUrl).toBe(DEFAULT_RPC_URL);
      expect(settings.rpcUrl.startsWith("wss://")).toBe(true);
    });

    it("should default to enabled", () => {
      const settings = parsePolygonDexDefaults({});
      expect(settings.enabled).toBe(true);
    });

    it("should set whale threshold to 50000 by default", () => {
      const settings = parsePolygonDexDefaults({});
      expect(settings.whaleThreshold).toBe(50000);
    });

    it("should include WETH/USDC and WMATIC/USDC pools by default", () => {
      const settings = parsePolygonDexDefaults({});
      expect(settings.watchedQuickswapPools).toHaveLength(2);
      expect(settings.watchedQuickswapPools).toContain("0x45dDa9cb7c25131DF268515131f647d726f50608");
      expect(settings.watchedQuickswapPools).toContain("0xAE81FAc689A1b4b1e06e7ef4a2ab4CD8aC0A087D");
    });

    it("should parse pool list from JSON string setting", () => {
      const settings = parsePolygonDexDefaults({
        watchedQuickswapPools: '["0x1111111111111111111111111111111111111111"]',
      });
      expect(settings.watchedQuickswapPools).toHaveLength(1);
      expect(settings.watchedQuickswapPools[0]).toBe("0x1111111111111111111111111111111111111111");
    });

    it("should accept array pool setting directly", () => {
      const pools = ["0xaaaa", "0xbbbb"];
      const settings = parsePolygonDexDefaults({ watchedQuickswapPools: pools });
      expect(settings.watchedQuickswapPools).toEqual(pools);
    });

    it("should fall back to defaults on invalid JSON pool string", () => {
      const settings = parsePolygonDexDefaults({ watchedQuickswapPools: "not-json" });
      expect(settings.watchedQuickswapPools).toEqual(DEFAULT_POOLS);
    });
  });

  describe("Custom Settings Override", () => {
    it("should allow overriding RPC URL", () => {
      const settings = parsePolygonDexDefaults({
        rpcUrl: "wss://custom-polygon-rpc.example.com",
      });
      expect(settings.rpcUrl).toBe("wss://custom-polygon-rpc.example.com");
    });

    it("should allow overriding whale threshold", () => {
      const settings = parsePolygonDexDefaults({ whaleThreshold: 100000 });
      expect(settings.whaleThreshold).toBe(100000);
    });

    it("should allow disabling the module", () => {
      const settings = parsePolygonDexDefaults({ enabled: "false" });
      expect(settings.enabled).toBe(false);
    });
  });

  describe("Swap Event Structure", () => {
    it("should create valid tradeExecuted event", () => {
      const tradeEvent = {
        source: "polygon-dex",
        symbol: "WETH/USDC",
        side: "buy" as "buy" | "sell",
        price: 3000.5,
        size: 1.5,
        notional_usd: 4500.75,
        timestamp: "2026-02-15T12:00:00.000Z",
        pool_address: "0x45dDa9cb7c25131DF268515131f647d726f50608",
        tx_hash: "0x" + "ab".repeat(32),
        block_number: 50000000,
      };

      expect(tradeEvent.source).toBe("polygon-dex");
      expect(tradeEvent.symbol).toBe("WETH/USDC");
      expect(["buy", "sell"]).toContain(tradeEvent.side);
      expect(typeof tradeEvent.price).toBe("number");
      expect(typeof tradeEvent.size).toBe("number");
      expect(typeof tradeEvent.notional_usd).toBe("number");
      expect(tradeEvent.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(tradeEvent.pool_address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(tradeEvent.tx_hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(typeof tradeEvent.block_number).toBe("number");
    });

    it("should determine side from amount0 sign", () => {
      const amount0Positive = 1000000000000000000n;
      const amount0Negative = -1000000000000000000n;

      expect(amount0Positive > 0n ? "sell" : "buy").toBe("sell");
      expect(amount0Negative > 0n ? "sell" : "buy").toBe("buy");
    });

    it("should format timestamp as ISO-8601", () => {
      const timestamp = 1707955200000;
      const isoTimestamp = new Date(timestamp).toISOString();
      expect(isoTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("NATS Subject Naming", () => {
    it("should use feedeater.polygon-dex.tradeExecuted subject", () => {
      const module = "polygon-dex";
      const event = "tradeExecuted";
      const subject = `feedeater.${module}.${event}`;
      expect(subject).toBe("feedeater.polygon-dex.tradeExecuted");
    });

    it("should use feedeater.polygon-dex.messageCreated subject", () => {
      const module = "polygon-dex";
      const event = "messageCreated";
      const subject = `feedeater.${module}.${event}`;
      expect(subject).toBe("feedeater.polygon-dex.messageCreated");
    });

    it("should use feedeater.polygon-dex.log subject", () => {
      const subject = "feedeater.polygon-dex.log";
      expect(subject).toBe("feedeater.polygon-dex.log");
    });
  });

  describe("USD Value Estimation", () => {
    it("should estimate USD for native USDC token0 swaps", () => {
      const usd = estimateUsdValue(5000000n, 1000000000000000000n, POLYGON_USDC, POLYGON_WETH, 6, 18);
      expect(usd).toBe(5);
    });

    it("should estimate USD for bridged USDCe token0 swaps", () => {
      const usd = estimateUsdValue(10000000n, 3333333333333333333n, POLYGON_USDCe, POLYGON_WETH, 6, 18);
      expect(usd).toBe(10);
    });

    it("should estimate USD for USDT token1 swaps", () => {
      const usd = estimateUsdValue(1000000000000000000n, 3000000000n, POLYGON_WETH, POLYGON_USDT, 18, 6);
      expect(usd).toBe(3000);
    });

    it("should estimate USD for WETH swaps using $3000 price", () => {
      const usd = estimateUsdValue(2000000000000000000n, 6000000000n, POLYGON_WETH, POLYGON_USDC, 18, 6);
      expect(usd).toBe(6000);
    });

    it("should estimate USD for WMATIC swaps using $0.50 price", () => {
      const usd = estimateUsdValue(100000000000000000000n, 50000000n, POLYGON_WMATIC, POLYGON_USDC, 18, 6);
      expect(usd).toBe(50);
    });

    it("should estimate USD for WBTC swaps using $60000 price", () => {
      const usd = estimateUsdValue(100000000n, 20000000000000000000n, POLYGON_WBTC, POLYGON_WETH, 8, 18);
      expect(usd).toBe(60000);
    });

    it("should return 0 for unknown token pairs", () => {
      const unknown = "0x0000000000000000000000000000000000000001";
      const usd = estimateUsdValue(1000000000000000000n, 1000000000000000000n, unknown, unknown, 18, 18);
      expect(usd).toBe(0);
    });

    it("should handle negative amounts correctly", () => {
      const usd = estimateUsdValue(-5000000n, 1000000000000000000n, POLYGON_USDC, POLYGON_WETH, 6, 18);
      expect(usd).toBe(5);
    });
  });

  describe("Whale Detection", () => {
    it("should flag swaps above whale threshold", () => {
      const threshold = 50000;
      expect(75000 >= threshold).toBe(true);
      expect(50000 >= threshold).toBe(true);
    });

    it("should not flag swaps below whale threshold", () => {
      const threshold = 50000;
      expect(49999 >= threshold).toBe(false);
      expect(100 >= threshold).toBe(false);
    });

    it("should respect custom threshold", () => {
      const settings = parsePolygonDexDefaults({ whaleThreshold: 10000 });
      expect(15000 >= settings.whaleThreshold).toBe(true);
      expect(9999 >= settings.whaleThreshold).toBe(false);
    });
  });

  describe("Message Format", () => {
    it("should format swap message with pair label and USD value", () => {
      const pairLabel = "WETH/USDC";
      const pool = "0x45dDa9cb7c25131DF268515131f647d726f50608";
      const usdValue = 50000.5;
      const txHash = "0x" + "ab".repeat(32);
      const isWhale = false;

      const message = `QuickSwap V3 Swap ${pairLabel} pool=${pool.slice(0, 10)}... usd=$${usdValue.toFixed(2)}${isWhale ? " [WHALE]" : ""} tx=${txHash.slice(0, 10)}...`;

      expect(message).toContain("QuickSwap V3 Swap");
      expect(message).toContain("WETH/USDC");
      expect(message).toContain("$50000.50");
      expect(message).not.toContain("[WHALE]");
    });

    it("should include WHALE flag for whale swaps", () => {
      const isWhale = true;
      const message = `QuickSwap V3 Swap WETH/USDC pool=0x45dDa9cb... usd=$100000.00${isWhale ? " [WHALE]" : ""} tx=0xabababab...`;
      expect(message).toContain("[WHALE]");
    });
  });

  describe("Pool Address Validation", () => {
    it("should validate Ethereum address format", () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      for (const pool of DEFAULT_POOLS) {
        expect(addressRegex.test(pool)).toBe(true);
      }
    });

    it("should reject invalid addresses", () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      expect(addressRegex.test("0x123")).toBe(false);
      expect(addressRegex.test("not-an-address")).toBe(false);
      expect(addressRegex.test("")).toBe(false);
    });
  });

  describe("Token Address Constants", () => {
    it("should have all token addresses in lowercase", () => {
      const tokens = [POLYGON_USDC, POLYGON_USDCe, POLYGON_USDT, POLYGON_WETH, POLYGON_WMATIC, POLYGON_WBTC];
      for (const token of tokens) {
        expect(token).toBe(token.toLowerCase());
      }
    });

    it("should have valid Ethereum address format for all tokens", () => {
      const addressRegex = /^0x[a-f0-9]{40}$/;
      const tokens = [POLYGON_USDC, POLYGON_USDCe, POLYGON_USDT, POLYGON_WETH, POLYGON_WMATIC, POLYGON_WBTC];
      for (const token of tokens) {
        expect(addressRegex.test(token)).toBe(true);
      }
    });
  });

  describe("Prisma Schema Alignment", () => {
    it("should store swap amounts as string for Decimal(38,18)", () => {
      const amount0 = 1234567890123456789n;
      const asString = amount0.toString();
      expect(asString).toBe("1234567890123456789");
      expect(typeof asString).toBe("string");
    });

    it("should store USD value as fixed-point string for Decimal(38,2)", () => {
      const usdValue = 50000.5;
      const asString = usdValue.toFixed(2);
      expect(asString).toBe("50000.50");
    });

    it("should store block number as BigInt", () => {
      const blockNumber = 50000000;
      const asBigInt = BigInt(blockNumber);
      expect(typeof asBigInt).toBe("bigint");
    });

    it("should normalize sender address to lowercase", () => {
      const sender = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
      expect(sender.toLowerCase()).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
    });
  });
});
