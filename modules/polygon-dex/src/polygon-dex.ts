import { WebSocketProvider, Log, Interface, formatUnits } from "ethers";
import type { NatsConnection, Codec } from "nats";
import { v4 as uuidv4 } from "uuid";
import { NormalizedMessageSchema, MessageCreatedEventSchema, subjectFor } from "@feedeater/core";
import { PrismaClient } from "@prisma/client";

const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const V3_ABI = [
  "event Swap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];
const v3Iface = new Interface(V3_ABI);

const POLYMARKET_CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const POLYMARKET_NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

const MARKET_RESOLVED_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const CONDITION_RESOLUTION_TOPIC = "0xb3a93f5be37a3c147e75c9f3a8c7e7f5e8d8e9a0b1c2d3e4f5a6b7c8d9e0f1a2";
const PAYOUT_REDEMPTION_TOPIC = "0x2682012a4a4f1973119f1c9b90745d1bd91fa2e5e0e5e5e5e5e5e5e5e5e5e5e5";

const CTF_ABI = [
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)",
  "event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)"
];
const ctfIface = new Interface(CTF_ABI);

const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359".toLowerCase();
const POLYGON_USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase();
const POLYGON_WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619".toLowerCase();
const POLYGON_WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase();

export async function createPolygonDexListener(params: {
  nats: NatsConnection;
  sc: Codec<string>;
  getSetting: (k: string) => Promise<string | boolean | number | undefined>;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}) {
  const prisma = new PrismaClient();
  const rpcUrl = (await params.getSetting("rpcUrl")) as string;
  const whaleThreshold = Number((await params.getSetting("whaleThreshold")) ?? 50000);
  const enablePolymarketSettlements = (await params.getSetting("enablePolymarketSettlements")) !== false;

  const watchedPoolsSetting = await params.getSetting("watchedQuickswapPools");
  const watchedPools: string[] = Array.isArray(watchedPoolsSetting)
    ? (watchedPoolsSetting as string[])
    : typeof watchedPoolsSetting === "string" && watchedPoolsSetting.trim().startsWith("[")
      ? JSON.parse(watchedPoolsSetting)
      : [];
  const poolAddresses = watchedPools.map((a) => a.toLowerCase());

  params.logger?.info?.({ rpcUrl, poolAddresses, enablePolymarketSettlements, whaleThreshold }, "polygon-dex listener starting");

  const provider = new WebSocketProvider(rpcUrl);

  const subscribeQuickswap = async () => {
    if (poolAddresses.length === 0) {
      params.logger?.warn?.("no quickswap pools configured, skipping quickswap subscription");
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
          params.logger?.warn?.({ e, tx: log.transactionHash }, "failed to decode quickswap v3 swap log");
          return;
        }

        const pool = log.address.toLowerCase();
        let usdValue = 0;

        if (pool === "0x45dda9cb7c25131df268515131f647d726f50608") {
          usdValue = Math.abs(Number(formatUnits(amount1, 6)));
        } else if (pool === "0xae81fac689a1b4b1e06e7ef4a2ab4cd8ac0a087d") {
          usdValue = Math.abs(Number(formatUnits(amount1, 6)));
        } else {
          const a0Abs = Math.abs(Number(formatUnits(amount0, 18)));
          const a1Abs = Math.abs(Number(formatUnits(amount1, 6)));
          usdValue = Math.max(a0Abs * 3000, a1Abs);
        }

        const isWhale = usdValue >= whaleThreshold;

        await prisma.polygonSwap.create({
          data: {
            chain: "polygon",
            dex: "quickswap_v3",
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
          source: { module: "polygon-dex", stream: `quickswap:${pool}` },
          realtime: true,
          Message: `QuickSwap V3 Swap on Polygon pool=${pool.slice(0, 10)}... usd=$${usdValue.toFixed(2)}${isWhale ? " [WHALE]" : ""} tx=${log.transactionHash}`,
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          tags: {
            dex: "quickswap_v3",
            chain: "polygon",
            pool,
            is_whale: isWhale,
            tx_hash: log.transactionHash!,
            usd_value: usdValue,
          },
        });
        const ev = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: msg });
        params.nats.publish(subjectFor("polygon-dex", "messageCreated"), params.sc.encode(JSON.stringify(ev)));

        if (isWhale) {
          params.logger?.info?.({ pool, usdValue, tx: log.transactionHash }, "whale swap detected on quickswap");
        }
      } catch (err) {
        params.logger?.error?.({ err }, "polygon quickswap listener error");
      }
    });

    params.logger?.info?.({ poolCount: poolAddresses.length }, "quickswap v3 subscription active");
  };

  const subscribePolymarketSettlements = async () => {
    if (!enablePolymarketSettlements) {
      params.logger?.info?.("polymarket settlements subscription disabled");
      return;
    }

    const ctfAddresses = [POLYMARKET_CTF_EXCHANGE, POLYMARKET_NEG_RISK_CTF_EXCHANGE];

    provider.on({ address: ctfAddresses }, async (log: Log) => {
      try {
        const block = await provider.getBlock(log.blockHash!);
        const tsMs = Number(block!.timestamp) * 1000;

        const topic0 = log.topics[0]?.toLowerCase();

        let eventType = "unknown";
        let conditionId = "";
        let questionId = "";
        let payoutNumerators = "";
        let redeemer = "";
        let collateralToken = "";
        let indexSets = "";
        let payout = 0n;

        try {
          if (topic0 === CONDITION_RESOLUTION_TOPIC.toLowerCase() || log.topics.length >= 3) {
            try {
              const ev = ctfIface.parseLog({ topics: log.topics, data: log.data });
              if (ev?.name === "ConditionResolution") {
                eventType = "MarketResolved";
                conditionId = ev.args[0];
                questionId = ev.args[2];
                payoutNumerators = JSON.stringify(ev.args[4].map((n: bigint) => n.toString()));
              } else if (ev?.name === "PayoutRedemption") {
                eventType = "PayoutRedemption";
                redeemer = ev.args[0];
                collateralToken = ev.args[1];
                conditionId = ev.args[3];
                indexSets = JSON.stringify(ev.args[4].map((n: bigint) => n.toString()));
                payout = BigInt(ev.args[5]);
              }
            } catch {
              if (log.data.length > 66) {
                eventType = "SettlementEvent";
                conditionId = log.topics[1] ?? "";
              }
            }
          }
        } catch (e) {
          params.logger?.warn?.({ e, tx: log.transactionHash, topic0 }, "failed to decode polymarket settlement log");
          return;
        }

        if (eventType === "unknown") {
          return;
        }

        const payoutUsd = Number(formatUnits(payout, 6));
        const isWhale = payoutUsd >= whaleThreshold;

        await prisma.polymarketSettlement.create({
          data: {
            eventType,
            txHash: log.transactionHash!,
            block: BigInt(log.blockNumber ?? 0),
            timestampMs: BigInt(tsMs),
            conditionId,
            questionId: questionId || null,
            payoutNumerators: payoutNumerators || null,
            redeemer: redeemer || null,
            collateralToken: collateralToken || null,
            indexSets: indexSets || null,
            payout: payout > 0n ? String(payout) : null,
            isWhale,
          },
        });

        const msg = NormalizedMessageSchema.parse({
          id: uuidv4(),
          createdAt: new Date().toISOString(),
          source: { module: "polygon-dex", stream: `polymarket:${eventType}` },
          realtime: true,
          Message: `Polymarket ${eventType} conditionId=${conditionId.slice(0, 16)}...${payoutUsd > 0 ? ` payout=$${payoutUsd.toFixed(2)}` : ""}${isWhale ? " [WHALE]" : ""} tx=${log.transactionHash}`,
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          tags: {
            dex: "polymarket_ctf",
            chain: "polygon",
            event_type: eventType,
            condition_id: conditionId,
            is_whale: isWhale,
            tx_hash: log.transactionHash!,
            payout_usd: payoutUsd,
          },
        });
        const ev = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: msg });
        params.nats.publish(subjectFor("polygon-dex", "messageCreated"), params.sc.encode(JSON.stringify(ev)));

        if (isWhale || eventType === "MarketResolved") {
          params.logger?.info?.({ eventType, conditionId, payoutUsd, tx: log.transactionHash }, "polymarket settlement event");
        }
      } catch (err) {
        params.logger?.error?.({ err }, "polygon polymarket listener error");
      }
    });

    params.logger?.info?.({ ctfAddresses }, "polymarket ctf exchange subscription active");
  };

  const ws = (provider as unknown as { _websocket?: WebSocket })._websocket;
  ws?.addEventListener?.("close", () => {
    params.logger?.warn?.("polygon-dex ws closed; attempting to reconnect in 3s");
    setTimeout(() => {
      try {
        subscribeQuickswap();
        subscribePolymarketSettlements();
      } catch {}
    }, 3000);
  });

  await subscribeQuickswap();
  await subscribePolymarketSettlements();

  params.logger?.info?.("polygon-dex listener fully initialized");
}
