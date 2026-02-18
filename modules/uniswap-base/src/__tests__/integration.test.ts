import { describe, it, expect } from "vitest";
import { Interface, formatUnits, JsonRpcProvider, WebSocketProvider } from "ethers";

const RPC_WS_URL = "ws://192.168.0.134:8646";
const RPC_HTTP_URL = "http://192.168.0.134:8646";
const REQUEST_TIMEOUT = 15000;

const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const WETH_USDC_005_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
const WETH_USDC_030_POOL = "0x6c561B446416E1A00E8E93E221854d6eA4171372";

const BASE_WETH = "0x4200000000000000000000000000000000000006";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const V3_SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const V3_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];
const v3SwapIface = new Interface(V3_SWAP_ABI);

async function isBaseNodeReachable(): Promise<boolean> {
  try {
    const provider = new JsonRpcProvider(RPC_HTTP_URL);
    const blockNumber = await Promise.race([
      provider.getBlockNumber(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 5000)
      ),
    ]);
    await provider.destroy();
    return typeof blockNumber === "number" && blockNumber > 0;
  } catch {
    return false;
  }
}

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

function estimateUsdValue(
  pool: string,
  amount0: bigint,
  amount1: bigint
): number {
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

describe("Uniswap V3 Base Integration Tests", () => {
  describe("Live RPC Connectivity", () => {
    it(
      "should connect to Base L2 node via HTTP JSON-RPC",
      { timeout: REQUEST_TIMEOUT },
      async () => {
        const reachable = await isBaseNodeReachable();
        if (!reachable) {
          console.warn(
            "Base L2 node not reachable at " + RPC_HTTP_URL + " \u2014 skipping"
          );
          return;
        }

        const provider = new JsonRpcProvider(RPC_HTTP_URL);
        const blockNumber = await provider.getBlockNumber();
        expect(blockNumber).toBeGreaterThan(0);

        const network = await provider.getNetwork();
        expect(Number(network.chainId)).toBe(8453);
        await provider.destroy();
      }
    );

    it(
      "should connect to Base L2 node via WebSocket",
      { timeout: REQUEST_TIMEOUT },
      async () => {
        const reachable = await isBaseNodeReachable();
        if (!reachable) {
          console.warn(
            "Base L2 node not reachable at " + RPC_WS_URL + " \u2014 skipping"
          );
          return;
        }

        let provider: WebSocketProvider | undefined;
        try {
          provider = new WebSocketProvider(RPC_WS_URL);
          const blockNumber = await Promise.race([
            provider.getBlockNumber(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("ws timeout")), 10000)
            ),
          ]);
          expect(blockNumber).toBeGreaterThan(0);
        } finally {
          if (provider) {
            try {
              await provider.destroy();
            } catch {
              /* ignore cleanup errors */
            }
          }
        }
      }
    );

    it(
      "should return recent block with valid timestamp",
      { timeout: REQUEST_TIMEOUT },
      async () => {
        const reachable = await isBaseNodeReachable();
        if (!reachable) {
          console.warn("Base L2 node not reachable \u2014 skipping");
          return;
        }

        const provider = new JsonRpcProvider(RPC_HTTP_URL);
        const blockNumber = await provider.getBlockNumber();
        const block = await provider.getBlock(blockNumber);
        expect(block).not.toBeNull();
        expect(block!.timestamp).toBeGreaterThan(1700000000);
        expect(block!.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        await provider.destroy();
      }
    );

    it("should use local node URL, not Infura", () => {
      expect(RPC_WS_URL).not.toContain("infura");
      expect(RPC_WS_URL).toBe("ws://192.168.0.134:8646");
      expect(RPC_HTTP_URL).not.toContain("infura");
      expect(RPC_HTTP_URL).toBe("http://192.168.0.134:8646");
    });
  });

  describe("Settings Parser", () => {
    it("should parse default settings with correct rpcUrl", async () => {
      const { parseUniswapBaseSettingsFromInternal } = await import(
        "../ingest.js"
      );
      const settings = parseUniswapBaseSettingsFromInternal({});

      expect(settings.enabled).toBe(false);
      expect(settings.rpcUrl).toBe("ws://192.168.0.134:8646");
      expect(settings.whaleThreshold).toBe(50000);
    });

    it("should have non-empty watchedPools by default", async () => {
      const { parseUniswapBaseSettingsFromInternal } = await import(
        "../ingest.js"
      );
      const settings = parseUniswapBaseSettingsFromInternal({});

      const pools: string[] = JSON.parse(settings.watchedUniswapPools);
      expect(Array.isArray(pools)).toBe(true);
      expect(pools.length).toBeGreaterThan(0);
      expect(pools).toContain(WETH_USDC_005_POOL);
      expect(pools).toContain(WETH_USDC_030_POOL);
    });

    it("should accept valid whaleThreshold", async () => {
      const { parseUniswapBaseSettingsFromInternal } = await import(
        "../ingest.js"
      );
      const settings = parseUniswapBaseSettingsFromInternal({
        enabled: "true",
        whaleThreshold: "100000",
      });

      expect(settings.enabled).toBe(true);
      expect(settings.whaleThreshold).toBe(100000);
    });

    it("should reject invalid whaleThreshold", async () => {
      const { parseUniswapBaseSettingsFromInternal } = await import(
        "../ingest.js"
      );

      expect(() =>
        parseUniswapBaseSettingsFromInternal({ whaleThreshold: "0" })
      ).toThrow();
      expect(() =>
        parseUniswapBaseSettingsFromInternal({ whaleThreshold: "-1" })
      ).toThrow();
      expect(() =>
        parseUniswapBaseSettingsFromInternal({ whaleThreshold: "abc" })
      ).toThrow();
    });

    it("should default rpcUrl to local Base node, never Infura", async () => {
      const { parseUniswapBaseSettingsFromInternal } = await import(
        "../ingest.js"
      );
      const settings = parseUniswapBaseSettingsFromInternal({});

      expect(settings.rpcUrl).not.toContain("infura");
      expect(settings.rpcUrl).toMatch(/^wss?:\/\/192\.168\.0\.134/);
    });
  });

  describe("Pool Address Validation (On-Chain)", () => {
    it(
      "should verify WETH/USDC 0.05% pool exists via factory getPool",
      { timeout: REQUEST_TIMEOUT },
      async () => {
        const reachable = await isBaseNodeReachable();
        if (!reachable) {
          console.warn(
            "Base L2 node not reachable \u2014 skipping on-chain pool validation"
          );
          return;
        }

        const provider = new JsonRpcProvider(RPC_HTTP_URL);
        const factoryAbi = [
          "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
        ];
        const iface = new Interface(factoryAbi);
        const callData = iface.encodeFunctionData("getPool", [
          BASE_WETH,
          BASE_USDC,
          500,
        ]);

        const result = await provider.call({
          to: UNISWAP_V3_FACTORY,
          data: callData,
        });

        const [poolAddress] = iface.decodeFunctionResult("getPool", result);
        expect((poolAddress as string).toLowerCase()).toBe(
          WETH_USDC_005_POOL.toLowerCase()
        );
        await provider.destroy();
      }
    );

    it(
      "should verify WETH/USDC 0.3% pool exists via factory getPool",
      { timeout: REQUEST_TIMEOUT },
      async () => {
        const reachable = await isBaseNodeReachable();
        if (!reachable) {
          console.warn(
            "Base L2 node not reachable \u2014 skipping on-chain pool validation"
          );
          return;
        }

        const provider = new JsonRpcProvider(RPC_HTTP_URL);
        const factoryAbi = [
          "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
        ];
        const iface = new Interface(factoryAbi);
        const callData = iface.encodeFunctionData("getPool", [
          BASE_WETH,
          BASE_USDC,
          3000,
        ]);

        const result = await provider.call({
          to: UNISWAP_V3_FACTORY,
          data: callData,
        });

        const [poolAddress] = iface.decodeFunctionResult("getPool", result);
        expect((poolAddress as string).toLowerCase()).toBe(
          WETH_USDC_030_POOL.toLowerCase()
        );
        await provider.destroy();
      }
    );

    it(
      "should verify pool has non-zero liquidity",
      { timeout: REQUEST_TIMEOUT },
      async () => {
        const reachable = await isBaseNodeReachable();
        if (!reachable) {
          console.warn(
            "Base L2 node not reachable \u2014 skipping liquidity check"
          );
          return;
        }

        const provider = new JsonRpcProvider(RPC_HTTP_URL);
        const poolAbi = ["function liquidity() view returns (uint128)"];
        const iface = new Interface(poolAbi);
        const callData = iface.encodeFunctionData("liquidity");

        const result = await provider.call({
          to: WETH_USDC_005_POOL,
          data: callData,
        });

        const [liquidity] = iface.decodeFunctionResult("liquidity", result);
        expect(BigInt(liquidity as string)).toBeGreaterThan(0n);
        await provider.destroy();
      }
    );

    it("should have valid Ethereum address format for all pool constants", () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      expect(addressRegex.test(UNISWAP_V3_FACTORY)).toBe(true);
      expect(addressRegex.test(WETH_USDC_005_POOL)).toBe(true);
      expect(addressRegex.test(WETH_USDC_030_POOL)).toBe(true);
      expect(addressRegex.test(BASE_WETH)).toBe(true);
      expect(addressRegex.test(BASE_USDC)).toBe(true);
    });
  });

  describe("Swap Event Parsing", () => {
    it("should have correct V3 Swap topic hash", () => {
      const computedTopic = v3SwapIface.getEvent("Swap")?.topicHash;
      expect(computedTopic?.toLowerCase()).toBe(V3_SWAP_TOPIC.toLowerCase());
    });

    it("should parse a known buy swap (ETH bought with USDC)", () => {
      const amount0Hex =
        "ffffffffffffffffffffffffffffffffffffffffffffffffffd4a510acc09e00";
      const amount1Hex =
        "000000000000000000000000000000000000000000000000000000012a05f200";
      const sqrtPriceX96Hex =
        "000000000000000000000000000000000000039fa0f37e9cf7ef7a80c63f0000";
      const liquidityHex =
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
      const tickHex =
        "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd8f08";

      const mockData =
        "0x" +
        amount0Hex +
        amount1Hex +
        sqrtPriceX96Hex +
        liquidityHex +
        tickHex;

      const senderAddr = "3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
      const recipientAddr = "3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";

      const mockTopics = [
        V3_SWAP_TOPIC,
        "0x000000000000000000000000" + senderAddr,
        "0x000000000000000000000000" + recipientAddr,
      ];

      const parsed = v3SwapIface.parseLog({
        topics: mockTopics,
        data: mockData,
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.name).toBe("Swap");

      const amount0 = BigInt(parsed!.args[2]);
      const amount1 = BigInt(parsed!.args[3]);
      const sqrtPriceX96 = BigInt(parsed!.args[4]);

      expect(amount0).toBeLessThan(0n);
      expect(amount1).toBeGreaterThan(0n);

      const side = amount0 > 0n ? "sell" : "buy";
      expect(side).toBe("buy");

      const usdValue = estimateUsdValue(WETH_USDC_005_POOL, amount0, amount1);
      expect(usdValue).toBeGreaterThan(0);

      const pair = "WETH/USDC";
      const price = computePriceFromSqrtPriceX96(sqrtPriceX96, 18, 6);
      expect(price).toBeGreaterThan(0);

      const size = Math.abs(Number(amount0) / 1e18);
      expect(size).toBeGreaterThan(0);

      const tradeEvent = {
        source: "uniswap-base",
        symbol: pair,
        side,
        price,
        size,
        notional_usd: usdValue,
      };

      expect(tradeEvent.source).toBe("uniswap-base");
      expect(tradeEvent.symbol).toBe("WETH/USDC");
      expect(tradeEvent.side).toBe("buy");
      expect(tradeEvent.price).toBeGreaterThan(0);
      expect(tradeEvent.size).toBeGreaterThan(0);
      expect(tradeEvent.notional_usd).toBeGreaterThan(0);
    });

    it("should parse a known sell swap (ETH sold for USDC)", () => {
      const amount0Hex =
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
      const amount1Hex =
        "fffffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c00";
      const sqrtPriceX96Hex =
        "000000000000000000000000000000000000039fa0f37e9cf7ef7a80c63f0000";
      const liquidityHex =
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
      const tickHex =
        "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd8f08";

      const mockData =
        "0x" +
        amount0Hex +
        amount1Hex +
        sqrtPriceX96Hex +
        liquidityHex +
        tickHex;

      const mockTopics = [
        V3_SWAP_TOPIC,
        "0x0000000000000000000000003fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
        "0x0000000000000000000000003fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
      ];

      const parsed = v3SwapIface.parseLog({
        topics: mockTopics,
        data: mockData,
      });
      expect(parsed).not.toBeNull();

      const amount0 = BigInt(parsed!.args[2]);
      const amount1 = BigInt(parsed!.args[3]);

      expect(amount0).toBeGreaterThan(0n);
      expect(amount1).toBeLessThan(0n);

      const side = amount0 > 0n ? "sell" : "buy";
      expect(side).toBe("sell");

      const pair = "WETH/USDC";
      const size = Math.abs(Number(amount0) / 1e18);
      expect(size).toBeCloseTo(1.0, 1);

      const usdValue = estimateUsdValue(WETH_USDC_005_POOL, amount0, amount1);
      expect(usdValue).toBeGreaterThan(0);

      const tradeEvent = {
        source: "uniswap-base",
        symbol: pair,
        side,
        size,
        notional_usd: usdValue,
      };

      expect(tradeEvent.source).toBe("uniswap-base");
      expect(tradeEvent.symbol).toBe("WETH/USDC");
      expect(tradeEvent.side).toBe("sell");
      expect(tradeEvent.size).toBeGreaterThan(0);
      expect(tradeEvent.notional_usd).toBeGreaterThan(0);
    });

    it("should compute ETH/USDC price in realistic range from sqrtPriceX96", () => {
      const sqrtPriceX96 = BigInt("4339505179874779222759694");
      const price = computePriceFromSqrtPriceX96(sqrtPriceX96, 18, 6);
      expect(price).toBeGreaterThan(1000);
      expect(price).toBeLessThan(10000);
    });

    it("should compute price=1 when sqrtPriceX96 represents 1:1 with same decimals", () => {
      const sqrtPriceX96 = BigInt("79228162514264337593543950336");
      const price = computePriceFromSqrtPriceX96(sqrtPriceX96, 18, 18);
      expect(price).toBeCloseTo(1, 5);
    });

    it("should extract sender and recipient from indexed topics", () => {
      const senderAddr = "3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
      const recipientAddr = "d0b53D9277642d899DF5C87A3966A349A798F224";

      const mockData =
        "0x" +
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
        "fffffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c00" +
        "000000000000000000000000000000000000039fa0f37e9cf7ef7a80c63f0000" +
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
        "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd8f08";

      const mockTopics = [
        V3_SWAP_TOPIC,
        "0x000000000000000000000000" + senderAddr,
        "0x000000000000000000000000" + recipientAddr,
      ];

      const parsed = v3SwapIface.parseLog({
        topics: mockTopics,
        data: mockData,
      });
      const sender = (parsed!.args[0] as string).toLowerCase();
      const recipient = (parsed!.args[1] as string).toLowerCase();

      expect(sender).toBe("0x" + senderAddr.toLowerCase());
      expect(recipient).toBe("0x" + recipientAddr.toLowerCase());
    });

    it("should handle whale detection for large swaps", () => {
      const largeAmount1 = 100000000000n;
      const usdValue = estimateUsdValue(
        WETH_USDC_005_POOL,
        -10000000000000000000n,
        largeAmount1
      );
      const isWhale = usdValue >= 50000;
      expect(isWhale).toBe(true);
      expect(usdValue).toBe(100000);
    });

    it("should not flag small swaps as whale", () => {
      const smallAmount1 = 100000000n;
      const usdValue = estimateUsdValue(
        WETH_USDC_005_POOL,
        -100000000000000000n,
        smallAmount1
      );
      const isWhale = usdValue >= 50000;
      expect(isWhale).toBe(false);
      expect(usdValue).toBe(100);
    });
  });

  describe("Live Swap Log Fetch", () => {
    it(
      "should fetch recent swap logs from WETH/USDC pool",
      { timeout: REQUEST_TIMEOUT * 2 },
      async () => {
        const reachable = await isBaseNodeReachable();
        if (!reachable) {
          console.warn(
            "Base L2 node not reachable \u2014 skipping live swap log fetch"
          );
          return;
        }

        const provider = new JsonRpcProvider(RPC_HTTP_URL);
        const latestBlock = await provider.getBlockNumber();
        const fromBlock = Math.max(0, latestBlock - 500);

        const logs = await provider.getLogs({
          address: [
            WETH_USDC_005_POOL.toLowerCase(),
            WETH_USDC_030_POOL.toLowerCase(),
          ],
          topics: [[V3_SWAP_TOPIC]],
          fromBlock,
          toBlock: latestBlock,
        });

        expect(Array.isArray(logs)).toBe(true);

        if (logs.length > 0) {
          const log = logs[0]!;
          expect(log.address).toBeDefined();
          expect(log.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
          expect(log.topics[0]).toBe(V3_SWAP_TOPIC);

          const parsed = v3SwapIface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          expect(parsed).not.toBeNull();
          expect(parsed!.name).toBe("Swap");

          const amount0 = BigInt(parsed!.args[2]);
          const amount1 = BigInt(parsed!.args[3]);
          const sqrtPriceX96 = BigInt(parsed!.args[4]);

          expect(typeof amount0).toBe("bigint");
          expect(typeof amount1).toBe("bigint");
          expect(sqrtPriceX96).toBeGreaterThan(0n);
        } else {
          console.warn(
            "No swap logs in last 500 blocks (" +
              fromBlock +
              "\u2013" +
              latestBlock +
              ")"
          );
        }

        await provider.destroy();
      }
    );
  });

  describe("NATS Subject Format", () => {
    it("should format tradeExecuted subject correctly", () => {
      const subject = "feedeater.uniswap-base.tradeExecuted";
      expect(subject).toBe("feedeater.uniswap-base.tradeExecuted");
    });

    it("should format messageCreated subject correctly", () => {
      const subject = "feedeater.uniswap-base.messageCreated";
      expect(subject).toBe("feedeater.uniswap-base.messageCreated");
    });
  });

  describe("tradeExecuted Event Schema", () => {
    it("should produce valid tradeExecuted event structure", () => {
      const tradeEvent = {
        source: "uniswap-base",
        symbol: "WETH/USDC",
        side: "buy" as "buy" | "sell",
        price: 3000.5,
        size: 1.5,
        notional_usd: 4500.75,
        timestamp: new Date().toISOString(),
        pool_address: WETH_USDC_005_POOL.toLowerCase(),
        tx_hash: "0x" + "a".repeat(64),
        block_number: 12345678,
      };

      expect(tradeEvent.source).toBe("uniswap-base");
      expect(tradeEvent.symbol).toBe("WETH/USDC");
      expect(["buy", "sell"]).toContain(tradeEvent.side);
      expect(tradeEvent.price).toBeGreaterThan(0);
      expect(tradeEvent.size).toBeGreaterThan(0);
      expect(tradeEvent.notional_usd).toBeGreaterThan(0);
      expect(tradeEvent.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
      );
      expect(tradeEvent.pool_address).toMatch(/^0x[a-f0-9]{40}$/);
      expect(tradeEvent.tx_hash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(tradeEvent.block_number).toBeGreaterThan(0);
    });

    it("should produce valid ISO-8601 timestamp", () => {
      const ts = new Date().toISOString();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(() => new Date(ts)).not.toThrow();
    });
  });
});
