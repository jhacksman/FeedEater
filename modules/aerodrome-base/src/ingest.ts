import { v5 as uuidv5 } from "uuid";
import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";
import { WebSocketProvider, JsonRpcProvider, Log, Interface, formatUnits } from "ethers";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type AerodromeBaseSettings = {
  enabled: boolean;
  rpcUrl: string;
  whaleThreshold: number;
  watchedPools: string;
};

const UUID_NAMESPACE = "b2c3d4e5-f6a7-8901-bcde-fa2345678901";

const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

const AERODROME_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)",
];
const aeroSwapIface = new Interface(AERODROME_SWAP_ABI);

const AERODROME_SWAP_TOPIC = aeroSwapIface.getEvent("Swap")!.topicHash;

const BASE_WETH = "0x4200000000000000000000000000000000000006".toLowerCase();
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const BASE_USDbC = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA".toLowerCase();
const BASE_cbETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22".toLowerCase();

const POOL_METADATA: Record<string, { token0: string; token1: string; token0Symbol: string; token1Symbol: string; token0Decimals: number; token1Decimals: number; stable: boolean }> = {
  "0xcdac0d6c6c59727a65f871236188350531885c43": {
    token0: BASE_WETH, token1: BASE_USDC,
    token0Symbol: "WETH", token1Symbol: "USDC",
    token0Decimals: 18, token1Decimals: 6, stable: false,
  },
  "0x6cdcb1c4a4d1c3c6d054b27ac5b77e89eafb971d": {
    token0: BASE_USDC, token1: BASE_USDbC,
    token0Symbol: "USDC", token1Symbol: "USDbC",
    token0Decimals: 6, token1Decimals: 6, stable: true,
  },
  "0x44ecc644449fc3a9858d2007caa8cfaa4c561f91": {
    token0: BASE_WETH, token1: BASE_cbETH,
    token0Symbol: "WETH", token1Symbol: "cbETH",
    token0Decimals: 18, token1Decimals: 18, stable: false,
  },
};

export function parseAerodromeBaseSettingsFromInternal(raw: Record<string, unknown>): AerodromeBaseSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const rpcUrl = String(raw.rpcUrl ?? "ws://192.168.0.134:8646");
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedPools = String(
    raw.watchedPools ??
      '["0xcDAC0d6c6C59727a65F871236188350531885C43","0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d","0x44Ecc644449fC3a9858d2007CaA8CFAa4C561f91"]'
  );

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('AerodromeBase setting "whaleThreshold" must be a positive number');
  }

  return { enabled, rpcUrl, whaleThreshold, watchedPools };
}

export function estimateUsdValue(
  amount0In: bigint,
  amount1In: bigint,
  amount0Out: bigint,
  amount1Out: bigint,
  token0: string,
  token1: string,
  token0Decimals: number,
  token1Decimals: number
): number {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();

  if (t0 === BASE_USDC || t0 === BASE_USDbC) {
    const inVal = Math.abs(Number(formatUnits(amount0In, token0Decimals)));
    const outVal = Math.abs(Number(formatUnits(amount0Out, token0Decimals)));
    return Math.max(inVal, outVal);
  }
  if (t1 === BASE_USDC || t1 === BASE_USDbC) {
    const inVal = Math.abs(Number(formatUnits(amount1In, token1Decimals)));
    const outVal = Math.abs(Number(formatUnits(amount1Out, token1Decimals)));
    return Math.max(inVal, outVal);
  }

  if (t0 === BASE_WETH) {
    const inVal = Math.abs(Number(formatUnits(amount0In, 18)));
    const outVal = Math.abs(Number(formatUnits(amount0Out, 18)));
    return Math.max(inVal, outVal) * 3000;
  }
  if (t1 === BASE_WETH) {
    const inVal = Math.abs(Number(formatUnits(amount1In, 18)));
    const outVal = Math.abs(Number(formatUnits(amount1Out, 18)));
    return Math.max(inVal, outVal) * 3000;
  }

  if (t0 === BASE_cbETH) {
    const inVal = Math.abs(Number(formatUnits(amount0In, 18)));
    const outVal = Math.abs(Number(formatUnits(amount0Out, 18)));
    return Math.max(inVal, outVal) * 3000;
  }
  if (t1 === BASE_cbETH) {
    const inVal = Math.abs(Number(formatUnits(amount1In, 18)));
    const outVal = Math.abs(Number(formatUnits(amount1Out, 18)));
    return Math.max(inVal, outVal) * 3000;
  }

  return 0;
}

