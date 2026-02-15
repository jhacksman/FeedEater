import { describe, it, expect } from "vitest";
import { Interface, formatUnits } from "ethers";

const QUICKSWAP_V3_FACTORY = "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28";

const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V3_POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

const V3_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];
const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];

const v3SwapIface = new Interface(V3_SWAP_ABI);
const v3FactoryIface = new Interface(V3_FACTORY_ABI);

const WETH_USDC_POOL = "0x45dDa9cb7c25131DF268515131f647d726f50608";
const WMATIC_USDC_POOL = "0xAE81FAc689A1b4b1e06e7ef4a2ab4CD8aC0A087D";

const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359".toLowerCase();
const POLYGON_USDCe = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase();
const POLYGON_USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase();
const POLYGON_WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619".toLowerCase();
const POLYGON_WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase();
const POLYGON_WBTC = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6".toLowerCase();

describe("V3 Swap Event Signature Tests", () => {
  it("should have correct V3 Swap topic hash", () => {
    const computedTopic = v3SwapIface.getEvent("Swap")?.topicHash;
    expect(computedTopic?.toLowerCase()).toBe(V3_SWAP_TOPIC.toLowerCase());
  });

  it("should parse V3 Swap event data correctly", () => {
    const mockData = "0x" +
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
    const mockData = "0x" +
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
});

describe("V3 PoolCreated Event Signature Tests", () => {
  it("should have correct V3 PoolCreated topic hash", () => {
    const computedTopic = v3FactoryIface.getEvent("PoolCreated")?.topicHash;
    expect(computedTopic?.toLowerCase()).toBe(V3_POOL_CREATED_TOPIC.toLowerCase());
  });

  it("should parse V3 PoolCreated event data correctly", () => {
    const poolAddress = "0x45dDa9cb7c25131DF268515131f647d726f50608";
    const mockData = "0x" +
      "000000000000000000000000000000000000000000000000000000000000000a" +
      "000000000000000000000000" + poolAddress.slice(2).toLowerCase();

    const mockTopics = [
      V3_POOL_CREATED_TOPIC,
      "0x0000000000000000000000007ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
      "0x0000000000000000000000003c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      "0x00000000000000000000000000000000000000000000000000000000000001f4",
    ];

    const parsed = v3FactoryIface.parseLog({ topics: mockTopics, data: mockData });
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("PoolCreated");

    const token0 = parsed?.args[0] as string;
    const token1 = parsed?.args[1] as string;
    const fee = Number(parsed?.args[2]);
    const pool = parsed?.args[4] as string;

    expect(token0.toLowerCase()).toBe(POLYGON_WETH);
    expect(token1.toLowerCase()).toBe(POLYGON_USDC);
    expect(fee).toBe(500);
    expect(pool.toLowerCase()).toBe(poolAddress.toLowerCase());
  });
});

describe("USD Value Estimation Tests", () => {
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
      const ethAmount = Math.abs(Number(formatUnits(amount0, 18)));
      return ethAmount * 3000;
    }
    if (t1 === POLYGON_WETH) {
      const ethAmount = Math.abs(Number(formatUnits(amount1, 18)));
      return ethAmount * 3000;
    }

    if (t0 === POLYGON_WMATIC) {
      const maticAmount = Math.abs(Number(formatUnits(amount0, 18)));
      return maticAmount * 0.5;
    }
    if (t1 === POLYGON_WMATIC) {
      const maticAmount = Math.abs(Number(formatUnits(amount1, 18)));
      return maticAmount * 0.5;
    }

    if (t0 === POLYGON_WBTC) {
      const btcAmount = Math.abs(Number(formatUnits(amount0, 8)));
      return btcAmount * 60000;
    }
    if (t1 === POLYGON_WBTC) {
      const btcAmount = Math.abs(Number(formatUnits(amount1, 8)));
      return btcAmount * 60000;
    }

    return 0;
  }

  it("should estimate USD value for USDC swaps", () => {
    const amount0 = 1000000n;
    const amount1 = 500000000000000000n;
    const usdValue = estimateUsdValue(amount0, amount1, POLYGON_USDC, POLYGON_WETH, 6, 18);
    expect(usdValue).toBe(1);
  });

  it("should estimate USD value for bridged USDC (USDCe) swaps", () => {
    const amount0 = 5000000n;
    const amount1 = 1000000000000000000n;
    const usdValue = estimateUsdValue(amount0, amount1, POLYGON_USDCe, POLYGON_WETH, 6, 18);
    expect(usdValue).toBe(5);
  });

  it("should estimate USD value for USDT swaps", () => {
    const amount0 = 10000000000n;
    const amount1 = 3333333333333333333n;
    const usdValue = estimateUsdValue(amount0, amount1, POLYGON_USDT, POLYGON_WETH, 6, 18);
    expect(usdValue).toBe(10000);
  });

  it("should estimate USD value for WETH swaps using ETH price", () => {
    const amount0 = 1000000000000000000n;
    const amount1 = 3000000000n;
    const usdValue = estimateUsdValue(amount0, amount1, POLYGON_WETH, POLYGON_USDC, 18, 6);
    expect(usdValue).toBe(3000);
  });

  it("should estimate USD value for WMATIC swaps", () => {
    const amount0 = 2000000000000000000n;
    const amount1 = 1000000n;
    const usdValue = estimateUsdValue(amount0, amount1, POLYGON_WMATIC, POLYGON_USDC, 18, 6);
    expect(usdValue).toBe(1);
  });

  it("should estimate USD value for WBTC swaps using BTC price", () => {
    const amount0 = 100000000n;
    const amount1 = 20000000000000000000n;
    const usdValue = estimateUsdValue(amount0, amount1, POLYGON_WBTC, POLYGON_WETH, 8, 18);
    expect(usdValue).toBe(60000);
  });

  it("should return 0 for unknown token pairs", () => {
    const unknownToken = "0x1234567890123456789012345678901234567890";
    const amount0 = 1000000000000000000n;
    const amount1 = 1000000000000000000n;
    const usdValue = estimateUsdValue(amount0, amount1, unknownToken, unknownToken, 18, 18);
    expect(usdValue).toBe(0);
  });

  it("should handle negative amounts correctly", () => {
    const amount0 = -1000000n;
    const amount1 = 500000000000000000n;
    const usdValue = estimateUsdValue(amount0, amount1, POLYGON_USDC, POLYGON_WETH, 6, 18);
    expect(usdValue).toBe(1);
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
  it("should normalize Polygon addresses to lowercase", () => {
    expect(QUICKSWAP_V3_FACTORY.toLowerCase()).toBe("0x411b0facc3489691f28ad58c47006af5e3ab3a28");
  });

  it("should normalize pool addresses to lowercase", () => {
    expect(WETH_USDC_POOL.toLowerCase()).toBe("0x45dda9cb7c25131df268515131f647d726f50608");
    expect(WMATIC_USDC_POOL.toLowerCase()).toBe("0xae81fac689a1b4b1e06e7ef4a2ab4cd8ac0a087d");
  });

  it("should normalize token addresses to lowercase", () => {
    expect(POLYGON_USDC).toBe("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359");
    expect(POLYGON_WETH).toBe("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619");
    expect(POLYGON_WMATIC).toBe("0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270");
  });
});

describe("Factory Address Constants", () => {
  it("should have correct QuickSwap V3 factory address", () => {
    expect(QUICKSWAP_V3_FACTORY).toBe("0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28");
  });

  it("should validate factory address format", () => {
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;
    expect(addressRegex.test(QUICKSWAP_V3_FACTORY)).toBe(true);
  });
});

describe("Pool Address Constants", () => {
  it("should have correct WETH/USDC pool address", () => {
    expect(WETH_USDC_POOL).toBe("0x45dDa9cb7c25131DF268515131f647d726f50608");
  });

  it("should have correct WMATIC/USDC pool address", () => {
    expect(WMATIC_USDC_POOL).toBe("0xAE81FAc689A1b4b1e06e7ef4a2ab4CD8aC0A087D");
  });

  it("should validate pool address format", () => {
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;
    expect(addressRegex.test(WETH_USDC_POOL)).toBe(true);
    expect(addressRegex.test(WMATIC_USDC_POOL)).toBe(true);
  });
});

describe("Message Format Tests", () => {
  it("should format swap message correctly", () => {
    const dex = "quickswap_v3";
    const pairLabel = "WETH/USDC";
    const pool = "0x45dDa9cb7c25131DF268515131f647d726f50608";
    const usdValue = 50000.5;
    const txHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    const message = `QuickSwap V3 Swap ${pairLabel} pool=${pool.slice(0, 10)}... usd=$${usdValue.toFixed(2)} tx=${txHash.slice(0, 10)}...`;

    expect(message).toContain("QuickSwap V3");
    expect(message).toContain("WETH/USDC");
    expect(message).toContain("0x45dDa9cb");
    expect(message).toContain("$50000.50");
    expect(message).toContain("0x12345678");
  });

  it("should include WHALE flag for whale swaps", () => {
    const usdValue = 100000;
    const isWhale = true;
    const message = `QuickSwap V3 Swap WETH/USDC pool=0x45dDa9cb... usd=$${usdValue.toFixed(2)}${isWhale ? " [WHALE]" : ""} tx=0x12345678...`;
    expect(message).toContain("[WHALE]");
  });

  it("should not include WHALE flag for small swaps", () => {
    const usdValue = 100;
    const isWhale = false;
    const message = `QuickSwap V3 Swap WETH/USDC pool=0x45dDa9cb... usd=$${usdValue.toFixed(2)}${isWhale ? " [WHALE]" : ""} tx=0x12345678...`;
    expect(message).not.toContain("[WHALE]");
  });
});

describe("BigInt Handling Tests", () => {
  it("should handle large swap amounts", () => {
    const largeAmount = 1000000000000000000000000n;
    expect(largeAmount.toString()).toBe("1000000000000000000000000");
  });

  it("should handle negative V3 amounts", () => {
    const negativeAmount = -1000000000000000000n;
    expect(negativeAmount < 0n).toBe(true);
    expect((-negativeAmount).toString()).toBe("1000000000000000000");
  });

  it("should convert amounts to string for DB storage", () => {
    const amount0 = 1234567890123456789n;
    const amount1 = -9876543210987654321n;
    expect(amount0.toString()).toBe("1234567890123456789");
    expect(amount1.toString()).toBe("-9876543210987654321");
  });
});

describe("Settings Validation Tests", () => {
  it("should validate RPC URL format", () => {
    const validWssUrl = "wss://polygon-mainnet.infura.io/ws/v3/YOUR-PROJECT-ID";
    expect(validWssUrl.startsWith("wss://")).toBe(true);
  });

  it("should validate whale threshold is positive", () => {
    const threshold = 50000;
    expect(threshold > 0).toBe(true);
  });

  it("should validate pool addresses are valid Ethereum addresses", () => {
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;
    expect(addressRegex.test(WETH_USDC_POOL)).toBe(true);
    expect(addressRegex.test(WMATIC_USDC_POOL)).toBe(true);
    expect(addressRegex.test(QUICKSWAP_V3_FACTORY)).toBe(true);
  });

  it("should reject invalid Ethereum addresses", () => {
    const invalidAddresses = [
      "0x123",
      "45dDa9cb7c25131DF268515131f647d726f50608",
      "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    ];
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;

    for (const addr of invalidAddresses) {
      expect(addressRegex.test(addr)).toBe(false);
    }
  });

  it("should parse JSON pool array setting", () => {
    const setting = "[\"0x45dDa9cb7c25131DF268515131f647d726f50608\",\"0xAE81FAc689A1b4b1e06e7ef4a2ab4CD8aC0A087D\"]";
    const pools: string[] = JSON.parse(setting);
    expect(pools).toHaveLength(2);
    expect(pools[0]).toBe(WETH_USDC_POOL);
    expect(pools[1]).toBe(WMATIC_USDC_POOL);
  });
});

describe("NATS Subject Tests", () => {
  it("should format tradeExecuted subject correctly", () => {
    const module = "polygon-dex";
    const event = "tradeExecuted";
    const subject = `feedeater.${module}.${event}`;
    expect(subject).toBe("feedeater.polygon-dex.tradeExecuted");
  });

  it("should format log subject correctly", () => {
    const subject = "feedeater.polygon-dex.log";
    expect(subject).toBe("feedeater.polygon-dex.log");
  });
});

describe("Polygon Token Constants Tests", () => {
  it("should have correct native USDC address", () => {
    expect(POLYGON_USDC).toBe("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359");
  });

  it("should have correct bridged USDCe address", () => {
    expect(POLYGON_USDCe).toBe("0x2791bca1f2de4661ed88a30c99a7a9449aa84174");
  });

  it("should have correct USDT address", () => {
    expect(POLYGON_USDT).toBe("0xc2132d05d31c914a87c6611c10748aeb04b58e8f");
  });

  it("should have correct WETH address", () => {
    expect(POLYGON_WETH).toBe("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619");
  });

  it("should have correct WMATIC address", () => {
    expect(POLYGON_WMATIC).toBe("0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270");
  });

  it("should have correct WBTC address", () => {
    expect(POLYGON_WBTC).toBe("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6");
  });

  it("should all be lowercase", () => {
    const tokens = [POLYGON_USDC, POLYGON_USDCe, POLYGON_USDT, POLYGON_WETH, POLYGON_WMATIC, POLYGON_WBTC];
    for (const token of tokens) {
      expect(token).toBe(token.toLowerCase());
    }
  });
});

describe("NATS Subject Tests", () => {
  it("should format tradeExecuted subject correctly", () => {
    const module = "polygon-dex";
    const event = "tradeExecuted";
    const subject = `feedeater.${module}.${event}`;
    expect(subject).toBe("feedeater.polygon-dex.tradeExecuted");
  });

  it("should format messageCreated subject correctly", () => {
    const module = "polygon-dex";
    const event = "messageCreated";
    const subject = `feedeater.${module}.${event}`;
    expect(subject).toBe("feedeater.polygon-dex.messageCreated");
  });
});

describe("TradeExecuted Event Schema Tests", () => {
  it("should create valid tradeExecuted event structure", () => {
    const tradeEvent = {
      source: "polygon-dex",
      symbol: "WETH/USDC",
      side: "buy" as "buy" | "sell",
      price: 3000.50,
      size: 1.5,
      notional_usd: 4500.75,
      timestamp: "2026-02-14T23:00:00.000Z",
      pool_address: "0x45dDa9cb7c25131DF268515131f647d726f50608",
      tx_hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
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

  it("should determine side based on amount0 sign", () => {
    const amount0Positive = 1000000000000000000n;
    const amount0Negative = -1000000000000000000n;

    const sideForPositive = amount0Positive > 0n ? "sell" : "buy";
    const sideForNegative = amount0Negative > 0n ? "sell" : "buy";

    expect(sideForPositive).toBe("sell");
    expect(sideForNegative).toBe("buy");
  });

  it("should calculate price from usdValue and size", () => {
    const usdValue = 3000;
    const amount0 = 1000000000000000000n;
    const decimals = 18;
    const size = Math.abs(Number(amount0) / Math.pow(10, decimals));
    const price = usdValue / (size || 1);

    expect(size).toBe(1);
    expect(price).toBe(3000);
  });

  it("should format timestamp as ISO-8601", () => {
    const timestamp = 1707955200000;
    const isoTimestamp = new Date(timestamp).toISOString();

    expect(isoTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
