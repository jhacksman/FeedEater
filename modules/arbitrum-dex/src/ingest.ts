import { v5 as uuidv5 } from "uuid";
import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";
import { WebSocketProvider, JsonRpcProvider, Log, Interface, formatUnits } from "ethers";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type ArbitrumDexSettings = {
  enabled: boolean;
  rpcUrl: string;
  whaleThreshold: number;
  watchedUniswapPools: string;
  enableGmx: boolean;
};

const UUID_NAMESPACE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V3_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];
const v3Iface = new Interface(V3_ABI);

const GMX_EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";
const GMX_ROUTER = "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8";

const GMX_POSITION_INCREASE_TOPIC = "0x137a44067c8961cd7e1d876f4754a5a3a75989b4552f1843fc69c3b372def160";
const GMX_POSITION_DECREASE_TOPIC = "0x137a44067c8961cd7e1d876f4754a5a3a75989b4552f1843fc69c3b372def161";

const GMX_POSITION_ABI = [
  "event PositionIncrease(bytes32 indexed key, address account, address market, address collateralToken, bool isLong, uint256 executionPrice, uint256 sizeDeltaUsd, uint256 sizeDeltaInTokens, int256 collateralDeltaAmount, int256 borrowingFactor, int256 fundingFeeAmountPerSize, int256 longTokenClaimableFundingAmountPerSize, int256 shortTokenClaimableFundingAmountPerSize, uint256 priceImpactUsd, bytes32 orderType)",
  "event PositionDecrease(bytes32 indexed key, address account, address market, address collateralToken, bool isLong, uint256 executionPrice, uint256 sizeDeltaUsd, uint256 sizeDeltaInTokens, int256 collateralDeltaAmount, int256 borrowingFactor, int256 fundingFeeAmountPerSize, int256 longTokenClaimableFundingAmountPerSize, int256 shortTokenClaimableFundingAmountPerSize, uint256 priceImpactUsd, bytes32 orderType)",
];
const gmxIface = new Interface(GMX_POSITION_ABI);

export function parseArbitrumDexSettingsFromInternal(raw: Record<string, unknown>): ArbitrumDexSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const rpcUrl = String(
    raw.rpcUrl ?? "wss://arbitrum-mainnet.infura.io/ws/v3/YOUR_KEY"
  );
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedUniswapPools = String(
    raw.watchedUniswapPools ??
      '["0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443","0xC6962004f452bE9203591991D15f6b388e09E8D0","0x641C00A822e8b671738d32a431a4Fb6074E5c79d"]'
  );
  const enableGmx = String(raw.enableGmx ?? "true") === "true";

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('ArbitrumDex setting "whaleThreshold" must be a positive number');
  }

  return { enabled, rpcUrl, whaleThreshold, watchedUniswapPools, enableGmx };
}

