import { v5 as uuidv5 } from "uuid";
import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";
import { WebSocketProvider, JsonRpcProvider, Log, Interface, formatUnits } from "ethers";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type UniswapBaseSettings = {
  enabled: boolean;
  rpcUrl: string;
  whaleThreshold: number;
  watchedUniswapPools: string;
};

const UUID_NAMESPACE = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";

const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V3_POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

const V3_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];
const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];
const v3Iface = new Interface(V3_ABI);
const v3FactoryIface = new Interface(V3_FACTORY_ABI);

const BASE_WETH = "0x4200000000000000000000000000000000000006".toLowerCase();
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const BASE_USDbC = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA".toLowerCase();
const BASE_WBTC = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c".toLowerCase();
const BASE_DAI = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb".toLowerCase();

const WETH_USDC_005_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224".toLowerCase();
const WETH_USDC_030_POOL = "0x6c561B446416E1A00E8E93E221854d6eA4171372".toLowerCase();

export function parseUniswapBaseSettingsFromInternal(raw: Record<string, unknown>): UniswapBaseSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const rpcUrl = String(raw.rpcUrl ?? "ws://192.168.0.134:8646");
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedUniswapPools = String(
    raw.watchedUniswapPools ??
      '["0xd0b53D9277642d899DF5C87A3966A349A798F224","0x6c561B446416E1A00E8E93E221854d6eA4171372"]'
  );

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('UniswapBase setting "whaleThreshold" must be a positive number');
  }

  return { enabled, rpcUrl, whaleThreshold, watchedUniswapPools };
}

