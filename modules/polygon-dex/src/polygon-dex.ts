import { WebSocketProvider, Log, Interface, formatUnits, Contract } from "ethers";
import type { NatsConnection, StringCodec } from "nats";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { NormalizedMessageSchema, MessageCreatedEventSchema, subjectFor } from "@feedeater/core";
import { PrismaClient } from "@prisma/client";

const UUID_NAMESPACE = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";

const QUICKSWAP_V3_FACTORY = "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28";

const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V3_POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

const V3_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];
const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)"
];

const v3SwapIface = new Interface(V3_SWAP_ABI);
const v3FactoryIface = new Interface(V3_FACTORY_ABI);

const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359".toLowerCase();
const POLYGON_USDCe = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase();
const POLYGON_USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase();
const POLYGON_WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619".toLowerCase();
const POLYGON_WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase();
const POLYGON_WBTC = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6".toLowerCase();

export interface PolygonDexSettings {
  rpcUrl: string;
  whaleThreshold: number;
  watchedQuickswapPools: string[];
}

export interface SwapEvent {
  txHash: string;
  blockNumber: number;
  timestamp: number;
  pool: string;
  dex: "quickswap_v3";
  token0: string;
  token1: string;
  amount0: bigint;
  amount1: bigint;
  sender: string;
  recipient: string;
  usdValue: number;
  isWhale: boolean;
}

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  fee?: number;
}

export class PolygonDexCollector {
  private provider: WebSocketProvider;
  private prisma: PrismaClient;
  private isRunning = false;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
  private tokenCache: Map<string, TokenInfo> = new Map();
  private poolCache: Map<string, PoolInfo> = new Map();
  private watchedPoolAddresses: Set<string> = new Set();
  private swapCounter = 0;

