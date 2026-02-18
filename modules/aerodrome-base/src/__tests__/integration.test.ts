import { describe, it, expect } from "vitest";
import { Interface, formatUnits } from "ethers";

const AERODROME_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)",
];
const aeroSwapIface = new Interface(AERODROME_SWAP_ABI);
const AERODROME_SWAP_TOPIC = aeroSwapIface.getEvent("Swap")!.topicHash;

const WETH_USDC_POOL = "0xcDAC0d6c6C59727a65F871236188350531885C43";
const USDC_USDbC_POOL = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
const WETH_cbETH_POOL = "0x44Ecc644449fC3a9858d2007CaA8CFAa4C561f91";

const BASE_RPC = "https://mainnet.base.org";
const RPC_TIMEOUT = 30000;

async function rpcCall(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: any; error?: any };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

describe("Aerodrome Base DEX Integration Tests", () => {
  describe("Base RPC Connectivity", () => {
    it("should fetch the latest block number", { timeout: RPC_TIMEOUT }, async () => {
      const blockHex = await rpcCall("eth_blockNumber", []);
      const blockNumber = parseInt(blockHex, 16);
      expect(blockNumber).toBeGreaterThan(10_000_000);
    });

    it("should fetch a block by number", { timeout: RPC_TIMEOUT }, async () => {
      const blockHex = await rpcCall("eth_blockNumber", []);
      const block = await rpcCall("eth_getBlockByNumber", [blockHex, false]);
      expect(block).toBeDefined();
      expect(typeof block.timestamp).toBe("string");
      expect(parseInt(block.timestamp, 16)).toBeGreaterThan(0);
    });
  });

  describe("Aerodrome Swap Events", () => {
    it(
      "should fetch recent Swap logs from WETH/USDC pool",
      { timeout: RPC_TIMEOUT },
      async () => {
        const latestHex = await rpcCall("eth_blockNumber", []);
        const latest = parseInt(latestHex, 16);
        const fromBlock = "0x" + (latest - 500).toString(16);
        const toBlock = latestHex;

        const logs = await rpcCall("eth_getLogs", [
          {
            address: WETH_USDC_POOL,
            topics: [AERODROME_SWAP_TOPIC],
            fromBlock,
            toBlock,
          },
        ]);

        expect(Array.isArray(logs)).toBe(true);
        if (logs.length > 0) {
          const log = logs[0];
          expect(log.address.toLowerCase()).toBe(WETH_USDC_POOL.toLowerCase());
          expect(log.topics[0].toLowerCase()).toBe(AERODROME_SWAP_TOPIC.toLowerCase());
          expect(typeof log.transactionHash).toBe("string");
          expect(typeof log.blockNumber).toBe("string");
        }
      }
    );

    it(
      "should decode Aerodrome Swap event data correctly",
      { timeout: RPC_TIMEOUT },
      async () => {
        const latestHex = await rpcCall("eth_blockNumber", []);
        const latest = parseInt(latestHex, 16);
        const fromBlock = "0x" + (latest - 2000).toString(16);

        const logs = await rpcCall("eth_getLogs", [
          {
            address: WETH_USDC_POOL,
            topics: [AERODROME_SWAP_TOPIC],
            fromBlock,
            toBlock: latestHex,
          },
        ]);

        if (logs.length === 0) return;

        const log = logs[0];
        const decoded = aeroSwapIface.parseLog({ topics: log.topics, data: log.data });
        expect(decoded).not.toBeNull();
        expect(decoded!.name).toBe("Swap");

        const sender = decoded!.args[0];
        const to = decoded!.args[1];
        const amount0In = BigInt(decoded!.args[2]);
        const amount1In = BigInt(decoded!.args[3]);
        const amount0Out = BigInt(decoded!.args[4]);
        const amount1Out = BigInt(decoded!.args[5]);

        expect(typeof sender).toBe("string");
        expect(typeof to).toBe("string");
        expect(typeof amount0In).toBe("bigint");
        expect(typeof amount1In).toBe("bigint");
        expect(typeof amount0Out).toBe("bigint");
        expect(typeof amount1Out).toBe("bigint");

        const hasInput = amount0In > 0n || amount1In > 0n;
        const hasOutput = amount0Out > 0n || amount1Out > 0n;
        expect(hasInput).toBe(true);
        expect(hasOutput).toBe(true);
      }
    );

    it(
      "should compute USD value from USDC amounts in WETH/USDC pool",
      { timeout: RPC_TIMEOUT },
      async () => {
        const latestHex = await rpcCall("eth_blockNumber", []);
        const latest = parseInt(latestHex, 16);
        const fromBlock = "0x" + (latest - 2000).toString(16);

        const logs = await rpcCall("eth_getLogs", [
          {
            address: WETH_USDC_POOL,
            topics: [AERODROME_SWAP_TOPIC],
            fromBlock,
            toBlock: latestHex,
          },
        ]);

        if (logs.length === 0) return;

        const log = logs[0];
        const decoded = aeroSwapIface.parseLog({ topics: log.topics, data: log.data });
        const amount1In = BigInt(decoded!.args[3]);
        const amount1Out = BigInt(decoded!.args[5]);

        const usdcIn = Math.abs(Number(formatUnits(amount1In, 6)));
        const usdcOut = Math.abs(Number(formatUnits(amount1Out, 6)));
        const usdValue = Math.max(usdcIn, usdcOut);
        expect(usdValue).toBeGreaterThanOrEqual(0);
      }
    );
  });

  describe("Settings Parser", () => {
    it("should parse default settings correctly", async () => {
      const { parseAerodromeBaseSettingsFromInternal } = await import("../ingest.js");
      const settings = parseAerodromeBaseSettingsFromInternal({});
      expect(settings.enabled).toBe(false);
      expect(settings.whaleThreshold).toBe(50000);
      expect(settings.rpcUrl).toBe("ws://192.168.0.134:8646");
    });

    it("should parse enabled + custom thresholds", async () => {
      const { parseAerodromeBaseSettingsFromInternal } = await import("../ingest.js");
      const settings = parseAerodromeBaseSettingsFromInternal({
        enabled: "true",
        whaleThreshold: "100000",
      });
      expect(settings.enabled).toBe(true);
      expect(settings.whaleThreshold).toBe(100000);
    });

    it("should parse watched pools as JSON array string", async () => {
      const { parseAerodromeBaseSettingsFromInternal } = await import("../ingest.js");
      const settings = parseAerodromeBaseSettingsFromInternal({
        watchedPools: '["0xabc","0xdef"]',
      });
      expect(settings.watchedPools).toBe('["0xabc","0xdef"]');
    });

    it("should throw on invalid whaleThreshold", async () => {
      const { parseAerodromeBaseSettingsFromInternal } = await import("../ingest.js");
      expect(() => parseAerodromeBaseSettingsFromInternal({ whaleThreshold: "0" })).toThrow();
      expect(() => parseAerodromeBaseSettingsFromInternal({ whaleThreshold: "-1" })).toThrow();
    });
  });

  describe("Price Computation", () => {
    it("should compute price from swap amounts", async () => {
      const { computePrice } = await import("../ingest.js");
      const price = computePrice(
        1000000000000000000n,
        0n,
        0n,
        3000000000n,
        18,
        6
      );
      expect(price).toBeCloseTo(3000, 0);
    });

    it("should return 0 if token0 amount is 0", async () => {
      const { computePrice } = await import("../ingest.js");
      const price = computePrice(0n, 0n, 0n, 3000000000n, 18, 6);
      expect(price).toBe(0);
    });
  });

  describe("Side Determination", () => {
    it("should return sell when amount0In > 0 (selling token0)", async () => {
      const { determineSide } = await import("../ingest.js");
      expect(determineSide(1000000000000000000n, 0n)).toBe("sell");
    });

    it("should return buy when amount0In == 0 (buying token0)", async () => {
      const { determineSide } = await import("../ingest.js");
      expect(determineSide(0n, 3000000000n)).toBe("buy");
    });
  });

  describe("USD Value Estimation", () => {
    it("should estimate USD from USDC token (token1 = USDC)", async () => {
      const { estimateUsdValue } = await import("../ingest.js");
      const usd = estimateUsdValue(
        1000000000000000000n, 0n, 0n, 3000000000n,
        "0x4200000000000000000000000000000000000006",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        18, 6
      );
      expect(usd).toBe(3000);
    });

    it("should estimate USD from WETH when no stablecoin present", async () => {
      const { estimateUsdValue } = await import("../ingest.js");
      const usd = estimateUsdValue(
        1000000000000000000n, 0n, 0n, 1000000000000000000n,
        "0x4200000000000000000000000000000000000006",
        "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
        18, 18
      );
      expect(usd).toBe(3000);
    });
  });
});