export class UniswapBaseIngestor {
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
        "feedeater.uniswap-base.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "uniswap-base",
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
    private readonly settings: UniswapBaseSettings,
    private readonly db: DbLike,
    private readonly nats: NatsLike,
    private readonly sc: StringCodecLike
  ) {}

  async ensureSchema(): Promise<void> {
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_uniswap_base");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_uniswap_base.swaps (
        id text PRIMARY KEY,
        dex text NOT NULL,
        pool text NOT NULL,
        tx_hash text NOT NULL,
        block_number bigint NOT NULL,
        timestamp_ms bigint NOT NULL,
        token0_amount text NOT NULL,
        token1_amount text NOT NULL,
        usd_value numeric NOT NULL,
        sender text NOT NULL,
        is_whale boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      "CREATE INDEX IF NOT EXISTS base_swaps_pool_idx ON mod_uniswap_base.swaps (pool, timestamp_ms)"
    );
  }

  private getPools(): string[] {
    try {
      return (JSON.parse(this.settings.watchedUniswapPools) as string[]).map((a) =>
        a.toLowerCase()
      );
    } catch {
      return [
        WETH_USDC_005_POOL,
        WETH_USDC_030_POOL,
      ];
    }
  }

  private estimateUsdValue(pool: string, amount0: bigint, amount1: bigint): number {
    const p = pool.toLowerCase();
    if (p === WETH_USDC_005_POOL || p === WETH_USDC_030_POOL) {
      return Math.abs(Number(formatUnits(amount1, 6)));
    }
    const a0Abs = Math.abs(Number(formatUnits(amount0, 18)));
    const a1Abs = Math.abs(Number(formatUnits(amount1, 6)));
    return Math.max(a0Abs * 3000, a1Abs);
  }

  private computePriceFromSqrtPriceX96(sqrtPriceX96: bigint, token0Decimals: number, token1Decimals: number): number {
    const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
    const price = sqrtPrice * sqrtPrice;
    const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
    return price * decimalAdjustment;
  }

  private getPoolLabel(pool: string): string {
    const p = pool.toLowerCase();
    if (p === WETH_USDC_005_POOL || p === WETH_USDC_030_POOL) return "WETH/USDC";
    return "UNKNOWN";
  }

  private async storeSwap(swap: {
    id: string;
    pool: string;
    txHash: string;
    blockNumber: number;
    timestampMs: number;
    token0Amount: string;
    token1Amount: string;
    usdValue: number;
    sender: string;
    sqrtPriceX96: bigint;
  }): Promise<void> {
    const isWhale = swap.usdValue >= this.settings.whaleThreshold;
    const pairLabel = this.getPoolLabel(swap.pool);

    try {
      await this.db.query(
        `INSERT INTO mod_uniswap_base.swaps (id, dex, pool, tx_hash, block_number, timestamp_ms, token0_amount, token1_amount, usd_value, sender, is_whale)
         VALUES ($1, 'uniswap_v3', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          swap.id,
          swap.pool,
          swap.txHash,
          swap.blockNumber,
          swap.timestampMs,
          swap.token0Amount,
          swap.token1Amount,
          swap.usdValue,
          swap.sender,
          isWhale,
        ]
      );
      this.tradesCollected++;

      const messageId = uuidv5(`base:swap:${swap.id}`, UUID_NAMESPACE);
      const normalized = NormalizedMessageSchema.parse({
        id: messageId,
        createdAt: new Date(swap.timestampMs).toISOString(),
        source: { module: "uniswap-base", stream: `uniswap:${swap.pool}` },
        realtime: true,
        Message: `Uniswap V3 Base Swap ${pairLabel} pool=${swap.pool.slice(0, 10)}... usd=$${swap.usdValue.toFixed(2)} tx=${swap.txHash}`,
        From: "Base",
        isDirectMention: false,
        isDigest: false,
        isSystemMessage: false,
        likes: Math.floor(swap.usdValue),
        tags: {
          dex: "uniswap_v3",
          chain: "base",
          pool: swap.pool,
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
        subjectFor("uniswap-base", "messageCreated"),
        this.sc.encode(JSON.stringify(msgEvent))
      );

      const price = this.computePriceFromSqrtPriceX96(swap.sqrtPriceX96, 18, 6);

      const tradeEvent = {
        source: "uniswap-base",
        symbol: pairLabel,
        side: BigInt(swap.token0Amount) > 0n ? "sell" : "buy" as "buy" | "sell",
        price: price > 0 ? price : swap.usdValue / Math.abs(Number(swap.token0Amount) / 1e18 || 1),
        size: Math.abs(Number(swap.token0Amount) / 1e18),
        notional_usd: swap.usdValue,
        timestamp: new Date(swap.timestampMs).toISOString(),
        pool_address: swap.pool,
        tx_hash: swap.txHash,
        block_number: swap.blockNumber,
      };

      this.nats.publish(
        subjectFor("uniswap-base", "tradeExecuted"),
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
        { address: poolAddresses, topics: [[V3_SWAP_TOPIC]] },
        async (log: Log) => {
          try {
            const p = this.activeProvider ?? provider;
            const block = await p.getBlock(log.blockHash!);
            const tsMs = Number(block!.timestamp) * 1000;
            const tx = await p.getTransaction(log.transactionHash!);

            let amount0 = 0n;
            let amount1 = 0n;
            let sqrtPriceX96 = 0n;
            try {
              const ev = v3Iface.parseLog({ topics: log.topics as string[], data: log.data });
              amount0 = BigInt(ev!.args[2]);
              amount1 = BigInt(ev!.args[3]);
              sqrtPriceX96 = BigInt(ev!.args[4]);
            } catch (e) {
              this.log("warn", "failed to decode uniswap v3 swap log", {
                tx: log.transactionHash,
              });
              return;
            }

            const pool = log.address.toLowerCase();
            const usdValue = this.estimateUsdValue(pool, amount0, amount1);
            const swapId = uuidv5(
              `base:uniswap:${log.transactionHash}:${log.index}`,
              UUID_NAMESPACE
            );

            await this.storeSwap({
              id: swapId,
              pool,
              txHash: log.transactionHash!,
              blockNumber: log.blockNumber ?? 0,
              timestampMs: tsMs,
              token0Amount: String(amount0),
              token1Amount: String(amount1),
              usdValue,
              sender: tx?.from?.toLowerCase() ?? "0x",
              sqrtPriceX96,
            });
          } catch (err) {
            this.log("error", "uniswap listener error", {
              tx: log.transactionHash,
              err: err instanceof Error ? err.message : err,
            });
          }
        }
      );
    }

    provider.on(
      { address: UNISWAP_V3_FACTORY, topics: [[V3_POOL_CREATED_TOPIC]] },
      (log: Log) => {
        try {
          const ev = v3FactoryIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (!ev) return;
          const token0 = (ev.args[0] as string).toLowerCase();
          const token1 = (ev.args[1] as string).toLowerCase();
          const fee = Number(ev.args[2]);
          const poolAddr = (ev.args[4] as string).toLowerCase();
          this.log("info", "new pool discovered", { token0, token1, fee, pool: poolAddr });
        } catch (err) {
          this.log("warn", "failed to decode PoolCreated", {
            err: err instanceof Error ? err.message : err,
          });
        }
      }
    );
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
      }, 5000);

      setTimeout(() => {
        this.isStreaming = false;
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

    return {
      tradesCollected: this.tradesCollected,
      messagesPublished: this.messagesPublished,
    };
  }

  async collectRecentSwaps(opts: { lookbackBlocks: number }): Promise<{
    tradesCollected: number;
    messagesPublished: number;
  }> {
    this.tradesCollected = 0;
    this.messagesPublished = 0;

    const poolAddresses = this.getPools();
    let provider: JsonRpcProvider;
    try {
      const httpUrl = this.settings.rpcUrl
        .replace("ws://", "http://")
        .replace("wss://", "https://");
      provider = new JsonRpcProvider(httpUrl);
    } catch (err) {
      this.log("error", "failed to create JSON-RPC provider", {
        err: err instanceof Error ? err.message : err,
      });
      return { tradesCollected: 0, messagesPublished: 0 };
    }

    try {
      const latestBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, latestBlock - opts.lookbackBlocks);

      this.log("info", "collecting recent swaps", {
        fromBlock,
        toBlock: latestBlock,
        pools: poolAddresses.length,
      });

      const logs = await provider.getLogs({
        address: poolAddresses,
        topics: [[V3_SWAP_TOPIC]],
        fromBlock,
        toBlock: latestBlock,
      });

      for (const log of logs) {
        try {
          const ev = v3Iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (!ev) continue;

          const amount0 = BigInt(ev.args[2]);
          const amount1 = BigInt(ev.args[3]);
          const sqrtPriceX96 = BigInt(ev.args[4]);
          const pool = log.address.toLowerCase();
          const usdValue = this.estimateUsdValue(pool, amount0, amount1);

          const swapId = uuidv5(
            `base:uniswap:${log.transactionHash}:${log.index}`,
            UUID_NAMESPACE
          );

          const block = await provider.getBlock(log.blockNumber);
          const tsMs = block ? Number(block.timestamp) * 1000 : Date.now();
          const tx = await provider.getTransaction(log.transactionHash!);

          await this.storeSwap({
            id: swapId,
            pool,
            txHash: log.transactionHash!,
            blockNumber: log.blockNumber ?? 0,
            timestampMs: tsMs,
            token0Amount: String(amount0),
            token1Amount: String(amount1),
            usdValue,
            sender: tx?.from?.toLowerCase() ?? "0x",
            sqrtPriceX96,
          });
        } catch (err) {
          this.log("warn", "failed to process swap log", {
            tx: log.transactionHash,
            err: err instanceof Error ? err.message : err,
          });
        }
      }
    } catch (err) {
      this.log("error", "collectRecentSwaps failed", {
        err: err instanceof Error ? err.message : err,
      });
    }

    return {
      tradesCollected: this.tradesCollected,
      messagesPublished: this.messagesPublished,
    };
  }
}
