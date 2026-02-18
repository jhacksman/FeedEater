import { describe, it, expect } from "vitest";
import { Interface, formatUnits } from "ethers";

const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const WETH_USDC_005_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
const WETH_USDC_030_POOL = "0x6c561B446416E1A00E8E93E221854d6eA4171372";

const BASE_WETH = "0x4200000000000000000000000000000000000006".toLowerCase();
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();

const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V3_POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

const V3_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];
const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];

const v3SwapIface = new Interface(V3_SWAP_ABI);
const v3FactoryIface = new Interface(V3_FACTORY_ABI);

describe("V3 Swap Event Signature Tests", () => {
  it("should have correct V3 Swap topic hash", () => {
    const computedTopic = v3SwapIface.getEvent("Swap")?.topicHash;
    expect(computedTopic?.toLowerCase()).toBe(V3_SWAP_TOPIC.toLowerCase());
  });

  it("should parse V3 Swap event data correctly", () => {
    const mockData =
      "0x" +
      "fffffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c00" +
      "00000000000000000000000000000000000000000000000000000000000f4240" +
      "0000000000000000000000000000000000000001234567890abcdef012345678" +
      "00000000000000000000000000000000000000000000000000000000000186a0" +
      "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff12345";

    const mockTopics = [
      V3_SWAP_TOPIC,
      "0x000000000000000000000000" + "1234567890123456789012345678901234567890",
      "0x000000000000000000000000" + "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    ];

    const parsed = v3SwapIface.parseLog({ topics: mockTopics, data: mockData });
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("Swap");

    const amount0 = BigInt(parsed?.args[2]);
    const amount1 = BigInt(parsed?.args[3]);
    expect(typeof amount0).toBe("bigint");
    expect(typeof amount1).toBe("bigint");
  });

  it("should extract sender and recipient from indexed params", () => {
    const mockData =
      "0x" +
      "fffffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c00" +
      "00000000000000000000000000000000000000000000000000000000000f4240" +
      "0000000000000000000000000000000000000001234567890abcdef012345678" +
      "00000000000000000000000000000000000000000000000000000000000186a0" +
      "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff12345";

    const senderAddr = "1234567890123456789012345678901234567890";
    const recipientAddr = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

    const mockTopics = [
      V3_SWAP_TOPIC,
      "0x000000000000000000000000" + senderAddr,
      "0x000000000000000000000000" + recipientAddr,
    ];

    const parsed = v3SwapIface.parseLog({ topics: mockTopics, data: mockData });
    const sender = (parsed?.args[0] as string).toLowerCase();
    const recipient = (parsed?.args[1] as string).toLowerCase();

    expect(sender).toBe("0x" + senderAddr);
    expect(recipient).toBe("0x" + recipientAddr);
  });

  it("should extract sqrtPriceX96 from swap event", () => {
    const sqrtPriceX96Hex = "0000000000000000000000000000000000000001234567890abcdef012345678";
    const mockData =
      "0x" +
      "fffffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c00" +
      "00000000000000000000000000000000000000000000000000000000000f4240" +
      sqrtPriceX96Hex +
      "00000000000000000000000000000000000000000000000000000000000186a0" +
      "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff12345";

    const mockTopics = [
      V3_SWAP_TOPIC,
      "0x000000000000000000000000" + "1234567890123456789012345678901234567890",
      "0x000000000000000000000000" + "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    ];

    const parsed = v3SwapIface.parseLog({ topics: mockTopics, data: mockData });
    const sqrtPriceX96 = BigInt(parsed?.args[4]);
    expect(typeof sqrtPriceX96).toBe("bigint");
    expect(sqrtPriceX96).toBeGreaterThan(0n);
  });
});

describe("V3 PoolCreated Event Signature Tests", () => {
  it("should have correct V3 PoolCreated topic hash", () => {
    const computedTopic = v3FactoryIface.getEvent("PoolCreated")?.topicHash;
    expect(computedTopic?.toLowerCase()).toBe(V3_POOL_CREATED_TOPIC.toLowerCase());
  });

  it("should parse V3 PoolCreated event data correctly", () => {
    const poolAddress = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
    const mockData =
      "0x" +
      "000000000000000000000000000000000000000000000000000000000000000a" +
      "000000000000000000000000" +
      poolAddress.slice(2).toLowerCase();

    const mockTopics = [
      V3_POOL_CREATED_TOPIC,
      "0x0000000000000000000000004200000000000000000000000000000000000006",
      "0x000000000000000000000000833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0x00000000000000000000000000000000000000000000000000000000000001f4",
    ];

    const parsed = v3FactoryIface.parseLog({ topics: mockTopics, data: mockData });
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("PoolCreated");

    const token0 = parsed?.args[0] as string;
    const token1 = parsed?.args[1] as string;
    const fee = Number(parsed?.args[2]);
    const pool = parsed?.args[4] as string;

    expect(token0.toLowerCase()).toBe(BASE_WETH);
    expect(token1.toLowerCase()).toBe(BASE_USDC);
    expect(fee).toBe(500);
    expect(pool.toLowerCase()).toBe(poolAddress.toLowerCase());
  });
});

describe("sqrtPriceX96 Price Computation Tests", () => {
  function computePriceFromSqrtPriceX96(
    sqrtPriceX96: bigint,
    token0Decimals: number,
    token1Decimals: number
  ): number {
    const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
    const price = sqrtPrice * sqrtPrice;
    const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
    return price * decimalAdjustment;
  }

  it("should compute ETH/USDC price from sqrtPriceX96", () => {
    const sqrtPriceX96 = BigInt("4339505179874779222759694");
    const price = computePriceFromSqrtPriceX96(sqrtPriceX96, 18, 6);
    expect(price).toBeGreaterThan(1000);
    expect(price).toBeLessThan(10000);
  });

  it("should handle very small sqrtPriceX96 values", () => {
    const sqrtPriceX96 = BigInt("79228162514264337593543950336");
    const price = computePriceFromSqrtPriceX96(sqrtPriceX96, 18, 18);
    expect(price).toBeCloseTo(1, 5);
  });

  it("should handle token decimal differences correctly", () => {
    const sqrtPriceX96 = BigInt("79228162514264337593543950336");
    const price18_6 = computePriceFromSqrtPriceX96(sqrtPriceX96, 18, 6);
    const price6_18 = computePriceFromSqrtPriceX96(sqrtPriceX96, 6, 18);
    expect(price18_6).toBeGreaterThan(price6_18);
  });
});

describe("USD Value Estimation Tests", () => {
  function estimateUsdValue(pool: string, amount0: bigint, amount1: bigint): number {
    const p = pool.toLowerCase();
    if (
      p === WETH_USDC_005_POOL.toLowerCase() ||
      p === WETH_USDC_030_POOL.toLowerCase()
    ) {
      return Math.abs(Number(formatUnits(amount1, 6)));
    }
    const a0Abs = Math.abs(Number(formatUnits(amount0, 18)));
    const a1Abs = Math.abs(Number(formatUnits(amount1, 6)));
    return Math.max(a0Abs * 3000, a1Abs);
  }

  it("should estimate USD value for WETH/USDC 0.05% pool", () => {
    const amount0 = 1000000000000000000n;
    const amount1 = -3000000000n;
    const usdValue = estimateUsdValue(WETH_USDC_005_POOL, amount0, amount1);
    expect(usdValue).toBe(3000);
  });

  it("should estimate USD value for WETH/USDC 0.3% pool", () => {
    const amount0 = -500000000000000000n;
    const amount1 = 1500000000n;
    const usdValue = estimateUsdValue(WETH_USDC_030_POOL, amount0, amount1);
    expect(usdValue).toBe(1500);
  });

  it("should handle negative amounts using Math.abs", () => {
    const amount0 = -1000000000000000000n;
    const amount1 = 3000000000n;
    const usdValue = estimateUsdValue(WETH_USDC_005_POOL, amount0, amount1);
    expect(usdValue).toBe(3000);
  });

  it("should fallback to ETH price estimation for unknown pools", () => {
    const unknownPool = "0x1234567890123456789012345678901234567890";
    const amount0 = 1000000000000000000n;
    const amount1 = 3000000000n;
    const usdValue = estimateUsdValue(unknownPool, amount0, amount1);
    expect(usdValue).toBe(3000);
  });
});

describe("Whale Detection Tests", () => {
  function isWhale(usdValue: number, threshold: number): boolean {
    return usdValue >= threshold;
  }

  it("should detect whale trades above threshold", () => {
    expect(isWhale(100000, 50000)).toBe(true);
    expect(isWhale(50000, 50000)).toBe(true);
  });

  it("should not flag trades below threshold", () => {
    expect(isWhale(49999, 50000)).toBe(false);
    expect(isWhale(1000, 50000)).toBe(false);
  });

  it("should handle zero value trades", () => {
    expect(isWhale(0, 50000)).toBe(false);
  });

  it("should work with different thresholds", () => {
    expect(isWhale(10000, 10000)).toBe(true);
    expect(isWhale(9999, 10000)).toBe(false);
    expect(isWhale(1000000, 500000)).toBe(true);
  });
});

describe("Address Normalization Tests", () => {
  it("should normalize Base addresses to lowercase", () => {
    expect(UNISWAP_V3_FACTORY.toLowerCase()).toBe("0x33128a8fc17869897dce68ed026d694621f6fdfd");
  });

  it("should normalize pool addresses to lowercase", () => {
    expect(WETH_USDC_005_POOL.toLowerCase()).toBe("0xd0b53d9277642d899df5c87a3966a349a798f224");
    expect(WETH_USDC_030_POOL.toLowerCase()).toBe("0x6c561b446416e1a00e8e93e221854d6ea4171372");
  });

  it("should normalize token addresses to lowercase", () => {
    expect(BASE_WETH).toBe("0x4200000000000000000000000000000000000006");
    expect(BASE_USDC).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });
});

describe("Factory Address Constants", () => {
  it("should have correct Base Uniswap V3 factory address", () => {
    expect(UNISWAP_V3_FACTORY).toBe("0x33128a8fC17869897dcE68Ed026d694621f6FDfD");
  });

  it("should validate factory address format", () => {
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;
    expect(addressRegex.test(UNISWAP_V3_FACTORY)).toBe(true);
  });
});

describe("Pool Address Constants", () => {
  it("should have correct WETH/USDC 0.05% pool address", () => {
    expect(WETH_USDC_005_POOL).toBe("0xd0b53D9277642d899DF5C87A3966A349A798F224");
  });

  it("should have correct WETH/USDC 0.3% pool address", () => {
    expect(WETH_USDC_030_POOL).toBe("0x6c561B446416E1A00E8E93E221854d6eA4171372");
  });

  it("should validate pool address format", () => {
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;
    expect(addressRegex.test(WETH_USDC_005_POOL)).toBe(true);
    expect(addressRegex.test(WETH_USDC_030_POOL)).toBe(true);
  });
});

describe("Settings Parser Tests", () => {
  it("should parse default settings correctly", async () => {
    const { parseUniswapBaseSettingsFromInternal } = await import("../ingest.js");
    const settings = parseUniswapBaseSettingsFromInternal({});
    expect(settings.enabled).toBe(false);
    expect(settings.whaleThreshold).toBe(50000);
    expect(settings.rpcUrl).toBe("ws://192.168.0.134:8646");
  });

  it("should parse enabled + custom thresholds", async () => {
    const { parseUniswapBaseSettingsFromInternal } = await import("../ingest.js");
    const settings = parseUniswapBaseSettingsFromInternal({
      enabled: "true",
      whaleThreshold: "100000",
    });
    expect(settings.enabled).toBe(true);
    expect(settings.whaleThreshold).toBe(100000);
  });

  it("should parse watched pools as JSON string", async () => {
    const { parseUniswapBaseSettingsFromInternal } = await import("../ingest.js");
    const settings = parseUniswapBaseSettingsFromInternal({
      watchedUniswapPools: '["0xabc","0xdef"]',
    });
    expect(settings.watchedUniswapPools).toBe('["0xabc","0xdef"]');
  });

  it("should throw on invalid whaleThreshold", async () => {
    const { parseUniswapBaseSettingsFromInternal } = await import("../ingest.js");
    expect(() => parseUniswapBaseSettingsFromInternal({ whaleThreshold: "0" })).toThrow();
    expect(() => parseUniswapBaseSettingsFromInternal({ whaleThreshold: "-1" })).toThrow();
  });

  it("should use local Base node URL by default, not Infura", async () => {
    const { parseUniswapBaseSettingsFromInternal } = await import("../ingest.js");
    const settings = parseUniswapBaseSettingsFromInternal({});
    expect(settings.rpcUrl).not.toContain("infura");
    expect(settings.rpcUrl).toBe("ws://192.168.0.134:8646");
  });
});

describe("NATS Subject Tests", () => {
  it("should format tradeExecuted subject correctly", () => {
    const module = "uniswap-base";
    const event = "tradeExecuted";
    const subject = `feedeater.${module}.${event}`;
    expect(subject).toBe("feedeater.uniswap-base.tradeExecuted");
  });

  it("should format messageCreated subject correctly", () => {
    const module = "uniswap-base";
    const event = "messageCreated";
    const subject = `feedeater.${module}.${event}`;
    expect(subject).toBe("feedeater.uniswap-base.messageCreated");
  });
});

describe("TradeExecuted Event Schema Tests", () => {
  it("should create valid tradeExecuted event structure for Uniswap V3 swap", () => {
    const tradeEvent = {
      source: "uniswap-base",
      symbol: "WETH/USDC",
      side: "buy" as "buy" | "sell",
      price: 3000.5,
      size: 1.5,
      notional_usd: 4500.75,
      timestamp: "2026-02-15T23:00:00.000Z",
      pool_address: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
      tx_hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      block_number: 10000000,
    };

    expect(tradeEvent.source).toBe("uniswap-base");
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

  it("should determine side based on amount0 sign", () => {
    const positiveAmount0 = 1000000000000000000n;
    const negativeAmount0 = -1000000000000000000n;

    const sideForPositive = positiveAmount0 > 0n ? "sell" : "buy";
    const sideForNegative = negativeAmount0 > 0n ? "sell" : "buy";

    expect(sideForPositive).toBe("sell");
    expect(sideForNegative).toBe("buy");
  });

  it("should format timestamp as ISO-8601", () => {
    const timestamp = 1707955200000;
    const isoTimestamp = new Date(timestamp).toISOString();
    expect(isoTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("Message Format Tests", () => {
  it("should format swap message correctly", () => {
    const pairLabel = "WETH/USDC";
    const pool = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
    const usdValue = 50000.5;
    const txHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    const message = `Uniswap V3 Base Swap ${pairLabel} pool=${pool.slice(0, 10)}... usd=$${usdValue.toFixed(2)} tx=${txHash}`;

    expect(message).toContain("Uniswap V3 Base");
    expect(message).toContain("WETH/USDC");
    expect(message).toContain("0xd0b53D92");
    expect(message).toContain("$50000.50");
  });
});

describe("BigInt Handling Tests", () => {
  it("should handle large V3 swap amounts", () => {
    const amount0 = BigInt("100000000000000000000");
    const amount1 = BigInt("-300000000000");

    const a0Formatted = Number(formatUnits(amount0, 18));
    const a1Formatted = Number(formatUnits(amount1, 6));

    expect(a0Formatted).toBe(100);
    expect(a1Formatted).toBe(-300000);
  });

  it("should handle zero amounts", () => {
    const zero = BigInt("0");
    expect(Number(formatUnits(zero, 18))).toBe(0);
    expect(Number(formatUnits(zero, 6))).toBe(0);
  });

  it("should handle max uint160 sqrtPriceX96", () => {
    const maxUint160 = (1n << 160n) - 1n;
    expect(maxUint160).toBeGreaterThan(0n);
  });
});