export class ArbitrumDexIngestor {
  private isStreaming = false;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
  private tradesCollected = 0;
  private gmxEventsCollected = 0;
  private messagesPublished = 0;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.arbitrum-dex.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "arbitrum-dex",
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
    private readonly settings: ArbitrumDexSettings,
    private readonly db: DbLike,
    private readonly nats: NatsLike,
    private readonly sc: StringCodecLike
  ) {}

  async ensureSchema(): Promise<void> {
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_arbitrum_dex");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_arbitrum_dex.swaps (
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
      "CREATE INDEX IF NOT EXISTS arb_swaps_pool_idx ON mod_arbitrum_dex.swaps (pool, timestamp_ms)"
    );

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_arbitrum_dex.gmx_positions (
        id text PRIMARY KEY,
        event_type text NOT NULL,
        tx_hash text NOT NULL,
        block_number bigint NOT NULL,
        timestamp_ms bigint NOT NULL,
        account text NOT NULL,
        market text NOT NULL,
        collateral_token text NOT NULL,
        size_in_usd text NOT NULL,
        size_in_tokens text NOT NULL,
        collateral_amount text NOT NULL,
        is_long boolean NOT NULL,
        is_whale boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      "CREATE INDEX IF NOT EXISTS arb_gmx_account_idx ON mod_arbitrum_dex.gmx_positions (account, timestamp_ms)"
    );
    await this.db.query(
      "CREATE INDEX IF NOT EXISTS arb_gmx_market_idx ON mod_arbitrum_dex.gmx_positions (market, timestamp_ms)"
    );
  }

  private getPools(): string[] {
    try {
      return (JSON.parse(this.settings.watchedUniswapPools) as string[]).map((a) =>
        a.toLowerCase()
      );
    } catch {
      return [
        "0xc31e54c7a869b9fcbecc14363cf510d1c41fa443",
        "0xc6962004f452be9203591991d15f6b388e09e8d0",
        "0x641c00a822e8b671738d32a431a4fb6074e5c79d",
      ];
    }
  }

  private estimateUsdValue(pool: string, amount0: bigint, amount1: bigint): number {
    const p = pool.toLowerCase();
    if (
      p === "0xc31e54c7a869b9fcbecc14363cf510d1c41fa443" ||
      p === "0xc6962004f452be9203591991d15f6b388e09e8d0"
    ) {
      return Math.abs(Number(formatUnits(amount1, 6)));
    }
    if (p === "0x641c00a822e8b671738d32a431a4fb6074e5c79d") {
      const wethLeg = Math.abs(Number(formatUnits(amount1, 18)));
      return Math.round(wethLeg * 3000);
    }
    const a0Abs = Math.abs(Number(formatUnits(amount0, 18)));
    const a1Abs = Math.abs(Number(formatUnits(amount1, 6)));
    return Math.max(a0Abs * 3000, a1Abs);
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
  }): Promise<void> {
    const isWhale = swap.usdValue >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_arbitrum_dex.swaps (id, dex, pool, tx_hash, block_number, timestamp_ms, token0_amount, token1_amount, usd_value, sender, is_whale)
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

      const messageId = uuidv5(`arb:swap:${swap.id}`, UUID_NAMESPACE);
      const normalized = NormalizedMessageSchema.parse({
        id: messageId,
        createdAt: new Date(swap.timestampMs).toISOString(),
        source: { module: "arbitrum-dex", stream: `uniswap:${swap.pool}` },
        realtime: true,
        Message: `Uniswap V3 Swap pool=${swap.pool.slice(0, 10)}... usd=$${swap.usdValue.toFixed(2)} tx=${swap.txHash}`,
        From: "Arbitrum",
        isDirectMention: false,
        isDigest: false,
        isSystemMessage: false,
        likes: Math.floor(swap.usdValue),
        tags: {
          dex: "uniswap_v3",
          chain: "arbitrum",
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
        subjectFor("arbitrum-dex", "messageCreated"),
        this.sc.encode(JSON.stringify(msgEvent))
      );
      this.nats.publish(
        subjectFor("arbitrum-dex", "tradeExecuted"),
        this.sc.encode(JSON.stringify(msgEvent))
      );
      this.messagesPublished++;
    } catch (err) {
      this.log("error", "failed to store swap", {
        id: swap.id,
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  private async storeGmxPosition(pos: {
    id: string;
    eventType: string;
    txHash: string;
    blockNumber: number;
    timestampMs: number;
    account: string;
    market: string;
    collateralToken: string;
    sizeInUsd: string;
    sizeInTokens: string;
    collateralAmount: string;
    isLong: boolean;
  }): Promise<void> {
    const usdValue = Number(formatUnits(BigInt(pos.sizeInUsd), 30));
    const isWhale = usdValue >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_arbitrum_dex.gmx_positions (id, event_type, tx_hash, block_number, timestamp_ms, account, market, collateral_token, size_in_usd, size_in_tokens, collateral_amount, is_long, is_whale)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO NOTHING`,
        [
          pos.id,
          pos.eventType,
          pos.txHash,
          pos.blockNumber,
          pos.timestampMs,
          pos.account,
          pos.market,
          pos.collateralToken,
          pos.sizeInUsd,
          pos.sizeInTokens,
          pos.collateralAmount,
          pos.isLong,
          isWhale,
        ]
      );
      this.gmxEventsCollected++;

      const direction = pos.isLong ? "LONG" : "SHORT";
      const messageId = uuidv5(`arb:gmx:${pos.id}`, UUID_NAMESPACE);
      const normalized = NormalizedMessageSchema.parse({
        id: messageId,
        createdAt: new Date(pos.timestampMs).toISOString(),
        source: { module: "arbitrum-dex", stream: `gmx:${pos.eventType}` },
        realtime: true,
        Message: `GMX ${pos.eventType} ${direction} $${usdValue.toFixed(2)} market=${pos.market.slice(0, 10)}... tx=${pos.txHash}`,
        From: "Arbitrum",
        isDirectMention: false,
        isDigest: false,
        isSystemMessage: false,
        likes: Math.floor(usdValue),
        tags: {
          dex: "gmx_v2",
          chain: "arbitrum",
          eventType: pos.eventType,
          market: pos.market,
          account: pos.account,
          isLong: pos.isLong,
          isWhale,
          txHash: pos.txHash,
          usdValue,
        },
      });

      const msgEvent = MessageCreatedEventSchema.parse({
        type: "MessageCreated",
        message: normalized,
      });

      this.nats.publish(
        subjectFor("arbitrum-dex", "messageCreated"),
        this.sc.encode(JSON.stringify(msgEvent))
      );
      this.nats.publish(
        subjectFor("arbitrum-dex", "tradeExecuted"),
        this.sc.encode(JSON.stringify(msgEvent))
      );
      this.messagesPublished++;
    } catch (err) {
      this.log("error", "failed to store gmx position", {
        id: pos.id,
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  async startStreaming(): Promise<{
    tradesCollected: number;
    gmxEventsCollected: number;
    messagesPublished: number;
  }> {
    this.isStreaming = true;
    this.tradesCollected = 0;
    this.gmxEventsCollected = 0;
    this.messagesPublished = 0;

    const poolAddresses = this.getPools();
    this.log("info", "starting WebSocket stream", {
      pools: poolAddresses.length,
      enableGmx: this.settings.enableGmx,
    });

    let provider: WebSocketProvider;
    try {
      provider = new WebSocketProvider(this.settings.rpcUrl);
    } catch (err) {
      this.log("error", "failed to create WebSocket provider", {
        err: err instanceof Error ? err.message : err,
      });
      this.isStreaming = false;
      return { tradesCollected: 0, gmxEventsCollected: 0, messagesPublished: 0 };
    }

    if (poolAddresses.length > 0) {
      provider.on(
        { address: poolAddresses, topics: [[V3_SWAP_TOPIC]] },
        async (log: Log) => {
          try {
            const block = await provider.getBlock(log.blockHash!);
            const tsMs = Number(block!.timestamp) * 1000;
            const tx = await provider.getTransaction(log.transactionHash!);

            let amount0 = 0n;
            let amount1 = 0n;
            try {
              const ev = v3Iface.parseLog({ topics: log.topics as string[], data: log.data });
              amount0 = BigInt(ev!.args[2]);
              amount1 = BigInt(ev!.args[3]);
            } catch (e) {
              this.log("warn", "failed to decode uniswap v3 swap log", {
                tx: log.transactionHash,
              });
              return;
            }

            const pool = log.address.toLowerCase();
            const usdValue = this.estimateUsdValue(pool, amount0, amount1);
            const swapId = uuidv5(
              `arb:uniswap:${log.transactionHash}:${log.index}`,
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
            });
          } catch (err) {
            this.log("error", "uniswap listener error", {
              err: err instanceof Error ? err.message : err,
            });
          }
        }
      );
      this.log("info", "uniswap v3 subscription active", { poolCount: poolAddresses.length });
    }

    if (this.settings.enableGmx) {
      const gmxTopics = [[GMX_POSITION_INCREASE_TOPIC, GMX_POSITION_DECREASE_TOPIC]];

      provider.on(
        { address: GMX_EVENT_EMITTER, topics: gmxTopics },
        async (log: Log) => {
          try {
            const block = await provider.getBlock(log.blockHash!);
            const tsMs = Number(block!.timestamp) * 1000;
            const topic0 = log.topics[0]?.toLowerCase();

            let eventType = "unknown";
            let account = "";
            let market = "";
            let collateralToken = "";
            let isLong = false;
            let sizeInUsd = 0n;
            let sizeInTokens = 0n;
            let collateralAmount = 0n;

            try {
              if (topic0 === GMX_POSITION_INCREASE_TOPIC.toLowerCase()) {
                eventType = "PositionIncrease";
              } else if (topic0 === GMX_POSITION_DECREASE_TOPIC.toLowerCase()) {
                eventType = "PositionDecrease";
              } else {
                return;
              }

              const ev = gmxIface.parseLog({ topics: log.topics as string[], data: log.data });
              account = ev!.args[1];
              market = ev!.args[2];
              collateralToken = ev!.args[3];
              isLong = ev!.args[4];
              sizeInUsd = BigInt(ev!.args[6]);
              sizeInTokens = BigInt(ev!.args[7]);
              collateralAmount = BigInt(ev!.args[8]);
            } catch (e) {
              this.log("warn", "failed to decode gmx position log", {
                tx: log.transactionHash,
                topic0,
              });
              return;
            }

            const posId = uuidv5(
              `arb:gmx:${log.transactionHash}:${log.index}`,
              UUID_NAMESPACE
            );

            await this.storeGmxPosition({
              id: posId,
              eventType,
              txHash: log.transactionHash!,
              blockNumber: log.blockNumber ?? 0,
              timestampMs: tsMs,
              account: account.toLowerCase(),
              market: market.toLowerCase(),
              collateralToken: collateralToken.toLowerCase(),
              sizeInUsd: String(sizeInUsd),
              sizeInTokens: String(sizeInTokens),
              collateralAmount: String(collateralAmount),
              isLong,
            });
          } catch (err) {
            this.log("error", "gmx listener error", {
              err: err instanceof Error ? err.message : err,
            });
          }
        }
      );
      this.log("info", "gmx v2 subscription active", { eventEmitter: GMX_EVENT_EMITTER });
    }

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

    try {
      provider.destroy();
    } catch {
      // ignore
    }
    this.isStreaming = false;

    return {
      tradesCollected: this.tradesCollected,
      gmxEventsCollected: this.gmxEventsCollected,
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
        this.log("warn", "no uniswap pools configured for REST collection");
        return { tradesCollected: 0, messagesPublished: 0 };
      }

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
          const amount0 = BigInt(ev!.args[2]);
          const amount1 = BigInt(ev!.args[3]);
          const pool = log.address.toLowerCase();
          const usdValue = this.estimateUsdValue(pool, amount0, amount1);

          const block = await provider.getBlock(log.blockHash!);
          const tsMs = Number(block!.timestamp) * 1000;
          const tx = await provider.getTransaction(log.transactionHash!);

          const swapId = uuidv5(
            `arb:uniswap:${log.transactionHash}:${log.index}`,
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
