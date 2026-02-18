import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";
import WebSocket from "ws";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type BybitSettings = {
  enabled: boolean;
  apiUrl: string;
  restApiUrl: string;
  whaleThreshold: number;
  watchedPairs: string;
  orderbookEnabled: boolean;
  candleIntervalSeconds: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

const UUID_NAMESPACE = "a1c2e3f4-5678-4abc-9def-012345678901";

const PUBLIC_WS_URL = "wss://stream.bybit.com/v5/public/spot";
const PUBLIC_REST_URL = "https://api.bybit.com/v5/market";
const FALLBACK_WS_URLS = [
  "wss://stream.bybit.com/v5/public/spot",
  "wss://stream-testnet.bybit.com/v5/public/spot",
];

const PING_INTERVAL_MS = 20000;

export function parseBybitSettingsFromInternal(raw: Record<string, unknown>): BybitSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const apiUrl = String(raw.apiUrl ?? PUBLIC_WS_URL);
  const restApiUrl = String(raw.restApiUrl ?? PUBLIC_REST_URL);
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedPairs = String(raw.watchedPairs ?? '["BTCUSDT", "ETHUSDT", "SOLUSDT"]');
  const orderbookEnabled = String(raw.orderbookEnabled ?? "true") === "true";
  const candleIntervalSeconds = raw.candleIntervalSeconds ? Number(raw.candleIntervalSeconds) : 60;
  const defaultContextPrompt =
    "You are summarizing CEX trading activity on Bybit. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('Bybit setting "whaleThreshold" must be a positive number');
  }

  return {
    enabled,
    apiUrl,
    restApiUrl,
    whaleThreshold,
    watchedPairs,
    orderbookEnabled,
    candleIntervalSeconds,
    contextPrompt,
    contextPromptFallback,
  };
}

interface BybitTrade {
  trade_id: string;
  symbol: string;
  price: number;
  size: number;
  side: string;
  time: string;
}

interface CandleData {
  pair: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  startTime: Date;
}

interface OrderbookLevel {
  price: number;
  size: number;
}

