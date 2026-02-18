import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";
import WebSocket from "ws";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type GeminiSettings = {
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

const UUID_NAMESPACE = "a3e8f1c0-7b2d-4e9a-b5d6-1f8c3a2e9d70";

const PUBLIC_WS_URL = "wss://api.gemini.com/v2/marketdata";
const PUBLIC_REST_URL = "https://api.gemini.com/v1";
const FALLBACK_WS_URLS = [
  "wss://api.gemini.com/v2/marketdata",
];

export function parseGeminiSettingsFromInternal(raw: Record<string, unknown>): GeminiSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const apiUrl = String(raw.apiUrl ?? PUBLIC_WS_URL);
  const restApiUrl = String(raw.restApiUrl ?? PUBLIC_REST_URL);
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedPairs = String(raw.watchedPairs ?? '["BTCUSD", "ETHUSD", "SOLUSD"]');
  const orderbookEnabled = String(raw.orderbookEnabled ?? "true") === "true";
  const candleIntervalSeconds = raw.candleIntervalSeconds ? Number(raw.candleIntervalSeconds) : 60;
  const defaultContextPrompt =
    "You are summarizing CEX trading activity on Gemini. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('Gemini setting "whaleThreshold" must be a positive number');
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

interface GeminiTrade {
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

export class GeminiIngestor {
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.gemini.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "gemini",
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
    private readonly settings: GeminiSettings,
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
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_gemini");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_gemini.trades (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS gemini_trades_symbol_idx ON mod_gemini.trades (symbol, created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS gemini_trades_whale_idx ON mod_gemini.trades (is_whale, created_at) WHERE is_whale = true`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_gemini.candles (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS gemini_candles_symbol_idx ON mod_gemini.candles (symbol, start_time)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_gemini.orderbook_snapshots (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS gemini_orderbook_symbol_idx ON mod_gemini.orderbook_snapshots (symbol, snapshot_at)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_gemini.pair_embeddings (
        id text PRIMARY KEY,
        symbol text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS gemini_embeddings_ctx_idx ON mod_gemini.pair_embeddings (context_key, ts)`
    );
  }

  private getPairs(): string[] {
    try {
      return JSON.parse(this.settings.watchedPairs) as string[];
    } catch {
      return ["BTCUSD", "ETHUSD", "SOLUSD"];
    }
  }

  private async storeTrade(trade: GeminiTrade): Promise<boolean> {
    const notionalUsd = trade.price * trade.size;
    const isWhale = notionalUsd >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_gemini.trades (id, symbol, price, size, side, notional_usd, is_whale, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [trade.trade_id, trade.symbol, trade.price, trade.size, trade.side, notionalUsd, isWhale, trade.time]
      );

      const tradeEvent = {
        source: "gemini",
        symbol: trade.symbol,
        side: trade.side as "buy" | "sell",
        price: trade.price,
        size: trade.size,
        notional_usd: notionalUsd,
        timestamp: trade.time,
      };
      this.nats.publish(
        subjectFor("gemini", "tradeExecuted"),
        this.sc.encode(JSON.stringify(tradeEvent))
      );

      if (isWhale) {
        const direction = trade.side === "buy" ? "bullish" : "bearish";
        const messageId = uuidv5(`gemini:whale:${trade.trade_id}`, UUID_NAMESPACE);
        const messageText = `WHALE TRADE: ${trade.symbol} ${trade.side.toUpperCase()} ${trade.size.toFixed(4)} @ $${trade.price.toLocaleString()} = $${notionalUsd.toLocaleString()}`;

        const normalized = NormalizedMessageSchema.parse({
          id: messageId,
          createdAt: trade.time,
          source: { module: "gemini", stream: trade.symbol },
          contextRef: { ownerModule: "gemini", sourceKey: trade.symbol },
          Message: messageText,
          From: "Gemini",
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

        this.nats.publish(subjectFor("gemini", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
        this.log("info", "whale trade detected", { symbol: trade.symbol, notionalUsd, side: trade.side });
      }

      return true;
    } catch (err) {
      this.log("error", "failed to store trade", { tradeId: trade.trade_id, err: err instanceof Error ? err.message : err });
      return false;
    }
  }

  private updateCandle(trade: GeminiTrade): void {
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
    const candleId = uuidv5(`gemini:candle:${symbol}:${candle.startTime.toISOString()}`, UUID_NAMESPACE);
    try {
      await this.db.query(
        `INSERT INTO mod_gemini.candles (id, symbol, interval_seconds, open_price, high_price, low_price, close_price, volume, trade_count, start_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           high_price = GREATEST(mod_gemini.candles.high_price, EXCLUDED.high_price),
           low_price = LEAST(mod_gemini.candles.low_price, EXCLUDED.low_price),
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
    const levels = side === "buy" ? book.bids : book.asks;

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

    if (side === "buy") {
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

    const snapshotId = uuidv5(`gemini:orderbook:${symbol}:${now}`, UUID_NAMESPACE);
    const snapshotTime = new Date(now);

    try {
      await this.db.query(
        `INSERT INTO mod_gemini.orderbook_snapshots (id, symbol, bids_json, asks_json, mid_price, spread_bps, snapshot_at)
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

  private startHeartbeatMonitor(): void {
    this.lastMessageTime = Date.now();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastMessageTime;
      if (elapsed > 30000 && this.isRunning) {
        this.log("warn", "no messages received in 30s, reconnecting");
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close();
        }
      }
    }, 10000);
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private connectToUrl(wsUrl: string): Promise<void> {
    const pairs = this.getPairs();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.log("info", "WebSocket connected (public feed, no API key required)", { url: wsUrl });
        this.reconnectDelay = 1000;

        const subscriptions: { name: string; symbols: string[] }[] = [];

        if (this.settings.orderbookEnabled) {
          subscriptions.push({ name: "l2", symbols: pairs });
        }

        if (subscriptions.length > 0) {
          const subscribeMsg = {
            type: "subscribe",
            subscriptions,
          };
          this.ws!.send(JSON.stringify(subscribeMsg));
          this.log("info", "sent subscription message", { subscriptions });
        }

        this.startHeartbeatMonitor();
        resolve();
      });

      this.ws.on("message", async (data: Buffer) => {
        try {
          this.lastMessageTime = Date.now();
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
        this.stopHeartbeatMonitor();
        if (this.isRunning) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private async connectWebSocket(): Promise<void> {
    const pairs = this.getPairs();
    this.log("info", "connecting to Gemini public WebSocket v2", { url: this.settings.apiUrl, pairs });

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

    throw new Error("all Gemini WebSocket URLs failed");
  }

  private async handleMessage(msg: any): Promise<void> {
    const msgType = msg.type;

    if (msgType === "heartbeat") {
      return;
    }

    if (msgType === "trade") {
      this.tradeCounter++;
      const trade: GeminiTrade = {
        trade_id: `gemini_${msg.symbol}_${msg.tid}`,
        symbol: msg.symbol,
        price: parseFloat(msg.price),
        size: parseFloat(msg.quantity),
        side: msg.side,
        time: new Date(msg.timestamp).toISOString(),
      };
      await this.storeTrade(trade);
      this.updateCandle(trade);
    } else if (msgType === "l2_updates") {
      const symbol = msg.symbol;

      if (Array.isArray(msg.changes)) {
        for (const change of msg.changes) {
          if (Array.isArray(change) && change.length >= 3) {
            const side = change[0];
            const price = parseFloat(change[1]);
            const size = parseFloat(change[2]);
            this.updateOrderbook(symbol, side, price, size);
          }
        }
        await this.snapshotOrderbook(symbol);
      }

      if (Array.isArray(msg.trades)) {
        for (const t of msg.trades) {
          if (t.type === "trade") {
            this.tradeCounter++;
            const trade: GeminiTrade = {
              trade_id: `gemini_${t.symbol ?? symbol}_${t.tid}`,
              symbol: t.symbol ?? symbol,
              price: parseFloat(t.price),
              size: parseFloat(t.quantity),
              side: t.side,
              time: new Date(t.timestamp).toISOString(),
            };
            await this.storeTrade(trade);
            this.updateCandle(trade);
          }
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= 10) {
      this.log("error", "module gemini circuit breaker tripped", {
        attempts: this.reconnectAttempts,
      });
      this.nats.publish(
        "feedeater.module.dead.gemini",
        this.sc.encode(JSON.stringify({ module: "gemini", timestamp: new Date().toISOString() }))
      );
      this.isRunning = false;
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
      subjectFor("gemini", "reconnecting"),
      this.sc.encode(JSON.stringify({ module: "gemini", attempt: this.reconnectAttempts, delay }))
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
      this.stopHeartbeatMonitor();
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
        const url = `${this.settings.restApiUrl}/trades/${symbol}?limit_trades=500`;
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          this.log("warn", `REST API error for ${symbol}`, { status: res.status });
          continue;
        }
        const trades = (await res.json()) as any[];
        for (const t of trades) {
          this.tradeCounter++;
          const trade: GeminiTrade = {
            trade_id: `gemini_${symbol}_${t.tid}`,
            symbol: symbol,
            price: parseFloat(t.price),
            size: parseFloat(t.amount),
            side: t.type,
            time: new Date(t.timestampms).toISOString(),
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
