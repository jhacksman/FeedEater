import { describe, it, expect } from "vitest";
import { Interface, formatUnits } from "ethers";

const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";
const UNISWAP_V3_WETH_USDC_POOL = "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443";
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const GMX_EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";
const GMX_POSITION_INCREASE_TOPIC = "0x137a44067c8961cd7e1d876f4754a5a3a75989b4552f1843fc69c3b372def160";
const GMX_POSITION_DECREASE_TOPIC = "0x137a44067c8961cd7e1d876f4754a5a3a75989b4552f1843fc69c3b372def161";

const V3_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];
const v3Iface = new Interface(V3_ABI);

const GMX_POSITION_ABI = [
  "event PositionIncrease(bytes32 indexed key, address account, address market, address collateralToken, bool isLong, uint256 executionPrice, uint256 sizeDeltaUsd, uint256 sizeDeltaInTokens, int256 collateralDeltaAmount, int256 borrowingFactor, int256 fundingFeeAmountPerSize, int256 longTokenClaimableFundingAmountPerSize, int256 shortTokenClaimableFundingAmountPerSize, uint256 priceImpactUsd, bytes32 orderType)",
  "event PositionDecrease(bytes32 indexed key, address account, address market, address collateralToken, bool isLong, uint256 executionPrice, uint256 sizeDeltaUsd, uint256 sizeDeltaInTokens, int256 collateralDeltaAmount, int256 borrowingFactor, int256 fundingFeeAmountPerSize, int256 longTokenClaimableFundingAmountPerSize, int256 shortTokenClaimableFundingAmountPerSize, uint256 priceImpactUsd, bytes32 orderType)",
];
const gmxIface = new Interface(GMX_POSITION_ABI);

const RPC_TIMEOUT = 30000;