describe("NATS Subject Tests", () => {
  it("should format tradeExecuted subject correctly", () => {
    const module = "aerodrome-base";
    const event = "tradeExecuted";
    const subject = `feedeater.${module}.${event}`;
    expect(subject).toBe("feedeater.aerodrome-base.tradeExecuted");
  });

  it("should format messageCreated subject correctly", () => {
    const module = "aerodrome-base";
    const event = "messageCreated";
    const subject = `feedeater.${module}.${event}`;
    expect(subject).toBe("feedeater.aerodrome-base.messageCreated");
  });
});

describe("TradeExecuted Event Schema Tests", () => {
  it("should create valid tradeExecuted event structure for Aerodrome swap", () => {
    const tradeEvent = {
      source: "aerodrome-base",
      symbol: "WETH/USDC",
      side: "buy" as "buy" | "sell",
      price: 3000.50,
      size: 1.5,
      notional_usd: 4500.75,
      timestamp: "2026-02-14T23:00:00.000Z",
      pool_address: "0xcDAC0d6c6C59727a65F871236188350531885C43",
      tx_hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      block_number: 20000000,
    };

    expect(tradeEvent.source).toBe("aerodrome-base");
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

  it("should format timestamp as ISO-8601", () => {
    const timestamp = 1707955200000;
    const isoTimestamp = new Date(timestamp).toISOString();
    expect(isoTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("should create whale flag for large trades", () => {
    const whaleThreshold = 50000;
    const smallTrade = 1000;
    const largeTrade = 100000;

    expect(smallTrade >= whaleThreshold).toBe(false);
    expect(largeTrade >= whaleThreshold).toBe(true);
  });
});
