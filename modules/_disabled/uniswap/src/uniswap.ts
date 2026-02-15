import { WebSocketProvider, Log, Interface, formatUnits, Contract } from "ethers";
import type { NatsConnection, StringCodec } from "nats";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { NormalizedMessageSchema, MessageCreatedEventSchema, subjectFor } from "@feedeater/core";
import { PrismaClient } from "@prisma/client";

const UUID_NAMESPACE = "u1n2i3s4-w5a6-p7v8-9a0b-c1d2e3f4a5b6";

const V2_FACTORY_ADDRESS = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const V3_FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V2_PAIR_CREATED_TOPIC = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const V3_POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

const V2_SWAP_ABI = [
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];
const V3_SWAP_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];
const V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)"
];
const V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

const v2SwapIface = new Interface(V2_SWAP_ABI);
const v3SwapIface = new Interface(V3_SWAP_ABI);
const v2FactoryIface = new Interface(V2_FACTORY_ABI);
const v3FactoryIface = new Interface(V3_FACTORY_ABI);

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();
const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7".toLowerCase();
const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599".toLowerCase();
const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F".toLowerCase();

export interface UniswapSettings {
  rpcUrl: string;
  whaleThreshold: number;
  watchedPairs: string[];
  filterMode: "all" | "weth_only" | "stablecoin_only" | "top_pools" | "custom";
  customTokenFilter: string[];
  topPoolCount: number;
}

export interface SwapEvent {
  txHash: string;
  blockNumber: number;
  timestamp: number;
  pool: string;
  dex: "uniswap_v2" | "uniswap_v3";
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
  dex: "uniswap_v2" | "uniswap_v3";
  fee?: number;
}

