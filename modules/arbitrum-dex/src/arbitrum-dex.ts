import { WebSocketProvider, Log, Interface, formatUnits } from "ethers";
import type { NatsConnection, StringCodec } from "nats";
import { v4 as uuidv4 } from "uuid";
import { NormalizedMessageSchema, MessageCreatedEventSchema, subjectFor } from "@feedeater/core";
import { PrismaClient } from "@prisma/client";

const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const V3_ABI = [
  "event Swap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];
const v3Iface = new Interface(V3_ABI);

const GMX_EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";

const GMX_POSITION_INCREASE_TOPIC = "0x137a44067c8961cd7e1d876f4754a5a3a75989b4552f1843fc69c3b372def160";
const GMX_POSITION_DECREASE_TOPIC = "0x137a44067c8961cd7e1d876f4754a5a3a75989b4552f1843fc69c3b372def161";
const GMX_LIQUIDATE_POSITION_TOPIC = "0x2e1f85a64a2f22cf2f0c42584e7c919ed4abe8d53675cff0f62bf1e95a8f676a";

const GMX_POSITION_ABI = [
  "event PositionIncrease(bytes32 indexed key, address account, address market, address collateralToken, bool isLong, uint256 executionPrice, uint256 sizeDeltaUsd, uint256 sizeDeltaInTokens, int256 collateralDeltaAmount, int256 borrowingFactor, int256 fundingFeeAmountPerSize, int256 longTokenClaimableFundingAmountPerSize, int256 shortTokenClaimableFundingAmountPerSize, uint256 priceImpactUsd, bytes32 orderType)",
  "event PositionDecrease(bytes32 indexed key, address account, address market, address collateralToken, bool isLong, uint256 executionPrice, uint256 sizeDeltaUsd, uint256 sizeDeltaInTokens, int256 collateralDeltaAmount, int256 borrowingFactor, int256 fundingFeeAmountPerSize, int256 longTokenClaimableFundingAmountPerSize, int256 shortTokenClaimableFundingAmountPerSize, uint256 priceImpactUsd, bytes32 orderType)",
  "event LiquidatePosition(bytes32 indexed key, address account, address market, address collateralToken, bool isLong, uint256 executionPrice, uint256 sizeInUsd, uint256 sizeInTokens, int256 collateralAmount, int256 borrowingFactor, int256 fundingFeeAmountPerSize, int256 longTokenClaimableFundingAmountPerSize, int256 shortTokenClaimableFundingAmountPerSize, uint256 priceImpactUsd)"
];
const gmxIface = new Interface(GMX_POSITION_ABI);

const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831".toLowerCase();
const ARBITRUM_USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9".toLowerCase();
const ARBITRUM_WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1".toLowerCase();

export async function createArbitrumDexListener(params: {
  nats: NatsConnection;
  sc: StringCodec;
  getSetting: (k: string) => Promise<string | boolean | number | undefined>;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}) {
  const prisma = new PrismaClient();
  const rpcUrl = (await params.getSetting("rpcUrl")) as string;
  const whaleThreshold = Number((await params.getSetting("whaleThreshold")) ?? 50000);
  const enableGmx = (await params.getSetting("enableGmx")) !== false;

  const watchedPoolsSetting = await params.getSetting("watchedUniswapPools");
  const watchedPools: string[] = Array.isArray(watchedPoolsSetting)
    ? (watchedPoolsSetting as string[])
    : typeof watchedPoolsSetting === "string" && watchedPoolsSetting.trim().startsWith("[")
      ? JSON.parse(watchedPoolsSetting)
      : [];
  const poolAddresses = watchedPools.map((a) => a.toLowerCase());

  params.logger?.info?.({ rpcUrl, poolAddresses, enableGmx, whaleThreshold }, "arbitrum-dex listener starting");

  const provider = new WebSocketProvider(rpcUrl);

  const subscribeUniswap = async () => {
    if (poolAddresses.length === 0) {
      params.logger?.warn?.("no uniswap pools configured, skipping uniswap subscription");
      return;
    }

    provider.on({ address: poolAddresses, topics: [[V3_SWAP_TOPIC]] }, async (log: Log) => {
      try {
        const block = await provider.getBlock(log.blockHash!);
        const tsMs = Number(block!.timestamp) * 1000;
        const tx = await provider.getTransaction(log.transactionHash!);

        let amount0 = 0n, amount1 = 0n;
        try {
          const ev = v3Iface.parseLog({ topics: log.topics, data: log.data });
          amount0 = BigInt(ev!.args[2]);
          amount1 = BigInt(ev!.args[3]);
        } catch (e) {
          params.logger?.warn?.({ e, tx: log.transactionHash }, "failed to decode uniswap v3 swap log");
          return;
        }

        const pool = log.address.toLowerCase();
        let usdValue = 0;

        if (pool === "0xc31e54c7a869b9fcbecc14363cf510d1c41fa443") {
          usdValue = Math.abs(Number(formatUnits(amount1, 6)));
        } else if (pool === "0xc6962004f452be9203591991d15f6b388e09e8d0") {
          usdValue = Math.abs(Number(formatUnits(amount1, 6)));
        } else if (pool === "0x641c00a822e8b671738d32a431a4fb6074e5c79d") {
          const wethLeg = Math.abs(Number(formatUnits(amount1, 18)));
          const approxWethUsd = 3000;
          usdValue = Math.round(wethLeg * approxWethUsd);
        } else {
          const a0Abs = Math.abs(Number(formatUnits(amount0, 18)));
          const a1Abs = Math.abs(Number(formatUnits(amount1, 6)));
          usdValue = Math.max(a0Abs * 3000, a1Abs);
        }

        const isWhale = usdValue >= whaleThreshold;

        await prisma.arbitrumSwap.create({
          data: {
            chain: "arbitrum",
            dex: "uniswap_v3",
            pool,
            txHash: log.transactionHash!,
            block: BigInt(log.blockNumber ?? 0),
            timestampMs: BigInt(tsMs),
            token0Amount: String(amount0),
            token1Amount: String(amount1),
            usdValue: String(usdValue.toFixed(2)),
            sender: tx?.from?.toLowerCase() ?? "0x",
            isWhale,
          },
        });

        const msg = NormalizedMessageSchema.parse({
          id: uuidv4(),
          createdAt: new Date().toISOString(),
          source: { module: "arbitrum-dex", stream: `uniswap:${pool}` },
          realtime: true,
          Message: `Uniswap V3 Swap on Arbitrum pool=${pool.slice(0, 10)}... usd=$${usdValue.toFixed(2)}${isWhale ? " [WHALE]" : ""} tx=${log.transactionHash}`,
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          tags: {
            dex: "uniswap_v3",
            chain: "arbitrum",
            pool,
            is_whale: isWhale,
            tx_hash: log.transactionHash!,
            usd_value: usdValue,
          },
        });
        const ev = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: msg });
        params.nats.publish(subjectFor("arbitrum-dex", "messageCreated"), params.sc.encode(JSON.stringify(ev)));

        if (isWhale) {
          params.logger?.info?.({ pool, usdValue, tx: log.transactionHash }, "whale swap detected");
        }
      } catch (err) {
        params.logger?.error?.({ err }, "arbitrum uniswap listener error");
      }
    });

    params.logger?.info?.({ poolCount: poolAddresses.length }, "uniswap v3 subscription active");
  };

  const subscribeGmx = async () => {
    if (!enableGmx) {
      params.logger?.info?.("gmx subscription disabled");
      return;
    }

    const gmxTopics = [[GMX_POSITION_INCREASE_TOPIC, GMX_POSITION_DECREASE_TOPIC, GMX_LIQUIDATE_POSITION_TOPIC]];

    provider.on({ address: GMX_EVENT_EMITTER, topics: gmxTopics }, async (log: Log) => {
      try {
        const block = await provider.getBlock(log.blockHash!);
        const tsMs = Number(block!.timestamp) * 1000;

        let eventType = "unknown";
        let account = "";
        let market = "";
        let collateralToken = "";
        let isLong = false;
        let sizeInUsd = 0n;
        let sizeInTokens = 0n;
        let collateralAmount = 0n;

        const topic0 = log.topics[0]?.toLowerCase();

        try {
          if (topic0 === GMX_POSITION_INCREASE_TOPIC.toLowerCase()) {
            eventType = "PositionIncrease";
            const ev = gmxIface.parseLog({ topics: log.topics, data: log.data });
            account = ev!.args[1];
            market = ev!.args[2];
            collateralToken = ev!.args[3];
            isLong = ev!.args[4];
            sizeInUsd = BigInt(ev!.args[6]);
            sizeInTokens = BigInt(ev!.args[7]);
            collateralAmount = BigInt(ev!.args[8]);
          } else if (topic0 === GMX_POSITION_DECREASE_TOPIC.toLowerCase()) {
            eventType = "PositionDecrease";
            const ev = gmxIface.parseLog({ topics: log.topics, data: log.data });
            account = ev!.args[1];
            market = ev!.args[2];
            collateralToken = ev!.args[3];
            isLong = ev!.args[4];
            sizeInUsd = BigInt(ev!.args[6]);
            sizeInTokens = BigInt(ev!.args[7]);
            collateralAmount = BigInt(ev!.args[8]);
          } else if (topic0 === GMX_LIQUIDATE_POSITION_TOPIC.toLowerCase()) {
            eventType = "LiquidatePosition";
            const ev = gmxIface.parseLog({ topics: log.topics, data: log.data });
            account = ev!.args[1];
            market = ev!.args[2];
            collateralToken = ev!.args[3];
            isLong = ev!.args[4];
            sizeInUsd = BigInt(ev!.args[6]);
            sizeInTokens = BigInt(ev!.args[7]);
            collateralAmount = BigInt(ev!.args[8]);
          } else {
            return;
          }
        } catch (e) {
          params.logger?.warn?.({ e, tx: log.transactionHash, topic0 }, "failed to decode gmx position log");
          return;
        }

        const usdValue = Number(formatUnits(sizeInUsd, 30));
        const isWhale = usdValue >= whaleThreshold;

        await prisma.gmxPosition.create({
          data: {
            chain: "arbitrum",
            eventType,
            txHash: log.transactionHash!,
            block: BigInt(log.blockNumber ?? 0),
            timestampMs: BigInt(tsMs),
            account: account.toLowerCase(),
            market: market.toLowerCase(),
            collateralToken: collateralToken.toLowerCase(),
            sizeInUsd: String(sizeInUsd),
            sizeInTokens: String(sizeInTokens),
            collateralAmount: String(collateralAmount),
            isLong,
            isWhale,
          },
        });

        const direction = isLong ? "LONG" : "SHORT";
        const msg = NormalizedMessageSchema.parse({
          id: uuidv4(),
          createdAt: new Date().toISOString(),
          source: { module: "arbitrum-dex", stream: `gmx:${eventType}` },
          realtime: true,
          Message: `GMX ${eventType} ${direction} $${usdValue.toFixed(2)}${isWhale ? " [WHALE]" : ""} market=${market.slice(0, 10)}... tx=${log.transactionHash}`,
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          tags: {
            dex: "gmx_v2",
            chain: "arbitrum",
            event_type: eventType,
            market,
            account,
            is_long: isLong,
            is_whale: isWhale,
            tx_hash: log.transactionHash!,
            usd_value: usdValue,
          },
        });
        const ev = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: msg });
        params.nats.publish(subjectFor("arbitrum-dex", "messageCreated"), params.sc.encode(JSON.stringify(ev)));

        if (isWhale || eventType === "LiquidatePosition") {
          params.logger?.info?.({ eventType, direction, usdValue, account, tx: log.transactionHash }, "gmx position event");
        }
      } catch (err) {
        params.logger?.error?.({ err }, "arbitrum gmx listener error");
      }
    });

    params.logger?.info?.({ eventEmitter: GMX_EVENT_EMITTER }, "gmx v2 subscription active");
  };

  const ws = (provider as unknown as { _websocket?: WebSocket })._websocket;
  ws?.addEventListener?.("close", () => {
    params.logger?.warn?.("arbitrum-dex ws closed; attempting to reconnect in 3s");
    setTimeout(() => {
      try {
        subscribeUniswap();
        subscribeGmx();
      } catch {}
    }, 3000);
  });

  await subscribeUniswap();
  await subscribeGmx();

  params.logger?.info?.("arbitrum-dex listener fully initialized");
}
