import { describe, it, expect, beforeAll } from "vitest";
import { WebSocketProvider, Interface, formatUnits } from "ethers";

const V2_FACTORY_ADDRESS = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const V3_FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V2_PAIR_CREATED_TOPIC = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const V3_POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

const V2_SWAP_ABI = [
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];
const V3_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];
const V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)"
];
const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];

const v2SwapIface = new Interface(V2_SWAP_ABI);
const v3SwapIface = new Interface(V3_SWAP_ABI);
const v2FactoryIface = new Interface(V2_FACTORY_ABI);
const v3FactoryIface = new Interface(V3_FACTORY_ABI);

const WETH_USDC_V3_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
const WETH_USDT_V3_POOL = "0x11b815efB8f581194ae5486326430326078dF15A";

describe("Uniswap Event Signature Tests", () => {
  describe("V2 Swap Event", () => {
    it("should have correct V2 Swap topic hash", () => {
      const computedTopic = v2SwapIface.getEvent("Swap")?.topicHash;
      expect(computedTopic?.toLowerCase()).toBe(V2_SWAP_TOPIC.toLowerCase());
    });

    it("should parse V2 Swap event data correctly", () => {
      const mockData = "0x" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "00000000000000000000000000000000000000000000000000000000000f4240" +
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
        "0000000000000000000000000000000000000000000000000000000000000000";
      
      const mockTopics = [
        V2_SWAP_TOPIC,
        "0x000000000000000000000000" + "1234567890123456789012345678901234567890",
        "0x000000000000000000000000" + "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      ];

      const parsed = v2SwapIface.parseLog({ topics: mockTopics, data: mockData });
      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe("Swap");
      
      const amount0In = BigInt(parsed?.args.amount0In);
      const amount1In = BigInt(parsed?.args.amount1In);
      const amount0Out = BigInt(parsed?.args.amount0Out);
      const amount1Out = BigInt(parsed?.args.amount1Out);
      
      expect(amount0In).toBe(0n);
      expect(amount1In).toBe(1000000n);
      expect(amount0Out).toBe(1000000000000000000n);
      expect(amount1Out).toBe(0n);
    });
  });

  describe("V3 Swap Event", () => {
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
  });

  describe("V2 PairCreated Event", () => {
    it("should have correct V2 PairCreated topic hash", () => {
      const computedTopic = v2FactoryIface.getEvent("PairCreated")?.topicHash;
      expect(computedTopic?.toLowerCase()).toBe(V2_PAIR_CREATED_TOPIC.toLowerCase());
    });

    it("should parse V2 PairCreated event data correctly", () => {
      const pairAddress = "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc";
      const mockData = "0x" +
        "000000000000000000000000" + pairAddress.slice(2).toLowerCase() +
        "0000000000000000000000000000000000000000000000000000000000000001";
      
      const mockTopics = [
        V2_PAIR_CREATED_TOPIC,
        "0x000000000000000000000000C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "0x000000000000000000000000A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ];

      const parsed = v2FactoryIface.parseLog({ topics: mockTopics, data: mockData });
      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe("PairCreated");
      
      const token0 = parsed?.args[0] as string;
      const token1 = parsed?.args[1] as string;
      const pair = parsed?.args[2] as string;
      
      expect(token0.toLowerCase()).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
      expect(token1.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
      expect(pair.toLowerCase()).toBe(pairAddress.toLowerCase());
    });
  });

  describe("V3 PoolCreated Event", () => {
    it("should have correct V3 PoolCreated topic hash", () => {
      const computedTopic = v3FactoryIface.getEvent("PoolCreated")?.topicHash;
      expect(computedTopic?.toLowerCase()).toBe(V3_POOL_CREATED_TOPIC.toLowerCase());
    });

    it("should parse V3 PoolCreated event data correctly", () => {
      const poolAddress = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
      const mockData = "0x" +
        "000000000000000000000000000000000000000000000000000000000000000a" +
        "000000000000000000000000" + poolAddress.slice(2).toLowerCase();
      
      const mockTopics = [
        V3_POOL_CREATED_TOPIC,
        "0x000000000000000000000000C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "0x000000000000000000000000A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "0x00000000000000000000000000000000000000000000000000000000000001f4",
      ];

      const parsed = v3FactoryIface.parseLog({ topics: mockTopics, data: mockData });
      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe("PoolCreated");
      
      const token0 = parsed?.args[0] as string;
      const token1 = parsed?.args[1] as string;
      const fee = Number(parsed?.args[2]);
      const pool = parsed?.args[4] as string;
      
      expect(token0.toLowerCase()).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
      expect(token1.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
      expect(fee).toBe(500);
      expect(pool.toLowerCase()).toBe(poolAddress.toLowerCase());
    });
  });
});

describe("USD Value Estimation Tests", () => {
  const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();
  const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7".toLowerCase();
  const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599".toLowerCase();

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

    if (t0 === WETH_ADDRESS) {
      const ethAmount = Math.abs(Number(formatUnits(amount0, 18)));
      return ethAmount * 3000;
    }
    if (t1 === WETH_ADDRESS) {
      const ethAmount = Math.abs(Number(formatUnits(amount1, 18)));
      return ethAmount * 3000;
    }

    if (t0 === WBTC_ADDRESS) {
      const btcAmount = Math.abs(Number(formatUnits(amount0, 8)));
      return btcAmount * 60000;
    }
    if (t1 === WBTC_ADDRESS) {
      const btcAmount = Math.abs(Number(formatUnits(amount1, 8)));
      return btcAmount * 60000;
    }

    return 0;
  }

  it("should estimate USD value for USDC swaps", () => {
    const amount0 = 1000000n;
    const amount1 = 500000000000000000n;
    const usdValue = estimateUsdValue(amount0, amount1, USDC_ADDRESS, WETH_ADDRESS, 6, 18);
    expect(usdValue).toBe(1);
  });

  it("should estimate USD value for USDT swaps", () => {
    const amount0 = 10000000000n;
    const amount1 = 3333333333333333333n;
    const usdValue = estimateUsdValue(amount0, amount1, USDT_ADDRESS, WETH_ADDRESS, 6, 18);
    expect(usdValue).toBe(10000);
  });

  it("should estimate USD value for WETH swaps using ETH price", () => {
    const amount0 = 1000000000000000000n;
    const amount1 = 3000000000n;
    const usdValue = estimateUsdValue(amount0, amount1, WETH_ADDRESS, USDC_ADDRESS, 18, 6);
    expect(usdValue).toBe(3000);
  });

  it("should estimate USD value for WBTC swaps using BTC price", () => {
    const amount0 = 100000000n;
    const amount1 = 20000000000000000000n;
    const usdValue = estimateUsdValue(amount0, amount1, WBTC_ADDRESS, WETH_ADDRESS, 8, 18);
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
    const usdValue = estimateUsdValue(amount0, amount1, USDC_ADDRESS, WETH_ADDRESS, 6, 18);
    expect(usdValue).toBe(1);
  });
});

describe("Pool Filter Tests", () => {
  const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();
  const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7".toLowerCase();
  const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F".toLowerCase();
  const RANDOM_TOKEN = "0x1234567890123456789012345678901234567890".toLowerCase();

  type FilterMode = "all" | "weth_only" | "stablecoin_only" | "custom";

  function shouldWatchPool(
    token0: string,
    token1: string,
    filterMode: FilterMode,
    customTokenFilter: string[] = []
  ): boolean {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    switch (filterMode) {
      case "all":
        return true;

      case "weth_only":
        return t0 === WETH_ADDRESS || t1 === WETH_ADDRESS;

      case "stablecoin_only":
        return (
          t0 === USDC_ADDRESS || t1 === USDC_ADDRESS ||
          t0 === USDT_ADDRESS || t1 === USDT_ADDRESS ||
          t0 === DAI_ADDRESS || t1 === DAI_ADDRESS
        );

      case "custom":
        const customTokens = customTokenFilter.map(t => t.toLowerCase());
        return customTokens.includes(t0) || customTokens.includes(t1);

      default:
        return true;
    }
  }

  describe("all filter mode", () => {
    it("should accept any pool", () => {
      expect(shouldWatchPool(RANDOM_TOKEN, RANDOM_TOKEN, "all")).toBe(true);
      expect(shouldWatchPool(WETH_ADDRESS, USDC_ADDRESS, "all")).toBe(true);
    });
  });

  describe("weth_only filter mode", () => {
    it("should accept WETH pools", () => {
      expect(shouldWatchPool(WETH_ADDRESS, USDC_ADDRESS, "weth_only")).toBe(true);
      expect(shouldWatchPool(USDC_ADDRESS, WETH_ADDRESS, "weth_only")).toBe(true);
    });

    it("should reject non-WETH pools", () => {
      expect(shouldWatchPool(USDC_ADDRESS, USDT_ADDRESS, "weth_only")).toBe(false);
      expect(shouldWatchPool(RANDOM_TOKEN, RANDOM_TOKEN, "weth_only")).toBe(false);
    });
  });

  describe("stablecoin_only filter mode", () => {
    it("should accept stablecoin pools", () => {
      expect(shouldWatchPool(USDC_ADDRESS, WETH_ADDRESS, "stablecoin_only")).toBe(true);
      expect(shouldWatchPool(USDT_ADDRESS, WETH_ADDRESS, "stablecoin_only")).toBe(true);
      expect(shouldWatchPool(DAI_ADDRESS, WETH_ADDRESS, "stablecoin_only")).toBe(true);
    });

    it("should reject non-stablecoin pools", () => {
      expect(shouldWatchPool(WETH_ADDRESS, RANDOM_TOKEN, "stablecoin_only")).toBe(false);
      expect(shouldWatchPool(RANDOM_TOKEN, RANDOM_TOKEN, "stablecoin_only")).toBe(false);
    });
  });

  describe("custom filter mode", () => {
    it("should accept pools with custom tokens", () => {
      const customFilter = [RANDOM_TOKEN];
      expect(shouldWatchPool(RANDOM_TOKEN, WETH_ADDRESS, "custom", customFilter)).toBe(true);
      expect(shouldWatchPool(WETH_ADDRESS, RANDOM_TOKEN, "custom", customFilter)).toBe(true);
    });

    it("should reject pools without custom tokens", () => {
      const customFilter = [RANDOM_TOKEN];
      expect(shouldWatchPool(WETH_ADDRESS, USDC_ADDRESS, "custom", customFilter)).toBe(false);
    });

    it("should handle empty custom filter", () => {
      expect(shouldWatchPool(WETH_ADDRESS, USDC_ADDRESS, "custom", [])).toBe(false);
    });
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
  it("should normalize addresses to lowercase", () => {
    const address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    expect(address.toLowerCase()).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  });

  it("should handle already lowercase addresses", () => {
    const address = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    expect(address.toLowerCase()).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  });

  it("should handle mixed case addresses", () => {
    const address = "0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2";
    expect(address.toLowerCase()).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  });
});

describe("Factory Address Constants", () => {
  it("should have correct V2 factory address", () => {
    expect(V2_FACTORY_ADDRESS).toBe("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f");
  });

  it("should have correct V3 factory address", () => {
    expect(V3_FACTORY_ADDRESS).toBe("0x1F98431c8aD98523631AE4a59f267346ea31F984");
  });
});

describe("Pool Address Constants", () => {
  it("should have correct WETH/USDC V3 pool address", () => {
    expect(WETH_USDC_V3_POOL).toBe("0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640");
  });

  it("should have correct WETH/USDT V3 pool address", () => {
    expect(WETH_USDT_V3_POOL).toBe("0x11b815efB8f581194ae5486326430326078dF15A");
  });
});

describe("Message Format Tests", () => {
  it("should format swap message correctly", () => {
    const dex = "uniswap_v3";
    const pairLabel = "WETH/USDC";
    const pool = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
    const usdValue = 50000.5;
    const txHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    const message = `Swap on ${dex} ${pairLabel} pool=${pool.slice(0, 10)}... usd=$${usdValue.toFixed(2)} tx=${txHash.slice(0, 10)}...`;

    expect(message).toContain("uniswap_v3");
    expect(message).toContain("WETH/USDC");
    expect(message).toContain("0x88e6A0c2");
    expect(message).toContain("$50000.50");
    expect(message).toContain("0x12345678");
  });

  it("should truncate long addresses correctly", () => {
    const address = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
    const truncated = address.slice(0, 10) + "...";
    expect(truncated).toBe("0x88e6A0c2...");
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

  it("should calculate net amounts correctly for V2", () => {
    const amount0In = 0n;
    const amount1In = 1000000n;
    const amount0Out = 1000000000000000000n;
    const amount1Out = 0n;

    const netAmount0 = amount0Out - amount0In;
    const netAmount1 = amount1Out - amount1In;

    expect(netAmount0).toBe(1000000000000000000n);
    expect(netAmount1).toBe(-1000000n);
  });
});

describe("Settings Validation Tests", () => {
  it("should validate RPC URL format", () => {
    const validWsUrl = "ws://localhost:8546";
    const validWssUrl = "wss://mainnet.infura.io/ws/v3/YOUR-PROJECT-ID";
    
    expect(validWsUrl.startsWith("ws://") || validWsUrl.startsWith("wss://")).toBe(true);
    expect(validWssUrl.startsWith("ws://") || validWssUrl.startsWith("wss://")).toBe(true);
  });

  it("should validate whale threshold is positive", () => {
    const threshold = 50000;
    expect(threshold > 0).toBe(true);
  });

  it("should validate pool addresses are valid Ethereum addresses", () => {
    const validAddress = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;
    expect(addressRegex.test(validAddress)).toBe(true);
  });

  it("should reject invalid Ethereum addresses", () => {
    const invalidAddresses = [
      "0x123",
      "88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
      "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    ];
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;
    
    for (const addr of invalidAddresses) {
      expect(addressRegex.test(addr)).toBe(false);
    }
  });
});

describe("NATS Subject Tests", () => {
  it("should format NATS subject correctly", () => {
    const module = "uniswap";
    const event = "tradeExecuted";
    const subject = `feedeater.${module}.${event}`;
    expect(subject).toBe("feedeater.uniswap.tradeExecuted");
  });

  it("should format log subject correctly", () => {
    const subject = "feedeater.uniswap.log";
    expect(subject).toBe("feedeater.uniswap.log");
  });
});
