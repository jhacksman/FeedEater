import { WebSocketProvider, Log, Interface, formatUnits } from "ethers";
import type { NatsConnection, StringCodec } from "nats";
import { v4 as uuidv4 } from "uuid";
import { NormalizedMessageSchema, MessageCreatedEventSchema, subjectFor } from "@feedeater/core";
import { PrismaClient } from "@prisma/client";

const V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const V2_ABI = [
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];
const V3_ABI = [
  "event Swap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];
const v2Iface = new Interface(V2_ABI);
const v3Iface = new Interface(V3_ABI);

export async function createUniswapListener(params: {
  nats: NatsConnection;
  sc: StringCodec;
  getSetting: (k: string) => Promise<string | boolean | number | undefined>;
  logger?: any;
}) {
  const prisma = new PrismaClient();
  const rpcUrl = (await params.getSetting("rpcUrl")) as string;
  const whaleThreshold = Number((await params.getSetting("whaleThreshold")) ?? 50000);
  const watchedPairsSetting = (await params.getSetting("watchedPairs"));
  const watchedPairs: string[] = Array.isArray(watchedPairsSetting)
    ? (watchedPairsSetting as string[])
    : typeof watchedPairsSetting === "string" && watchedPairsSetting.trim().startsWith("[")
      ? JSON.parse(watchedPairsSetting)
      : [];
  const addresses = watchedPairs.map((a) => a.toLowerCase());

  const provider = new WebSocketProvider(rpcUrl);

  const subscribe = async () => {
    const topics = [[V2_SWAP_TOPIC, V3_SWAP_TOPIC]];
    provider.on({ address: addresses, topics }, async (log: Log) => {
      try {
        const block = await provider.getBlock(log.blockHash!);
        const tsMs = Number(block!.timestamp) * 1000;
        const tx = await provider.getTransaction(log.transactionHash!);

        let amount0 = 0n, amount1 = 0n, dex = "uniswap_v2";
        try {
          if (log.topics[0].toLowerCase() === V2_SWAP_TOPIC) {
            const ev = v2Iface.parseLog({ topics: log.topics, data: log.data });
            const a0In = BigInt(ev.args[1]);
            const a1In = BigInt(ev.args[2]);
            const a0Out = BigInt(ev.args[3]);
            const a1Out = BigInt(ev.args[4]);
            amount0 = a0Out - a0In;
            amount1 = a1Out - a1In;
            dex = "uniswap_v2";
          } else {
            const ev = v3Iface.parseLog({ topics: log.topics, data: log.data });
            amount0 = BigInt(ev.args[2]);
            amount1 = BigInt(ev.args[3]);
            dex = "uniswap_v3";
          }
        } catch (e) {
          params.logger?.warn?.({ e, tx: log.transactionHash }, "failed to decode swap log");
          return;
        }

        const pair = log.address.toLowerCase();
        let usdValue = 0;
        if (pair === "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640") {
          usdValue = Math.abs(Number(formatUnits(amount1, 6))); // USDC
        } else if (pair === "0x11b815efb8f581194ae5486326430326078df15a") {
          usdValue = Math.abs(Number(formatUnits(amount1, 6))); // USDT
        } else if (pair === "0xcbcdf9626bc03e24f779434178a73a0b4bad62ed") {
          const wethLeg = Math.abs(Number(formatUnits(amount1, 18)));
          const approxWethUsd = 3000; // TODO: improve with cached price
          usdValue = Math.round(wethLeg * approxWethUsd);
        }

        const isWhale = usdValue >= whaleThreshold;

        await prisma.dexSwap.create({
          data: {
            chain: "ethereum",
            dex,
            pair,
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
          source: { module: "uniswap", stream: pair },
          realtime: true,
          Message: `Swap on ${dex} ${pair} usd=$${usdValue.toFixed(2)} tx=${log.transactionHash}`,
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          tags: { dex: "uniswap", pair, is_whale: isWhale, tx_hash: log.transactionHash },
        });
        const ev = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: msg });
        params.nats.publish(subjectFor("uniswap", "messageCreated"), params.sc.encode(JSON.stringify(ev)));
      } catch (err) {
        params.logger?.error?.({ err }, "uniswap listener error");
      }
    });
  };

  provider._websocket?.addEventListener?.("close", () => {
    params.logger?.warn?.("uniswap ws closed; attempting to reconnect in 3s");
    setTimeout(() => {
      try { subscribe(); } catch {}
    }, 3000);
  });

  await subscribe();
}