export function determineSide(amount0In: bigint, amount1In: bigint): "buy" | "sell" {
  return amount0In > 0n ? "sell" : "buy";
}

export function computePrice(
  amount0In: bigint,
  amount1In: bigint,
  amount0Out: bigint,
  amount1Out: bigint,
  token0Decimals: number,
  token1Decimals: number
): number {
  const a0In = Math.abs(Number(formatUnits(amount0In, token0Decimals)));
  const a1In = Math.abs(Number(formatUnits(amount1In, token1Decimals)));
  const a0Out = Math.abs(Number(formatUnits(amount0Out, token0Decimals)));
  const a1Out = Math.abs(Number(formatUnits(amount1Out, token1Decimals)));

  const token0Amount = Math.max(a0In, a0Out);
  const token1Amount = Math.max(a1In, a1Out);

  if (token0Amount === 0) return 0;
  return token1Amount / token0Amount;
}

export class AerodromeBaseIngestor {
  private isStreaming = false;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
  private tradesCollected = 0;
  private messagesPublished = 0;
  private reconnectAttempts = 0;
  private activeProvider: WebSocketProvider | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.aerodrome-base.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "aerodrome-base",
            source: "collector",
            at: new Date().toISOString(),
            message,
            meta,
          })
        )
      );
    } catch {
      // ignore
    }
  }

  constructor(
    private readonly settings: AerodromeBaseSettings,
    private readonly db: DbLike,
    private readonly nats: NatsLike,
    private readonly sc: StringCodecLike
  ) {}

  async ensureSchema(): Promise<void> {
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_aerodrome_base");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_aerodrome_base.swaps (
        id text PRIMARY KEY,
        dex text NOT NULL,
        pool text NOT NULL,
        pair text NOT NULL,
        tx_hash text NOT NULL,
        block_number bigint NOT NULL,
        timestamp_ms bigint NOT NULL,
        amount0_in text NOT NULL,
        amount1_in text NOT NULL,
        amount0_out text NOT NULL,
        amount1_out text NOT NULL,
        side text NOT NULL,
        price numeric NOT NULL,
        usd_value numeric NOT NULL,
        sender text NOT NULL,
        recipient text NOT NULL,
        is_whale boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      "CREATE INDEX IF NOT EXISTS aero_swaps_pool_idx ON mod_aerodrome_base.swaps (pool, timestamp_ms)"
    );
    await this.db.query(
      "CREATE INDEX IF NOT EXISTS aero_swaps_whale_idx ON mod_aerodrome_base.swaps (is_whale)"
    );
  }

  private getPools(): string[] {
    try {
      return (JSON.parse(this.settings.watchedPools) as string[]).map((a) =>
        a.toLowerCase()
      );
    } catch {
      return [
        "0xcdac0d6c6c59727a65f871236188350531885c43",
        "0x6cdcb1c4a4d1c3c6d054b27ac5b77e89eafb971d",
        "0x44ecc644449fc3a9858d2007caa8cfaa4c561f91",
      ];
    }
  }

  private getPoolMeta(pool: string) {
    return POOL_METADATA[pool.toLowerCase()] ?? null;
  }

  private async storeSwap(swap: {
    id: string;
    pool: string;
    pair: string;
    txHash: string;
    blockNumber: number;
    timestampMs: number;
    amount0In: string;
    amount1In: string;
    amount0Out: string;
    amount1Out: string;
    side: string;
    price: number;
    usdValue: number;
    sender: string;
    recipient: string;
  }): Promise<void> {
    const isWhale = swap.usdValue >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_aerodrome_base.swaps (id, dex, pool, pair, tx_hash, block_number, timestamp_ms, amount0_in, amount1_in, amount0_out, amount1_out, side, price, usd_value, sender, recipient, is_whale)
         VALUES ($1, 'aerodrome', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO NOTHING`,
        [
          swap.id,
          swap.pool,
          swap.pair,
          swap.txHash,
          swap.blockNumber,
          swap.timestampMs,
          swap.amount0In,
          swap.amount1In,
          swap.amount0Out,
          swap.amount1Out,
          swap.side,
          swap.price,
          swap.usdValue,
          swap.sender,
          swap.recipient,
          isWhale,
        ]
      );
      this.tradesCollected++;

      const meta = this.getPoolMeta(swap.pool);
      const pairLabel = meta ? `${meta.token0Symbol}/${meta.token1Symbol}` : swap.pair;

      const messageId = uuidv5(`aero:swap:${swap.id}`, UUID_NAMESPACE);
      const normalized = NormalizedMessageSchema.parse({
        id: messageId,
        createdAt: new Date(swap.timestampMs).toISOString(),
        source: { module: "aerodrome-base", stream: `aerodrome:${swap.pool}` },
        realtime: true,
        Message: `Aerodrome Swap ${pairLabel} pool=${swap.pool.slice(0, 10)}... usd=$${swap.usdValue.toFixed(2)}${isWhale ? " [WHALE]" : ""} tx=${swap.txHash}`,
        From: "Base",
        isDirectMention: false,
        isDigest: false,
        isSystemMessage: false,
        likes: Math.floor(swap.usdValue),
        tags: {
          dex: "aerodrome",
          chain: "base",
          pool: swap.pool,
          pair: pairLabel,
          txHash: swap.txHash,
          usdValue: swap.usdValue,
          isWhale,
        },
      });

      const msgEvent = MessageCreatedEventSchema.parse({
        type: "MessageCreated",
        message: normalized,
      });

      this.nats.publish(
        subjectFor("aerodrome-base", "messageCreated"),
        this.sc.encode(JSON.stringify(msgEvent))
      );

      const token0Decimals = meta?.token0Decimals ?? 18;
      const size = Math.abs(
        Number(formatUnits(
          BigInt(swap.amount0In) > 0n ? BigInt(swap.amount0In) : BigInt(swap.amount0Out),
          token0Decimals
        ))
      );

      const tradeEvent = {
        source: "aerodrome-base",
        symbol: pairLabel,
        side: swap.side,
        price: swap.price,
        size,
        notional_usd: swap.usdValue,
        timestamp: new Date(swap.timestampMs).toISOString(),
        pool_address: swap.pool,
        tx_hash: swap.txHash,
        block_number: swap.blockNumber,
      };

      this.nats.publish(
        subjectFor("aerodrome-base", "tradeExecuted"),
        this.sc.encode(JSON.stringify(tradeEvent))
      );
      this.messagesPublished++;
    } catch (err) {
      this.log("error", "failed to store swap", {
        id: swap.id,
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  private subscribeToEvents(provider: WebSocketProvider, poolAddresses: string[]): void {
    if (poolAddresses.length > 0) {
      provider.on(
        { address: poolAddresses, topics: [[AERODROME_SWAP_TOPIC]] },
        async (log: Log) => {
          try {
            const p = this.activeProvider ?? provider;
            const block = await p.getBlock(log.blockHash!);
            const tsMs = Number(block!.timestamp) * 1000;

            let amount0In = 0n;
            let amount1In = 0n;
            let amount0Out = 0n;
            let amount1Out = 0n;
            let sender = "";
            let recipient = "";
            try {
              const ev = aeroSwapIface.parseLog({ topics: log.topics as string[], data: log.data });
              sender = (ev!.args[0] as string).toLowerCase();
              recipient = (ev!.args[1] as string).toLowerCase();
              amount0In = BigInt(ev!.args[2]);
              amount1In = BigInt(ev!.args[3]);
              amount0Out = BigInt(ev!.args[4]);
              amount1Out = BigInt(ev!.args[5]);
            } catch (e) {
              this.log("warn", "failed to decode aerodrome swap log", {
                tx: log.transactionHash,
              });
              return;
            }

            const pool = log.address.toLowerCase();
            const meta = this.getPoolMeta(pool);
            const token0 = meta?.token0 ?? BASE_WETH;
            const token1 = meta?.token1 ?? BASE_USDC;
            const token0Decimals = meta?.token0Decimals ?? 18;
            const token1Decimals = meta?.token1Decimals ?? 6;
            const pair = meta ? `${meta.token0Symbol}/${meta.token1Symbol}` : "UNKNOWN";

            const usdValue = estimateUsdValue(
              amount0In, amount1In, amount0Out, amount1Out,
              token0, token1, token0Decimals, token1Decimals
            );
            const side = determineSide(amount0In, amount1In);
            const price = computePrice(
              amount0In, amount1In, amount0Out, amount1Out,
              token0Decimals, token1Decimals
            );

            const swapId = uuidv5(
              `aero:swap:${log.transactionHash}:${log.index}`,
              UUID_NAMESPACE
            );

            await this.storeSwap({
              id: swapId,
              pool,
              pair,
              txHash: log.transactionHash!,
              blockNumber: log.blockNumber ?? 0,
              timestampMs: tsMs,
              amount0In: String(amount0In),
              amount1In: String(amount1In),
              amount0Out: String(amount0Out),
              amount1Out: String(amount1Out),
              side,
              price,
              usdValue,
              sender,
              recipient,
            });
          } catch (err) {
            this.log("error", "aerodrome listener error", {
              err: err instanceof Error ? err.message : err,
            });
          }
        }
      );
      this.log("info", "aerodrome swap subscription active", { poolCount: poolAddresses.length });
    }
  }

  private startHealthCheck(poolAddresses: string[]): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = setInterval(async () => {
      if (!this.isStreaming || !this.activeProvider) return;
      try {
        await this.activeProvider.getBlockNumber();
      } catch (err) {
        this.log("warn", "WebSocket health check failed, scheduling reconnect", {
          attempt: this.reconnectAttempts + 1,
          maxAttempts: 10,
          err: err instanceof Error ? err.message : err,
        });
        if (this.healthCheckTimer) {
          clearInterval(this.healthCheckTimer);
          this.healthCheckTimer = null;
        }
        try {
          this.activeProvider.removeAllListeners();
          await this.activeProvider.destroy();
        } catch { /* ignore */ }
        this.activeProvider = null;
        this.scheduleReconnect(poolAddresses);
      }
    }, 15000);
  }

  private scheduleReconnect(poolAddresses: string[]): void {
    if (!this.isStreaming) return;
    if (this.reconnectAttempts >= 10) {
      this.log("error", "max WebSocket reconnect attempts (10) exhausted", {
        attempts: this.reconnectAttempts,
      });
      return;
    }
    this.reconnectAttempts++;
    this.log("warn", `WebSocket disconnected, reconnecting in 5000ms (attempt ${this.reconnectAttempts}/10)`, {
      attempt: this.reconnectAttempts,
      maxAttempts: 10,
      rpcUrl: this.settings.rpcUrl,
    });
    setTimeout(async () => {
      if (!this.isStreaming) return;
      try {
        const provider = new WebSocketProvider(this.settings.rpcUrl);
        this.activeProvider = provider;
        this.subscribeToEvents(provider, poolAddresses);
        this.startHealthCheck(poolAddresses);
        this.log("info", "WebSocket reconnected successfully", {
          attempt: this.reconnectAttempts,
        });
        this.reconnectAttempts = 0;
      } catch (err) {
        this.log("warn", "WebSocket reconnection failed", {
          attempt: this.reconnectAttempts,
          err: err instanceof Error ? err.message : err,
        });
        this.scheduleReconnect(poolAddresses);
      }
    }, 5000);
  }

  async startStreaming(): Promise<{
    tradesCollected: number;
    messagesPublished: number;
  }> {
    this.isStreaming = true;
    this.tradesCollected = 0;
    this.messagesPublished = 0;
    this.reconnectAttempts = 0;

    const poolAddresses = this.getPools();
    this.log("info", "starting WebSocket stream", {
      pools: poolAddresses.length,
      rpcUrl: this.settings.rpcUrl,
    });

    let provider: WebSocketProvider;
    try {
      provider = new WebSocketProvider(this.settings.rpcUrl);
    } catch (err) {
      this.log("error", "failed to create WebSocket provider", {
        err: err instanceof Error ? err.message : err,
      });
      this.isStreaming = false;
      return { tradesCollected: 0, messagesPublished: 0 };
    }

    this.activeProvider = provider;
    this.subscribeToEvents(provider, poolAddresses);
    this.startHealthCheck(poolAddresses);

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.isStreaming) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);

      setTimeout(() => {
        this.isStreaming = false;
        clearInterval(checkInterval);
        resolve();
      }, 55000);
    });

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    try {
      const p = this.activeProvider ?? provider;
      p.removeAllListeners();
      await p.destroy();
    } catch {
      // ignore
    }
    this.activeProvider = null;
    this.isStreaming = false;

    return {
      tradesCollected: this.tradesCollected,
      messagesPublished: this.messagesPublished,
    };
  }

  async collectRecentSwaps(params: {
    lookbackBlocks: number;
  }): Promise<{ tradesCollected: number; messagesPublished: number }> {
    this.tradesCollected = 0;
    this.messagesPublished = 0;

    const isWss = this.settings.rpcUrl.startsWith("wss://") || this.settings.rpcUrl.startsWith("ws://");
    const provider = isWss
      ? new WebSocketProvider(this.settings.rpcUrl)
      : new JsonRpcProvider(this.settings.rpcUrl);

    try {
      const latestBlock = await provider.getBlockNumber();
      const fromBlock = latestBlock - params.lookbackBlocks;
      const poolAddresses = this.getPools();

      if (poolAddresses.length === 0) {
        this.log("warn", "no aerodrome pools configured for REST collection");
        return { tradesCollected: 0, messagesPublished: 0 };
      }

      this.log("info", "collecting recent swaps", {
        fromBlock,
        toBlock: latestBlock,
        pools: poolAddresses.length,
      });

      const logs = await provider.getLogs({
        address: poolAddresses,
        topics: [[AERODROME_SWAP_TOPIC]],
        fromBlock,
        toBlock: latestBlock,
      });

      for (const log of logs) {
        try {
          const ev = aeroSwapIface.parseLog({ topics: log.topics as string[], data: log.data });
          const sender = (ev!.args[0] as string).toLowerCase();
          const recipient = (ev!.args[1] as string).toLowerCase();
          const amount0In = BigInt(ev!.args[2]);
          const amount1In = BigInt(ev!.args[3]);
          const amount0Out = BigInt(ev!.args[4]);
          const amount1Out = BigInt(ev!.args[5]);

          const pool = log.address.toLowerCase();
          const meta = this.getPoolMeta(pool);
          const token0 = meta?.token0 ?? BASE_WETH;
          const token1 = meta?.token1 ?? BASE_USDC;
          const token0Decimals = meta?.token0Decimals ?? 18;
          const token1Decimals = meta?.token1Decimals ?? 6;
          const pair = meta ? `${meta.token0Symbol}/${meta.token1Symbol}` : "UNKNOWN";

          const usdValue = estimateUsdValue(
            amount0In, amount1In, amount0Out, amount1Out,
            token0, token1, token0Decimals, token1Decimals
          );
          const side = determineSide(amount0In, amount1In);
          const price = computePrice(
            amount0In, amount1In, amount0Out, amount1Out,
            token0Decimals, token1Decimals
          );

          const block = await provider.getBlock(log.blockHash!);
          const tsMs = Number(block!.timestamp) * 1000;

          const swapId = uuidv5(
            `aero:swap:${log.transactionHash}:${log.index}`,
            UUID_NAMESPACE
          );

          await this.storeSwap({
            id: swapId,
            pool,
            pair,
            txHash: log.transactionHash!,
            blockNumber: log.blockNumber ?? 0,
            timestampMs: tsMs,
            amount0In: String(amount0In),
            amount1In: String(amount1In),
            amount0Out: String(amount0Out),
            amount1Out: String(amount1Out),
            side,
            price,
            usdValue,
            sender,
            recipient,
          });
        } catch (err) {
          this.log("error", "failed to process historical swap log", {
            tx: log.transactionHash,
            err: err instanceof Error ? err.message : err,
          });
        }
      }
    } finally {
      try {
        provider.destroy();
      } catch {
        // ignore
      }
    }

    this.log("info", "recent swap collection complete", {
      tradesCollected: this.tradesCollected,
      messagesPublished: this.messagesPublished,
    });

    return { tradesCollected: this.tradesCollected, messagesPublished: this.messagesPublished };
  }
}
