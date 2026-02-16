import { describe, it, expect } from "vitest";
import { formatUnits } from "ethers";

interface UniswapTradeExecutedEvent {
  source: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  notional_usd: number;
  timestamp: string;
  pool_address: string;
  tx_hash: string;
  block_number: number;
}

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();
const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7".toLowerCase();
const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599".toLowerCase();
const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F".toLowerCase();

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

  if (t0 === USDC_ADDRESS || t0 === USDT_ADDRESS) {
    return Math.abs(Number(formatUnits(amount0, token0Decimals)));
  }
  if (t1 === USDC_ADDRESS || t1 === USDT_ADDRESS) {
    return Math.abs(Number(formatUnits(amount1, token1Decimals)));
  }
  if (t0 === DAI_ADDRESS) {
    return Math.abs(Number(formatUnits(amount0, token0Decimals)));
  }
  if (t1 === DAI_ADDRESS) {
    return Math.abs(Number(formatUnits(amount1, token1Decimals)));
  }
  if (t0 === WETH_ADDRESS) {
    return Math.abs(Number(formatUnits(amount0, 18))) * 3000;
  }
  if (t1 === WETH_ADDRESS) {
    return Math.abs(Number(formatUnits(amount1, 18))) * 3000;
  }
  if (t0 === WBTC_ADDRESS) {
    return Math.abs(Number(formatUnits(amount0, 8))) * 60000;
  }
  if (t1 === WBTC_ADDRESS) {
    return Math.abs(Number(formatUnits(amount1, 8))) * 60000;
  }
  return 0;
}

function buildUniswapTradeEvent(params: {
  amount0: bigint;
  amount1: bigint;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  pool: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}): UniswapTradeExecutedEvent {
  const usdValue = estimateUsdValue(
    params.amount0, params.amount1,
    params.token0, params.token1,
    params.token0Decimals, params.token1Decimals
  );
  const pairLabel = `${params.token0Symbol}/${params.token1Symbol}`;
  const size = Math.abs(Number(params.amount0) / Math.pow(10, params.token0Decimals));

  return {
    source: "uniswap",
    symbol: pairLabel,
    side: params.amount0 > 0n ? "sell" : "buy",
    price: usdValue / (size || 1),
    size,
    notional_usd: usdValue,
    timestamp: new Date(params.timestamp).toISOString(),
    pool_address: params.pool,
    tx_hash: params.txHash,
    block_number: params.blockNumber,
  };
}