  constructor(
    private readonly settings: PolygonDexSettings,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodec,
    private readonly logger?: {
      debug?: (msg: string, meta?: unknown) => void;
      info?: (msg: string, meta?: unknown) => void;
      warn?: (msg: string, meta?: unknown) => void;
      error?: (msg: string, meta?: unknown) => void;
    }
  ) {
    this.provider = new WebSocketProvider(settings.rpcUrl);
    this.prisma = new PrismaClient();
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.polygon-dex.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "polygon-dex",
            source: "collector",
            at: new Date().toISOString(),
            message,
            meta,
          })
        )
      );
      this.logger?.[level]?.(message, meta);
    } catch {
    }
  }

  private async getTokenInfo(address: string): Promise<TokenInfo> {
    const cached = this.tokenCache.get(address.toLowerCase());
    if (cached) return cached;

    try {
      const contract = new Contract(address, ERC20_ABI, this.provider);
      const [symbol, decimals] = await Promise.all([
        contract.symbol(),
        contract.decimals(),
      ]);
      const info: TokenInfo = {
        address: address.toLowerCase(),
        symbol: symbol as string,
        decimals: Number(decimals),
      };
      this.tokenCache.set(address.toLowerCase(), info);
      return info;
    } catch {
      const info: TokenInfo = {
        address: address.toLowerCase(),
        symbol: "UNKNOWN",
        decimals: 18,
      };
      this.tokenCache.set(address.toLowerCase(), info);
      return info;
    }
  }

  estimateUsdValue(
    amount0: bigint,
    amount1: bigint,
    token0: string,
    token1: string,
    token0Decimals: number,
    token1Decimals: number
  ): number {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    if (t0 === POLYGON_USDC || t0 === POLYGON_USDCe || t0 === POLYGON_USDT) {
      return Math.abs(Number(formatUnits(amount0, token0Decimals)));
    }
    if (t1 === POLYGON_USDC || t1 === POLYGON_USDCe || t1 === POLYGON_USDT) {
      return Math.abs(Number(formatUnits(amount1, token1Decimals)));
    }

    if (t0 === POLYGON_WETH) {
      const ethAmount = Math.abs(Number(formatUnits(amount0, 18)));
      return ethAmount * 3000;
    }
    if (t1 === POLYGON_WETH) {
      const ethAmount = Math.abs(Number(formatUnits(amount1, 18)));
      return ethAmount * 3000;
    }

    if (t0 === POLYGON_WMATIC) {
      const maticAmount = Math.abs(Number(formatUnits(amount0, 18)));
      return maticAmount * 0.5;
    }
    if (t1 === POLYGON_WMATIC) {
      const maticAmount = Math.abs(Number(formatUnits(amount1, 18)));
      return maticAmount * 0.5;
    }

    if (t0 === POLYGON_WBTC) {
      const btcAmount = Math.abs(Number(formatUnits(amount0, 8)));
      return btcAmount * 60000;
    }
    if (t1 === POLYGON_WBTC) {
      const btcAmount = Math.abs(Number(formatUnits(amount1, 8)));
      return btcAmount * 60000;
    }

    return 0;
  }

  private async handleV3Swap(log: Log): Promise<void> {
    try {
      const parsed = v3SwapIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return;

      const pool = log.address.toLowerCase();
      const poolInfo = this.poolCache.get(pool);
      if (!poolInfo) {
        this.log("debug", "Unknown pool, skipping", { pool });
        return;
      }

      const sender = parsed.args[0] as string;
      const recipient = parsed.args[1] as string;
      const amount0 = BigInt(parsed.args[2]);
      const amount1 = BigInt(parsed.args[3]);

      const [token0Info, token1Info] = await Promise.all([
        this.getTokenInfo(poolInfo.token0),
        this.getTokenInfo(poolInfo.token1),
      ]);

      const block = await this.provider.getBlock(log.blockNumber);
      const timestamp = block ? Number(block.timestamp) * 1000 : Date.now();

      const usdValue = this.estimateUsdValue(
        amount0, amount1,
        poolInfo.token0, poolInfo.token1,
        token0Info.decimals, token1Info.decimals
      );
      const isWhale = usdValue >= this.settings.whaleThreshold;

      const swap: SwapEvent = {
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        timestamp,
        pool,
        dex: "quickswap_v3",
        token0: poolInfo.token0,
        token1: poolInfo.token1,
        amount0,
        amount1,
        sender,
        recipient,
        usdValue,
        isWhale,
      };

      await this.storeAndPublishSwap(swap, token0Info, token1Info);
    } catch (err) {
      this.log("error", "Failed to handle V3 swap", { err: err instanceof Error ? err.message : err, tx: log.transactionHash });
    }
  }

  private async storeAndPublishSwap(swap: SwapEvent, token0Info: TokenInfo, token1Info: TokenInfo): Promise<void> {
    this.swapCounter++;

    try {
      await this.prisma.polygonSwap.create({
        data: {
          chain: "polygon",
          dex: swap.dex,
          pool: swap.pool,
          txHash: swap.txHash,
          block: BigInt(swap.blockNumber),
          timestampMs: BigInt(swap.timestamp),
          token0Amount: swap.amount0.toString(),
          token1Amount: swap.amount1.toString(),
          usdValue: swap.usdValue.toFixed(2),
          sender: swap.sender.toLowerCase(),
          isWhale: swap.isWhale,
        },
      });
    } catch (err) {
      this.log("error", "Failed to store swap in DB", { err: err instanceof Error ? err.message : err });
    }

    const messageId = uuidv5(`polygon-dex:swap:${swap.txHash}:${swap.pool}`, UUID_NAMESPACE);
    const pairLabel = `${token0Info.symbol}/${token1Info.symbol}`;
    const messageText = `QuickSwap V3 Swap ${pairLabel} pool=${swap.pool.slice(0, 10)}... usd=$${swap.usdValue.toFixed(2)}${swap.isWhale ? " [WHALE]" : ""} tx=${swap.txHash.slice(0, 10)}...`;

    const normalized = NormalizedMessageSchema.parse({
      id: messageId,
      createdAt: new Date(swap.timestamp).toISOString(),
      source: { module: "polygon-dex", stream: swap.pool },
      realtime: true,
      Message: messageText,
      isDirectMention: false,
      isDigest: false,
      isSystemMessage: false,
      tags: {
        dex: swap.dex,
        chain: "polygon",
        pool: swap.pool,
        pair: pairLabel,
        token0: swap.token0,
        token1: swap.token1,
        tx_hash: swap.txHash,
        block_number: swap.blockNumber,
        usd_value: swap.usdValue,
        is_whale: swap.isWhale,
      },
    });

    const msgEvent = MessageCreatedEventSchema.parse({
      type: "MessageCreated",
      message: normalized,
    });

    this.nats.publish(subjectFor("polygon-dex", "tradeExecuted"), this.sc.encode(JSON.stringify(msgEvent)));

    if (swap.isWhale) {
      this.log("info", "Whale swap detected", {
        pair: pairLabel,
        usdValue: swap.usdValue,
        txHash: swap.txHash,
      });
    }
  }

  private handleV3PoolCreated(log: Log): void {
    try {
      const parsed = v3FactoryIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return;

      const token0 = (parsed.args[0] as string).toLowerCase();
      const token1 = (parsed.args[1] as string).toLowerCase();
      const fee = Number(parsed.args[2]);
      const poolAddress = (parsed.args[4] as string).toLowerCase();

      this.poolCache.set(poolAddress, {
        address: poolAddress,
        token0,
        token1,
        fee,
      });
      this.watchedPoolAddresses.add(poolAddress);

      this.log("info", "New QuickSwap V3 pool discovered", { pool: poolAddress, token0, token1, fee });
    } catch (err) {
      this.log("error", "Failed to handle PoolCreated", { err: err instanceof Error ? err.message : err });
    }
  }

  private initializeWatchedPools(): void {
    for (const poolAddress of this.settings.watchedQuickswapPools) {
      const addr = poolAddress.toLowerCase();
      this.watchedPoolAddresses.add(addr);
      if (!this.poolCache.has(addr)) {
        this.poolCache.set(addr, {
          address: addr,
          token0: "",
          token1: "",
        });
      }
    }
    this.log("info", "Initialized watched pools", { count: this.watchedPoolAddresses.size });
  }

  private async fetchPoolTokens(): Promise<void> {
    for (const [poolAddress, poolInfo] of this.poolCache.entries()) {
      if (poolInfo.token0 && poolInfo.token1) continue;

      try {
        const contract = new Contract(poolAddress, V3_POOL_ABI, this.provider);
        const [token0, token1] = await Promise.all([
          contract.token0(),
          contract.token1(),
        ]);

        poolInfo.token0 = (token0 as string).toLowerCase();
        poolInfo.token1 = (token1 as string).toLowerCase();

        if (!poolInfo.fee) {
          try {
            const fee = await contract.fee();
            poolInfo.fee = Number(fee);
          } catch {
          }
        }

        this.log("debug", "Fetched pool tokens", { pool: poolAddress, token0: poolInfo.token0, token1: poolInfo.token1 });
      } catch (err) {
        this.log("warn", "Failed to fetch pool tokens", { pool: poolAddress, err: err instanceof Error ? err.message : err });
      }
    }
  }

  private async subscribeToEvents(): Promise<void> {
    const poolAddresses = Array.from(this.watchedPoolAddresses);

    if (poolAddresses.length > 0) {
      this.provider.on(
        {
          address: poolAddresses,
          topics: [[V3_SWAP_TOPIC]],
        },
        async (log: Log) => {
          await this.handleV3Swap(log);
        }
      );
      this.log("info", "Subscribed to QuickSwap V3 swap events", { poolCount: poolAddresses.length });
    }

    this.provider.on(
      {
        address: QUICKSWAP_V3_FACTORY,
        topics: [V3_POOL_CREATED_TOPIC],
      },
      (log: Log) => {
        this.handleV3PoolCreated(log);
      }
    );

    this.log("info", "Subscribed to QuickSwap V3 factory events for new pool discovery");
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;

    this.log("warn", `Reconnecting in ${this.reconnectDelay}ms`);
    setTimeout(async () => {
      try {
        this.provider = new WebSocketProvider(this.settings.rpcUrl);
        await this.subscribeToEvents();
        this.reconnectDelay = 1000;
        this.log("info", "Reconnected successfully");
      } catch (err) {
        this.log("error", "Reconnect failed", { err: err instanceof Error ? err.message : err });
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.log("warn", "Collector already running");
      return;
    }

    this.isRunning = true;
    this.log("info", "Starting Polygon DEX collector", {
      rpcUrl: this.settings.rpcUrl,
      whaleThreshold: this.settings.whaleThreshold,
      watchedPools: this.settings.watchedQuickswapPools.length,
    });

    this.initializeWatchedPools();
    await this.fetchPoolTokens();
    await this.subscribeToEvents();

    const ws = (this.provider as unknown as { _websocket?: { addEventListener?: (event: string, handler: (...args: unknown[]) => void) => void } })._websocket;
    if (ws?.addEventListener) {
      ws.addEventListener("close", () => {
        this.log("warn", "WebSocket closed");
        this.scheduleReconnect();
      });
      ws.addEventListener("error", (err: unknown) => {
        this.log("error", "WebSocket error", { err: err instanceof Error ? err.message : String(err) });
      });
    }

    this.log("info", "Polygon DEX collector started");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.provider.destroy();
    await this.prisma.$disconnect();
    this.log("info", "Polygon DEX collector stopped");
  }

  getStats(): { swapCount: number; poolCount: number; tokenCount: number } {
    return {
      swapCount: this.swapCounter,
      poolCount: this.poolCache.size,
      tokenCount: this.tokenCache.size,
    };
  }
}

export async function createPolygonDexListener(params: {
  nats: NatsConnection;
  sc: StringCodec;
  getSetting: (k: string) => Promise<string | boolean | number | undefined>;
  logger?: {
    debug?: (msg: string, meta?: unknown) => void;
    info?: (msg: string, meta?: unknown) => void;
    warn?: (msg: string, meta?: unknown) => void;
    error?: (msg: string, meta?: unknown) => void;
  };
}) {
  const rpcUrl = (await params.getSetting("rpcUrl")) as string || "wss://polygon-mainnet.infura.io/ws/v3/YOUR-PROJECT-ID";
  const whaleThreshold = Number((await params.getSetting("whaleThreshold")) ?? 50000);

  const watchedPoolsSetting = await params.getSetting("watchedQuickswapPools");
  let watchedQuickswapPools: string[] = [];
  if (Array.isArray(watchedPoolsSetting)) {
    watchedQuickswapPools = watchedPoolsSetting as string[];
  } else if (typeof watchedPoolsSetting === "string" && watchedPoolsSetting.trim().startsWith("[")) {
    try {
      watchedQuickswapPools = JSON.parse(watchedPoolsSetting);
    } catch {
      watchedQuickswapPools = [];
    }
  }

  const settings: PolygonDexSettings = {
    rpcUrl,
    whaleThreshold,
    watchedQuickswapPools,
  };

  const collector = new PolygonDexCollector(settings, params.nats, params.sc, params.logger);
  await collector.start();

  return collector;
}