export class BybitIngestor {
  private feedApiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectAttempts = 0;
  private isRunning = false;
  private candles: Map<string, CandleData> = new Map();
  private lastCandleFlush: Map<string, number> = new Map();
  private orderbook: Map<string, { bids: OrderbookLevel[]; asks: OrderbookLevel[] }> = new Map();
  private lastOrderbookSnapshot: Map<string, number> = new Map();
  private tradeCounter = 0;
  private snapshotCounter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.bybit.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "bybit",
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
    private readonly settings: BybitSettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodec,
    opts: { apiBaseUrl: string; internalToken: string; contextTopK: number; embedDim: number }
  ) {
    this.feedApiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_bybit");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_bybit.trades (
        id text PRIMARY KEY,
        symbol text NOT NULL,
        price numeric NOT NULL,
        size numeric NOT NULL,
        side text NOT NULL,
        notional_usd numeric NOT NULL,
        is_whale boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS bybit_trades_symbol_idx ON mod_bybit.trades (symbol, created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS bybit_trades_whale_idx ON mod_bybit.trades (is_whale, created_at) WHERE is_whale = true`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_bybit.candles (
        id text PRIMARY KEY,
        symbol text NOT NULL,
        interval_seconds int NOT NULL,
        open_price numeric NOT NULL,
        high_price numeric NOT NULL,
        low_price numeric NOT NULL,
        close_price numeric NOT NULL,
        volume numeric NOT NULL,
        trade_count int NOT NULL,
        start_time timestamptz NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS bybit_candles_symbol_idx ON mod_bybit.candles (symbol, start_time)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_bybit.orderbook_snapshots (
        id text PRIMARY KEY,
        symbol text NOT NULL,
        bids_json text NOT NULL,
        asks_json text NOT NULL,
        mid_price numeric NOT NULL,
        spread_bps numeric NOT NULL,
        snapshot_at timestamptz NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS bybit_orderbook_symbol_idx ON mod_bybit.orderbook_snapshots (symbol, snapshot_at)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_bybit.pair_embeddings (
        id text PRIMARY KEY,
        symbol text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS bybit_embeddings_ctx_idx ON mod_bybit.pair_embeddings (context_key, ts)`
    );
  }

  private getPairs(): string[] {
    try {
      return JSON.parse(this.settings.watchedPairs) as string[];
    } catch {
      return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    }
  }

  private async storeTrade(trade: BybitTrade): Promise<boolean> {
    const notionalUsd = trade.price * trade.size;
    const isWhale = notionalUsd >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_bybit.trades (id, symbol, price, size, side, notional_usd, is_whale, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [trade.trade_id, trade.symbol, trade.price, trade.size, trade.side, notionalUsd, isWhale, trade.time]
      );

      const tradeEvent = {
        source: "bybit",
        symbol: trade.symbol,
        side: trade.side as "buy" | "sell",
        price: trade.price,
        size: trade.size,
        notional_usd: notionalUsd,
        timestamp: trade.time,
      };
      this.nats.publish(
        subjectFor("bybit", "tradeExecuted"),
        this.sc.encode(JSON.stringify(tradeEvent))
      );

      if (isWhale) {
        const direction = trade.side === "buy" ? "bullish" : "bearish";
        const messageId = uuidv5(`bybit:whale:${trade.trade_id}`, UUID_NAMESPACE);
        const messageText = `WHALE TRADE: ${trade.symbol} ${trade.side.toUpperCase()} ${trade.size.toFixed(4)} @ $${trade.price.toLocaleString()} = $${notionalUsd.toLocaleString()}`;

        const normalized = NormalizedMessageSchema.parse({
          id: messageId,
          createdAt: trade.time,
          source: { module: "bybit", stream: trade.symbol },
          contextRef: { ownerModule: "bybit", sourceKey: trade.symbol },
          Message: messageText,
          From: "Bybit",
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          likes: Math.floor(notionalUsd / 1000),
          tags: {
            symbol: trade.symbol,
            tradeId: trade.trade_id,
            price: trade.price,
            size: trade.size,
            side: trade.side,
            notionalUsd: notionalUsd,
            isWhale: true,
            direction: direction,
          },
        });

        const msgEvent = MessageCreatedEventSchema.parse({
          type: "MessageCreated",
          message: normalized,
        });

        this.nats.publish(subjectFor("bybit", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
        this.log("info", "whale trade detected", { symbol: trade.symbol, notionalUsd, side: trade.side });
      }

      return true;
    } catch (err) {
      this.log("error", "failed to store trade", { tradeId: trade.trade_id, err: err instanceof Error ? err.message : err });
      return false;
    }
  }

  private updateCandle(trade: BybitTrade): void {
    const symbol = trade.symbol;
    const price = trade.price;
    const size = trade.size;
    const tradeTime = new Date(trade.time);
    const intervalMs = this.settings.candleIntervalSeconds * 1000;
    const candleStart = new Date(Math.floor(tradeTime.getTime() / intervalMs) * intervalMs);

    const existing = this.candles.get(symbol);
    if (existing && existing.startTime.getTime() === candleStart.getTime()) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += size;
      existing.tradeCount++;
    } else {
      if (existing) {
        this.flushCandle(symbol, existing);
      }
      this.candles.set(symbol, {
        pair: symbol,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: size,
        tradeCount: 1,
        startTime: candleStart,
      });
    }
  }

  private async flushCandle(symbol: string, candle: CandleData): Promise<void> {
    const candleId = uuidv5(`bybit:candle:${symbol}:${candle.startTime.toISOString()}`, UUID_NAMESPACE);
    try {
      await this.db.query(
        `INSERT INTO mod_bybit.candles (id, symbol, interval_seconds, open_price, high_price, low_price, close_price, volume, trade_count, start_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           high_price = GREATEST(mod_bybit.candles.high_price, EXCLUDED.high_price),
           low_price = LEAST(mod_bybit.candles.low_price, EXCLUDED.low_price),
           close_price = EXCLUDED.close_price,
           volume = EXCLUDED.volume,
           trade_count = EXCLUDED.trade_count`,
        [candleId, symbol, this.settings.candleIntervalSeconds, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.tradeCount, candle.startTime]
      );
      this.log("debug", "flushed candle", { symbol, startTime: candle.startTime.toISOString() });
    } catch (err) {
      this.log("error", "failed to flush candle", { symbol, err: err instanceof Error ? err.message : err });
    }
  }

  private updateOrderbook(symbol: string, side: string, price: number, size: number): void {
    if (!this.orderbook.has(symbol)) {
      this.orderbook.set(symbol, { bids: [], asks: [] });
    }
    const book = this.orderbook.get(symbol)!;
    const levels = side === "bid" ? book.bids : book.asks;

    const idx = levels.findIndex((l) => l.price === price);
    if (size === 0) {
      if (idx >= 0) levels.splice(idx, 1);
    } else {
      if (idx >= 0) {
        levels[idx]!.size = size;
      } else {
        levels.push({ price, size });
      }
    }

    if (side === "bid") {
      book.bids.sort((a, b) => b.price - a.price);
      book.bids = book.bids.slice(0, 20);
    } else {
      book.asks.sort((a, b) => a.price - b.price);
      book.asks = book.asks.slice(0, 20);
    }
  }

  private async snapshotOrderbook(symbol: string): Promise<void> {
    const book = this.orderbook.get(symbol);
    if (!book || book.bids.length === 0 || book.asks.length === 0) return;

    const now = Date.now();
    const lastSnapshot = this.lastOrderbookSnapshot.get(symbol) ?? 0;
    if (now - lastSnapshot < 60000) return;

    const bestBid = book.bids[0]?.price ?? 0;
    const bestAsk = book.asks[0]?.price ?? 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

    const snapshotId = uuidv5(`bybit:orderbook:${symbol}:${now}`, UUID_NAMESPACE);
    const snapshotTime = new Date(now);

    try {
      await this.db.query(
        `INSERT INTO mod_bybit.orderbook_snapshots (id, symbol, bids_json, asks_json, mid_price, spread_bps, snapshot_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [snapshotId, symbol, JSON.stringify(book.bids.slice(0, 20)), JSON.stringify(book.asks.slice(0, 20)), midPrice, spreadBps, snapshotTime]
      );
      this.lastOrderbookSnapshot.set(symbol, now);
      this.snapshotCounter++;
      this.log("debug", "saved orderbook snapshot", { symbol, midPrice, spreadBps });
    } catch (err) {
      this.log("error", "failed to save orderbook snapshot", { symbol, err: err instanceof Error ? err.message : err });
    }
  }

  private subscribeToStreams(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const pairs = this.getPairs();
    const args: string[] = [];
    for (const pair of pairs) {
      args.push(`publicTrade.${pair}`);
    }
    if (this.settings.orderbookEnabled) {
      for (const pair of pairs) {
        args.push(`orderbook.25.${pair}`);
      }
    }

    this.ws.send(JSON.stringify({ op: "subscribe", args }));
    this.log("info", "subscribed to streams", { args });
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: "ping" }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private connectToUrl(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.log("info", "WebSocket connected (public feed, no API key required)", { url: wsUrl });
        this.reconnectDelay = 1000;
        this.subscribeToStreams();
        this.startPingInterval();
        resolve();
      });

      this.ws.on("message", async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          await this.handleMessage(msg);
        } catch (err) {
          this.log("error", "failed to parse WebSocket message", { err: err instanceof Error ? err.message : err });
        }
      });

      this.ws.on("error", (err) => {
        this.log("error", "WebSocket error", { err: err.message });
        reject(err);
      });

      this.ws.on("close", () => {
        this.log("warn", "WebSocket closed");
        this.stopPingInterval();
        if (this.isRunning) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private async connectWebSocket(): Promise<void> {
    this.log("info", "connecting to Bybit public WebSocket", { url: this.settings.apiUrl, pairs: this.getPairs() });

    try {
      await this.connectToUrl(this.settings.apiUrl);
      return;
    } catch (err) {
      this.log("warn", "primary WebSocket failed, trying fallback URLs", { err: err instanceof Error ? err.message : err });
    }

    for (const fallbackUrl of FALLBACK_WS_URLS) {
      if (fallbackUrl === this.settings.apiUrl) continue;
      try {
        this.log("info", "trying fallback URL", { url: fallbackUrl });
        await this.connectToUrl(fallbackUrl);
        return;
      } catch (err) {
        this.log("warn", "fallback URL failed", { url: fallbackUrl, err: err instanceof Error ? err.message : err });
      }
    }

    throw new Error("all Bybit WebSocket URLs failed");
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.op === "pong" || msg.op === "subscribe") {
      return;
    }

    const topic = msg.topic as string | undefined;
    if (!topic) return;

    if (topic.startsWith("publicTrade.")) {
      const trades = msg.data as any[];
      if (!Array.isArray(trades)) return;

      for (const t of trades) {
        this.tradeCounter++;
        const trade: BybitTrade = {
          trade_id: `bybit_${t.s}_${t.i}`,
          symbol: t.s,
          price: parseFloat(t.p),
          size: parseFloat(t.v),
          side: String(t.S).toLowerCase(),
          time: new Date(t.T).toISOString(),
        };
        await this.storeTrade(trade);
        this.updateCandle(trade);
      }
    } else if (topic.startsWith("orderbook.")) {
      const symbol = topic.split(".").pop() ?? "";
      const bookData = msg.data;
      if (!bookData) return;

      const bids = bookData.b || [];
      const asks = bookData.a || [];

      for (const bid of bids) {
        const price = parseFloat(bid[0]);
        const size = parseFloat(bid[1]);
        this.updateOrderbook(symbol, "bid", price, size);
      }
      for (const ask of asks) {
        const price = parseFloat(ask[0]);
        const size = parseFloat(ask[1]);
        this.updateOrderbook(symbol, "ask", price, size);
      }
      await this.snapshotOrderbook(symbol);
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= 10) {
      this.log("error", "max WebSocket reconnect attempts (10) exhausted", {
        attempts: this.reconnectAttempts,
      });
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectDelay;
    this.log("warn", `WebSocket disconnected, reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/10)`, {
      attempt: this.reconnectAttempts,
      maxAttempts: 10,
      delay,
    });
    this.nats.publish(
      subjectFor("bybit", "reconnecting"),
      this.sc.encode(JSON.stringify({ module: "bybit", attempt: this.reconnectAttempts, delay }))
    );
    setTimeout(async () => {
      if (!this.isRunning) return;
      try {
        await this.connectWebSocket();
        this.log("info", "WebSocket reconnected successfully", { attempt: this.reconnectAttempts });
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
      } catch (err) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        if (this.isRunning) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  async startStreaming(): Promise<{ tradesCollected: number; candlesFlushed: number; snapshotsSaved: number }> {
    this.isRunning = true;
    this.tradeCounter = 0;
    this.snapshotCounter = 0;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    let candlesFlushed = 0;

    try {
      await this.connectWebSocket();

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!this.isRunning) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 1000);

        setTimeout(() => {
          this.isRunning = false;
          clearInterval(checkInterval);
          resolve();
        }, 55000);
      });

      for (const [symbol, candle] of this.candles.entries()) {
        await this.flushCandle(symbol, candle);
        candlesFlushed++;
      }
      this.candles.clear();

    } catch (err) {
      this.log("error", "streaming error", { err: err instanceof Error ? err.message : err });
    } finally {
      this.stopPingInterval();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.isRunning = false;
    }

    return { tradesCollected: this.tradeCounter, candlesFlushed, snapshotsSaved: this.snapshotCounter };
  }

  async collectViaRest(): Promise<{ tradesCollected: number; messagesPublished: number }> {
    this.log("info", "collecting via REST API (fallback)");
    const pairs = this.getPairs();
    let tradesCollected = 0;
    let messagesPublished = 0;

    for (const symbol of pairs) {
      try {
        const url = `${this.settings.restApiUrl}/recent-trade?category=spot&symbol=${symbol}&limit=1000`;
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          this.log("warn", `REST API error for ${symbol}`, { status: res.status });
          continue;
        }
        const body = (await res.json()) as any;
        const trades = body?.result?.list ?? [];
        for (const t of trades) {
          this.tradeCounter++;
          const trade: BybitTrade = {
            trade_id: `bybit_${symbol}_${t.execId}`,
            symbol: symbol,
            price: parseFloat(t.price),
            size: parseFloat(t.size),
            side: String(t.side).toLowerCase(),
            time: new Date(parseInt(t.time, 10)).toISOString(),
          };
          const stored = await this.storeTrade(trade);
          if (stored) tradesCollected++;
        }
      } catch (err) {
        this.log("error", `failed to fetch trades for ${symbol}`, { err: err instanceof Error ? err.message : err });
      }
    }

    this.log("info", "REST collection complete", { tradesCollected });
    return { tradesCollected, messagesPublished };
  }

  async refreshContexts(opts: { lookbackHours: number }): Promise<{
    updated: number;
    aiSummaries: number;
    fallbackSummaries: number;
    embeddingsInserted: number;
    avgTokenRate?: number;
  }> {
    return { updated: 0, aiSummaries: 0, fallbackSummaries: 0, embeddingsInserted: 0 };
  }
}