export class UniswapCollector {
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
    private readonly settings: UniswapSettings,
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
        "feedeater.uniswap.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "uniswap",
            source: "collector",
            at: new Date().toISOString(),
            message,
            meta,
          })
        )
      );
      this.logger?.[level]?.(message, meta);
    } catch {
      // ignore
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
        symbol,
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

  private shouldWatchPool(token0: string, token1: string): boolean {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    switch (this.settings.filterMode) {
      case "all":
        return true;

      case "weth_only":
        return t0 === WETH_ADDRESS || t1 === WETH_ADDRESS;

      case "stablecoin_only":
        return (
          t0 === USDC_ADDRESS || t1 === USDC_ADDRESS ||
          t0 === USDT_ADDRESS || t1 === USDT_ADDRESS ||
          t0 === DAI_ADDRESS || t1 === DAI_ADDRESS
        );

      case "custom":
        const customTokens = this.settings.customTokenFilter.map(t => t.toLowerCase());
        return customTokens.includes(t0) || customTokens.includes(t1);

      case "top_pools":
        return true;

      default:
        return true;
    }
  }

  private estimateUsdValue(
    amount0: bigint,
    amount1: bigint,
    token0: string,
    token1: string,
    token0Decimals: number,
    token1Decimals: number
  ): number {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    if (t0 === USDC_ADDRESS || t0 === USDT_ADDRESS) {
      return Math.abs(Number(formatUnits(amount0, token0Decimals)));
    }
    if (t1 === USDC_ADDRESS || t1 === USDT_ADDRESS) {
      return Math.abs(Number(formatUnits(amount1, token1Decimals)));
    }
    if (t0 === DAI_ADDRESS) {
      return Math.abs(Number(formatUnits(amount0, token0Decimals)));
    }
    if (t1 === DAI_ADDRESS) {
      return Math.abs(Number(formatUnits(amount1, token1Decimals)));
    }

    if (t0 === WETH_ADDRESS) {
      const ethAmount = Math.abs(Number(formatUnits(amount0, 18)));
      return ethAmount * 3000;
    }
    if (t1 === WETH_ADDRESS) {
      const ethAmount = Math.abs(Number(formatUnits(amount1, 18)));
      return ethAmount * 3000;
    }

    if (t0 === WBTC_ADDRESS) {
      const btcAmount = Math.abs(Number(formatUnits(amount0, 8)));
      return btcAmount * 60000;
    }
    if (t1 === WBTC_ADDRESS) {
      const btcAmount = Math.abs(Number(formatUnits(amount1, 8)));
      return btcAmount * 60000;
    }

    return 0;
  }

  private async handleV2Swap(log: Log): Promise<void> {
    try {
      const parsed = v2SwapIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return;

      const pool = log.address.toLowerCase();
      const poolInfo = this.poolCache.get(pool);
      if (!poolInfo) {
        this.log("debug", "Unknown V2 pool, skipping", { pool });
        return;
      }

      const amount0In = BigInt(parsed.args[0]);
      const amount1In = BigInt(parsed.args[1]);
      const amount0Out = BigInt(parsed.args[2]);
      const amount1Out = BigInt(parsed.args[3]);
      const sender = parsed.args[4] as string;
      const to = parsed.args[5] as string;

      const amount0 = amount0Out - amount0In;
      const amount1 = amount1Out - amount1In;

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
        dex: "uniswap_v2",
        token0: poolInfo.token0,
        token1: poolInfo.token1,
        amount0,
        amount1,
        sender,
        recipient: to,
        usdValue,
        isWhale,
      };

      await this.storeAndPublishSwap(swap, token0Info, token1Info);
    } catch (err) {
      this.log("error", "Failed to handle V2 swap", { err: err instanceof Error ? err.message : err, tx: log.transactionHash });
    }
  }

  private async handleV3Swap(log: Log): Promise<void> {
    try {
      const parsed = v3SwapIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return;

      const pool = log.address.toLowerCase();
      const poolInfo = this.poolCache.get(pool);
      if (!poolInfo) {
        this.log("debug", "Unknown V3 pool, skipping", { pool });
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
        dex: "uniswap_v3",
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
      await this.prisma.dexSwap.create({
        data: {
          chain: "ethereum",
          dex: swap.dex,
          pair: swap.pool,
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

    const messageId = uuidv5(`uniswap:swap:${swap.txHash}:${swap.pool}`, UUID_NAMESPACE);
    const pairLabel = `${token0Info.symbol}/${token1Info.symbol}`;
    const messageText = `Swap on ${swap.dex} ${pairLabel} pool=${swap.pool.slice(0, 10)}... usd=$${swap.usdValue.toFixed(2)} tx=${swap.txHash.slice(0, 10)}...`;

    const normalized = NormalizedMessageSchema.parse({
      id: messageId,
      createdAt: new Date(swap.timestamp).toISOString(),
      source: { module: "uniswap", stream: swap.pool },
      realtime: true,
      Message: messageText,
      isDirectMention: false,
      isDigest: false,
      isSystemMessage: false,
      tags: {
        dex: swap.dex,
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

    this.nats.publish(subjectFor("uniswap", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));

    const tradeEvent = {
      source: "uniswap",
      symbol: pairLabel,
      side: swap.amount0 > 0n ? "sell" : "buy" as "buy" | "sell",
      price: swap.usdValue / Math.abs(Number(swap.amount0) / Math.pow(10, token0Info.decimals) || 1),
      size: Math.abs(Number(swap.amount0) / Math.pow(10, token0Info.decimals)),
      notional_usd: swap.usdValue,
      timestamp: new Date(swap.timestamp).toISOString(),
      pool_address: swap.pool,
      tx_hash: swap.txHash,
      block_number: swap.blockNumber,
    };

    this.nats.publish(subjectFor("uniswap", "tradeExecuted"), this.sc.encode(JSON.stringify(tradeEvent)));

    if (swap.isWhale) {
      this.log("info", "Whale swap detected", {
        dex: swap.dex,
        pair: pairLabel,
        usdValue: swap.usdValue,
        txHash: swap.txHash,
      });
    }
  }

  private handleV2PairCreated(log: Log): void {
    try {
      const parsed = v2FactoryIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return;

      const token0 = (parsed.args[0] as string).toLowerCase();
      const token1 = (parsed.args[1] as string).toLowerCase();
      const pairAddress = (parsed.args[2] as string).toLowerCase();

      if (!this.shouldWatchPool(token0, token1)) {
        return;
      }

      this.poolCache.set(pairAddress, {
        address: pairAddress,
        token0,
        token1,
        dex: "uniswap_v2",
      });
      this.watchedPoolAddresses.add(pairAddress);

      this.log("info", "New V2 pair discovered", { pair: pairAddress, token0, token1 });
    } catch (err) {
      this.log("error", "Failed to handle V2 PairCreated", { err: err instanceof Error ? err.message : err });
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

      if (!this.shouldWatchPool(token0, token1)) {
        return;
      }

      this.poolCache.set(poolAddress, {
        address: poolAddress,
        token0,
        token1,
        dex: "uniswap_v3",
        fee,
      });
      this.watchedPoolAddresses.add(poolAddress);

      this.log("info", "New V3 pool discovered", { pool: poolAddress, token0, token1, fee });
    } catch (err) {
      this.log("error", "Failed to handle V3 PoolCreated", { err: err instanceof Error ? err.message : err });
    }
  }

  private initializeWatchedPools(): void {
    for (const poolAddress of this.settings.watchedPairs) {
      const addr = poolAddress.toLowerCase();
      this.watchedPoolAddresses.add(addr);
      if (!this.poolCache.has(addr)) {
        this.poolCache.set(addr, {
          address: addr,
          token0: "",
          token1: "",
          dex: "uniswap_v3",
        });
      }
    }
    this.log("info", "Initialized watched pools", { count: this.watchedPoolAddresses.size });
  }

  private async fetchPoolTokens(): Promise<void> {
    const V2_PAIR_ABI = [
      "function token0() view returns (address)",
      "function token1() view returns (address)",
    ];
    const V3_POOL_ABI = [
      "function token0() view returns (address)",
      "function token1() view returns (address)",
      "function fee() view returns (uint24)",
    ];

    for (const [poolAddress, poolInfo] of this.poolCache.entries()) {
      if (poolInfo.token0 && poolInfo.token1) continue;

      try {
        const contract = new Contract(
          poolAddress,
          poolInfo.dex === "uniswap_v2" ? V2_PAIR_ABI : V3_POOL_ABI,
          this.provider
        );

        const [token0, token1] = await Promise.all([
          contract.token0(),
          contract.token1(),
        ]);

        poolInfo.token0 = (token0 as string).toLowerCase();
        poolInfo.token1 = (token1 as string).toLowerCase();

        if (poolInfo.dex === "uniswap_v3" && !poolInfo.fee) {
          try {
            const fee = await contract.fee();
            poolInfo.fee = Number(fee);
          } catch {
            // ignore
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
          topics: [[V2_SWAP_TOPIC, V3_SWAP_TOPIC]],
        },
        async (log: Log) => {
          const topic = log.topics[0]?.toLowerCase();
          if (topic === V2_SWAP_TOPIC.toLowerCase()) {
            await this.handleV2Swap(log);
          } else if (topic === V3_SWAP_TOPIC.toLowerCase()) {
            await this.handleV3Swap(log);
          }
        }
      );
      this.log("info", "Subscribed to swap events", { poolCount: poolAddresses.length });
    }

    this.provider.on(
      {
        address: V2_FACTORY_ADDRESS,
        topics: [V2_PAIR_CREATED_TOPIC],
      },
      (log: Log) => {
        this.handleV2PairCreated(log);
      }
    );

    this.provider.on(
      {
        address: V3_FACTORY_ADDRESS,
        topics: [V3_POOL_CREATED_TOPIC],
      },
      (log: Log) => {
        this.handleV3PoolCreated(log);
      }
    );

    this.log("info", "Subscribed to factory events for new pool discovery");
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
    this.log("info", "Starting Uniswap collector", {
      rpcUrl: this.settings.rpcUrl,
      filterMode: this.settings.filterMode,
      whaleThreshold: this.settings.whaleThreshold,
      watchedPairs: this.settings.watchedPairs.length,
    });

    this.initializeWatchedPools();
    await this.fetchPoolTokens();
    await this.subscribeToEvents();

    const ws = (this.provider as any)._websocket;
    if (ws?.addEventListener) {
      ws.addEventListener("close", () => {
        this.log("warn", "WebSocket closed");
        this.scheduleReconnect();
      });
      ws.addEventListener("error", (err: Error) => {
        this.log("error", "WebSocket error", { err: err.message });
      });
    }

    this.log("info", "Uniswap collector started");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.provider.destroy();
    await this.prisma.$disconnect();
    this.log("info", "Uniswap collector stopped");
  }

  getStats(): { swapCount: number; poolCount: number; tokenCount: number } {
    return {
      swapCount: this.swapCounter,
      poolCount: this.poolCache.size,
      tokenCount: this.tokenCache.size,
    };
  }
}

export async function createUniswapListener(params: {
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
  const rpcUrl = (await params.getSetting("rpcUrl")) as string || "ws://localhost:8546";
  const whaleThreshold = Number((await params.getSetting("whaleThreshold")) ?? 50000);
  const watchedPairsSetting = await params.getSetting("watchedPairs");
  const filterModeSetting = (await params.getSetting("filterMode")) as string || "all";
  const customTokenFilterSetting = await params.getSetting("customTokenFilter");
  const topPoolCountSetting = await params.getSetting("topPoolCount");

  let watchedPairs: string[] = [];
  if (Array.isArray(watchedPairsSetting)) {
    watchedPairs = watchedPairsSetting as string[];
  } else if (typeof watchedPairsSetting === "string" && watchedPairsSetting.trim().startsWith("[")) {
    try {
      watchedPairs = JSON.parse(watchedPairsSetting);
    } catch {
      watchedPairs = [];
    }
  }

  let customTokenFilter: string[] = [];
  if (Array.isArray(customTokenFilterSetting)) {
    customTokenFilter = customTokenFilterSetting as string[];
  } else if (typeof customTokenFilterSetting === "string" && customTokenFilterSetting.trim().startsWith("[")) {
    try {
      customTokenFilter = JSON.parse(customTokenFilterSetting);
    } catch {
      customTokenFilter = [];
    }
  }

  const settings: UniswapSettings = {
    rpcUrl,
    whaleThreshold,
    watchedPairs,
    filterMode: filterModeSetting as UniswapSettings["filterMode"],
    customTokenFilter,
    topPoolCount: Number(topPoolCountSetting) || 50,
  };

  const collector = new UniswapCollector(settings, params.nats, params.sc, params.logger);
  await collector.start();

  return collector;
}