async function rpcCall(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(ARBITRUM_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: any; error?: any };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

describe("Arbitrum DEX Integration Tests", () => {
  describe("Arbitrum RPC Connectivity", () => {
    it("should fetch the latest block number", { timeout: RPC_TIMEOUT }, async () => {
      const blockHex = await rpcCall("eth_blockNumber", []);
      const blockNumber = parseInt(blockHex, 16);
      expect(blockNumber).toBeGreaterThan(200_000_000);
    });

    it("should fetch a block by number", { timeout: RPC_TIMEOUT }, async () => {
      const blockHex = await rpcCall("eth_blockNumber", []);
      const block = await rpcCall("eth_getBlockByNumber", [blockHex, false]);
      expect(block).toBeDefined();
      expect(typeof block.timestamp).toBe("string");
      expect(parseInt(block.timestamp, 16)).toBeGreaterThan(0);
    });
  });

  describe("Uniswap V3 Swap Events", () => {
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
            address: UNISWAP_V3_WETH_USDC_POOL,
            topics: [V3_SWAP_TOPIC],
            fromBlock,
            toBlock,
          },
        ]);

        expect(Array.isArray(logs)).toBe(true);
        expect(logs.length).toBeGreaterThan(0);

        const log = logs[0];
        expect(log.address.toLowerCase()).toBe(UNISWAP_V3_WETH_USDC_POOL.toLowerCase());
        expect(log.topics[0].toLowerCase()).toBe(V3_SWAP_TOPIC.toLowerCase());
        expect(typeof log.transactionHash).toBe("string");
        expect(typeof log.blockNumber).toBe("string");
      }
    );

    it(
      "should decode Swap event data correctly",
      { timeout: RPC_TIMEOUT },
      async () => {
        const latestHex = await rpcCall("eth_blockNumber", []);
        const latest = parseInt(latestHex, 16);
        const fromBlock = "0x" + (latest - 500).toString(16);

        const logs = await rpcCall("eth_getLogs", [
          {
            address: UNISWAP_V3_WETH_USDC_POOL,
            topics: [V3_SWAP_TOPIC],
            fromBlock,
            toBlock: latestHex,
          },
        ]);

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];

        const decoded = v3Iface.parseLog({ topics: log.topics, data: log.data });
        expect(decoded).not.toBeNull();
        expect(decoded!.name).toBe("Swap");

        const amount0 = BigInt(decoded!.args[2]);
        const amount1 = BigInt(decoded!.args[3]);
        expect(typeof amount0).toBe("bigint");
        expect(typeof amount1).toBe("bigint");

        const usdValue = Math.abs(Number(formatUnits(amount1, 6)));
        expect(usdValue).toBeGreaterThan(0);
      }
    );
  });

  describe("GMX V2 Position Events", () => {
    it(
      "should fetch recent PositionIncrease or PositionDecrease logs",
      { timeout: RPC_TIMEOUT },
      async () => {
        const latestHex = await rpcCall("eth_blockNumber", []);
        const latest = parseInt(latestHex, 16);
        const fromBlock = "0x" + (latest - 5000).toString(16);

        const logs = await rpcCall("eth_getLogs", [
          {
            address: GMX_EVENT_EMITTER,
            topics: [[GMX_POSITION_INCREASE_TOPIC, GMX_POSITION_DECREASE_TOPIC]],
            fromBlock,
            toBlock: latestHex,
          },
        ]);

        expect(Array.isArray(logs)).toBe(true);
        if (logs.length === 0) {
          return;
        }

        const log = logs[0];
        expect(log.address.toLowerCase()).toBe(GMX_EVENT_EMITTER.toLowerCase());
        const topic0 = log.topics[0].toLowerCase();
        expect(
          [GMX_POSITION_INCREASE_TOPIC.toLowerCase(), GMX_POSITION_DECREASE_TOPIC.toLowerCase()]
        ).toContain(topic0);
      }
    );

    it(
      "should decode GMX position event data",
      { timeout: RPC_TIMEOUT },
      async () => {
        const latestHex = await rpcCall("eth_blockNumber", []);
        const latest = parseInt(latestHex, 16);
        const fromBlock = "0x" + (latest - 5000).toString(16);

        const logs = await rpcCall("eth_getLogs", [
          {
            address: GMX_EVENT_EMITTER,
            topics: [[GMX_POSITION_INCREASE_TOPIC, GMX_POSITION_DECREASE_TOPIC]],
            fromBlock,
            toBlock: latestHex,
          },
        ]);

        if (logs.length === 0) {
          return;
        }

        const log = logs[0];
        const decoded = gmxIface.parseLog({ topics: log.topics, data: log.data });
        expect(decoded).not.toBeNull();
        expect(["PositionIncrease", "PositionDecrease"]).toContain(decoded!.name);

        const account = decoded!.args[1];
        const market = decoded!.args[2];
        const isLong = decoded!.args[4];
        const sizeDeltaUsd = BigInt(decoded!.args[6]);

        expect(typeof account).toBe("string");
        expect(typeof market).toBe("string");
        expect(typeof isLong).toBe("boolean");

        const usdValue = Number(formatUnits(sizeDeltaUsd, 30));
        expect(usdValue).toBeGreaterThanOrEqual(0);
      }
    );
  });

  describe("Settings Parser", () => {
    it("should parse default settings correctly", async () => {
      const { parseArbitrumDexSettingsFromInternal } = await import("../ingest.js");
      const settings = parseArbitrumDexSettingsFromInternal({});
      expect(settings.enabled).toBe(false);
      expect(settings.whaleThreshold).toBe(50000);
      expect(settings.enableGmx).toBe(true);
      expect(typeof settings.rpcUrl).toBe("string");
    });

    it("should parse enabled + custom thresholds", async () => {
      const { parseArbitrumDexSettingsFromInternal } = await import("../ingest.js");
      const settings = parseArbitrumDexSettingsFromInternal({
        enabled: "true",
        whaleThreshold: "100000",
        enableGmx: "false",
      });
      expect(settings.enabled).toBe(true);
      expect(settings.whaleThreshold).toBe(100000);
      expect(settings.enableGmx).toBe(false);
    });

    it("should parse watched pools as JSON array", async () => {
      const { parseArbitrumDexSettingsFromInternal } = await import("../ingest.js");
      const settings = parseArbitrumDexSettingsFromInternal({
        watchedUniswapPools: '["0xabc","0xdef"]',
      });
      expect(settings.watchedUniswapPools).toBe('["0xabc","0xdef"]');
    });

    it("should throw on invalid whaleThreshold", async () => {
      const { parseArbitrumDexSettingsFromInternal } = await import("../ingest.js");
      expect(() => parseArbitrumDexSettingsFromInternal({ whaleThreshold: "0" })).toThrow();
      expect(() => parseArbitrumDexSettingsFromInternal({ whaleThreshold: "-1" })).toThrow();
    });
  });
});