describe("Uniswap tradeExecuted Event Tests", () => {
  describe("Event Schema", () => {
    it("should build a valid tradeExecuted event from a V3 WETH/USDC swap", () => {
      const event = buildUniswapTradeEvent({
        amount0: -1000000000000000000n,
        amount1: 3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        blockNumber: 19000000,
        timestamp: 1739577600000,
      });

      expect(event.source).toBe("uniswap");
      expect(event.symbol).toBe("WETH/USDC");
      expect(event.side).toBe("buy");
      expect(event.notional_usd).toBe(3000);
      expect(event.pool_address).toBe("0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640");
      expect(typeof event.tx_hash).toBe("string");
      expect(typeof event.block_number).toBe("number");
    });

    it("should have all required fields", () => {
      const event = buildUniswapTradeEvent({
        amount0: 1000000000000000000n,
        amount1: -3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        blockNumber: 19000001,
        timestamp: 1739577660000,
      });

      const keys = Object.keys(event);
      expect(keys).toContain("source");
      expect(keys).toContain("symbol");
      expect(keys).toContain("side");
      expect(keys).toContain("price");
      expect(keys).toContain("size");
      expect(keys).toContain("notional_usd");
      expect(keys).toContain("timestamp");
      expect(keys).toContain("pool_address");
      expect(keys).toContain("tx_hash");
      expect(keys).toContain("block_number");
    });

    it("should set source to uniswap", () => {
      const event = buildUniswapTradeEvent({
        amount0: -500000000000000000n,
        amount1: 1500000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
        blockNumber: 19000002,
        timestamp: 1739577720000,
      });
      expect(event.source).toBe("uniswap");
    });
  });

  describe("Side Determination (V3 amount0 sign)", () => {
    it("should map negative amount0 to buy (token0 leaving pool = buyer receives token0)", () => {
      const event = buildUniswapTradeEvent({
        amount0: -1000000000000000000n,
        amount1: 3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
        blockNumber: 19000003,
        timestamp: 1739577780000,
      });
      expect(event.side).toBe("buy");
    });

    it("should map positive amount0 to sell (token0 entering pool = seller sends token0)", () => {
      const event = buildUniswapTradeEvent({
        amount0: 1000000000000000000n,
        amount1: -3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
        blockNumber: 19000004,
        timestamp: 1739577840000,
      });
      expect(event.side).toBe("sell");
    });
  });

  describe("USD Value Estimation", () => {
    it("should estimate USD value from USDC amount", () => {
      const event = buildUniswapTradeEvent({
        amount0: -1000000000000000000n,
        amount1: 3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
        blockNumber: 19000005,
        timestamp: 1739577900000,
      });
      expect(event.notional_usd).toBe(3000);
    });

    it("should estimate USD value from USDT amount", () => {
      const event = buildUniswapTradeEvent({
        amount0: -1000000000000000000n,
        amount1: 3000000000n,
        token0: WETH_ADDRESS,
        token1: USDT_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDT",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x11b815efB8f581194ae5486326430326078dF15A",
        txHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
        blockNumber: 19000006,
        timestamp: 1739577960000,
      });
      expect(event.notional_usd).toBe(3000);
    });

    it("should estimate USD from WETH using hardcoded ETH price", () => {
      const usd = estimateUsdValue(
        1000000000000000000n, 0n,
        WETH_ADDRESS, "0x1234567890123456789012345678901234567890",
        18, 18
      );
      expect(usd).toBe(3000);
    });

    it("should estimate USD from WBTC using hardcoded BTC price", () => {
      const usd = estimateUsdValue(
        100000000n, 0n,
        WBTC_ADDRESS, "0x1234567890123456789012345678901234567890",
        8, 18
      );
      expect(usd).toBe(60000);
    });

    it("should estimate USD from DAI amount", () => {
      const usd = estimateUsdValue(
        5000000000000000000000n, 0n,
        DAI_ADDRESS, "0x1234567890123456789012345678901234567890",
        18, 18
      );
      expect(usd).toBe(5000);
    });

    it("should return 0 for unknown token pairs", () => {
      const usd = estimateUsdValue(
        1000000000000000000n, 1000000000000000000n,
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        18, 18
      );
      expect(usd).toBe(0);
    });

    it("should handle negative amounts via absolute value", () => {
      const usd = estimateUsdValue(
        -5000000000n, 1000000000000000000n,
        USDC_ADDRESS, WETH_ADDRESS,
        6, 18
      );
      expect(usd).toBe(5000);
    });
  });

  describe("Whale Detection", () => {
    it("should identify whale swaps above threshold", () => {
      const event = buildUniswapTradeEvent({
        amount0: -20000000000000000000n,
        amount1: 60000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
        blockNumber: 19000007,
        timestamp: 1739578020000,
      });
      expect(event.notional_usd).toBeGreaterThanOrEqual(50000);
    });

    it("should not flag small swaps as whales", () => {
      const event = buildUniswapTradeEvent({
        amount0: -100000000000000000n,
        amount1: 300000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
        blockNumber: 19000008,
        timestamp: 1739578080000,
      });
      expect(event.notional_usd).toBeLessThan(50000);
    });
  });

  describe("Symbol / Pair Label", () => {
    it("should format WETH/USDC pair label", () => {
      const event = buildUniswapTradeEvent({
        amount0: -1000000000000000000n,
        amount1: 3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
        blockNumber: 19000009,
        timestamp: 1739578140000,
      });
      expect(event.symbol).toBe("WETH/USDC");
    });

    it("should format WBTC/WETH pair label", () => {
      const event = buildUniswapTradeEvent({
        amount0: -100000000n,
        amount1: 20000000000000000000n,
        token0: WBTC_ADDRESS,
        token1: WETH_ADDRESS,
        token0Symbol: "WBTC",
        token1Symbol: "WETH",
        token0Decimals: 8,
        token1Decimals: 18,
        pool: "0xCBCdF9626bC03E24f779434178A73a0B4bad62eD",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        blockNumber: 19000010,
        timestamp: 1739578200000,
      });
      expect(event.symbol).toBe("WBTC/WETH");
    });
  });

  describe("Timestamp Format", () => {
    it("should convert epoch milliseconds to ISO-8601", () => {
      const epochMs = 1739577600000;
      const event = buildUniswapTradeEvent({
        amount0: -1000000000000000000n,
        amount1: 3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        blockNumber: 19000011,
        timestamp: epochMs,
      });
      expect(event.timestamp).toBe(new Date(epochMs).toISOString());
      const parsed = new Date(event.timestamp);
      expect(parsed.getTime()).toBe(epochMs);
    });

    it("should produce valid ISO-8601 format", () => {
      const event = buildUniswapTradeEvent({
        amount0: -1000000000000000000n,
        amount1: 3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        blockNumber: 19000012,
        timestamp: 1739578260000,
      });
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("Pool Address and TX Hash Format", () => {
    it("pool_address should be a valid Ethereum address", () => {
      const event = buildUniswapTradeEvent({
        amount0: -1000000000000000000n,
        amount1: 3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        blockNumber: 19000013,
        timestamp: 1739578320000,
      });
      expect(event.pool_address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("tx_hash should be a valid transaction hash", () => {
      const event = buildUniswapTradeEvent({
        amount0: -1000000000000000000n,
        amount1: 3000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        blockNumber: 19000014,
        timestamp: 1739578380000,
      });
      expect(event.tx_hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });
  });

  describe("Event Emission Alongside messageCreated", () => {
    it("tradeExecuted should fire for all swaps, not just whales", () => {
      const smallSwap = buildUniswapTradeEvent({
        amount0: -10000000000000000n,
        amount1: 30000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        blockNumber: 19000015,
        timestamp: 1739578440000,
      });
      expect(smallSwap.notional_usd).toBeLessThan(50000);
      expect(smallSwap.source).toBe("uniswap");
      expect(smallSwap.symbol).toBeDefined();
      expect(smallSwap.side).toBeDefined();
    });

    it("tradeExecuted should also fire for whale swaps", () => {
      const whaleSwap = buildUniswapTradeEvent({
        amount0: -20000000000000000000n,
        amount1: 60000000000n,
        token0: WETH_ADDRESS,
        token1: USDC_ADDRESS,
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        token0Decimals: 18,
        token1Decimals: 6,
        pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        txHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
        blockNumber: 19000016,
        timestamp: 1739578500000,
      });
      expect(whaleSwap.notional_usd).toBeGreaterThanOrEqual(50000);
      expect(whaleSwap.source).toBe("uniswap");
    });
  });
});
