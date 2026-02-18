import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";
import WebSocket from "ws";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type CoinbaseSettings = {
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

const UUID_NAMESPACE = "9d6dc9c3-2629-47d1-aee0-e74cbcc6b0ec";

const PUBLIC_WS_URL = "wss://ws-feed.exchange.coinbase.com";
const FALLBACK_WS_URLS = [
  "wss://ws-feed.exchange.coinbase.com",
  "wss://ws-feed.pro.coinbase.com",
];

export function parseCoinbaseSettingsFromInternal(raw: Record<string, unknown>): CoinbaseSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const apiUrl = String(raw.apiUrl ?? "wss://ws-feed.exchange.coinbase.com");
  const restApiUrl = String(raw.restApiUrl ?? "https://api.exchange.coinbase.com");
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedPairs = String(raw.watchedPairs ?? '["BTC-USD", "ETH-USD", "SOL-USD"]');
  const orderbookEnabled = String(raw.orderbookEnabled ?? "true") === "true";
  const candleIntervalSeconds = raw.candleIntervalSeconds ? Number(raw.candleIntervalSeconds) : 60;
  const defaultContextPrompt =
    "You are summarizing CEX trading activity on Coinbase. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('Coinbase setting "whaleThreshold" must be a positive number');
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

interface CoinbaseTrade {
  trade_id: string;
  product_id: string;
  price: string;
  size: string;
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

export class CoinbaseIngestor {
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

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.coinbase.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "coinbase",
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
    private readonly settings: CoinbaseSettings,
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
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_coinbase");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_coinbase.trades (
        id text PRIMARY KEY,
        pair text NOT NULL,
        price numeric NOT NULL,
        size numeric NOT NULL,
        side text NOT NULL,
        notional_usd numeric NOT NULL,
        is_whale boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS coinbase_trades_pair_idx ON mod_coinbase.trades (pair, created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS coinbase_trades_whale_idx ON mod_coinbase.trades (is_whale, created_at) WHERE is_whale = true`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_coinbase.candles (
        id text PRIMARY KEY,
        pair text NOT NULL,
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS coinbase_candles_pair_idx ON mod_coinbase.candles (pair, start_time)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_coinbase.orderbook_snapshots (
        id text PRIMARY KEY,
        pair text NOT NULL,
        bids_json text NOT NULL,
        asks_json text NOT NULL,
        mid_price numeric NOT NULL,
        spread_bps numeric NOT NULL,
        snapshot_at timestamptz NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS coinbase_orderbook_pair_idx ON mod_coinbase.orderbook_snapshots (pair, snapshot_at)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_coinbase.pair_embeddings (
        id text PRIMARY KEY,
        pair text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS coinbase_embeddings_ctx_idx ON mod_coinbase.pair_embeddings (context_key, ts)`
    );
  }

  private getPairs(): string[] {
    try {
      return JSON.parse(this.settings.watchedPairs) as string[];
    } catch {
      return ["BTC-USD", "ETH-USD", "SOL-USD"];
    }
  }

  private async storeTrade(trade: CoinbaseTrade): Promise<boolean> {
    const price = parseFloat(trade.price);
    const size = parseFloat(trade.size);
    const notionalUsd = price * size;
    const isWhale = notionalUsd >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_coinbase.trades (id, pair, price, size, side, notional_usd, is_whale, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [trade.trade_id, trade.product_id, price, size, trade.side, notionalUsd, isWhale, trade.time]
      );

      const tradeEvent = {
        source: "coinbase",
        symbol: trade.product_id,
        side: trade.side as "buy" | "sell",
        price,
        size,
        notional_usd: notionalUsd,
        timestamp: trade.time,
      };
      this.nats.publish(
        subjectFor("coinbase", "tradeExecuted"),
        this.sc.encode(JSON.stringify(tradeEvent))
      );

      if (isWhale) {
        const direction = trade.side === "buy" ? "bullish" : "bearish";
        const messageId = uuidv5(`coinbase:whale:${trade.trade_id}`, UUID_NAMESPACE);
        const messageText = `WHALE TRADE: ${trade.product_id} ${trade.side.toUpperCase()} ${size.toFixed(4)} @ $${price.toLocaleString()} = $${notionalUsd.toLocaleString()}`;

        const normalized = NormalizedMessageSchema.parse({
          id: messageId,
          createdAt: trade.time,
          source: { module: "coinbase", stream: trade.product_id },
          contextRef: { ownerModule: "coinbase", sourceKey: trade.product_id },
          Message: messageText,
          From: "Coinbase",
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          likes: Math.floor(notionalUsd / 1000),
          tags: {
            pair: trade.product_id,
            tradeId: trade.trade_id,
            price: price,
            size: size,
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

        this.nats.publish(subjectFor("coinbase", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
        this.log("info", "whale trade detected", { pair: trade.product_id, notionalUsd, side: trade.side });
      }

      return true;
    } catch (err) {
      this.log("error", "failed to store trade", { tradeId: trade.trade_id, err: err instanceof Error ? err.message : err });
      return false;
    }
  }

  private updateCandle(trade: CoinbaseTrade): void {
    const pair = trade.product_id;
    const price = parseFloat(trade.price);
    const size = parseFloat(trade.size);
    const tradeTime = new Date(trade.time);
    const intervalMs = this.settings.candleIntervalSeconds * 1000;
    const candleStart = new Date(Math.floor(tradeTime.getTime() / intervalMs) * intervalMs);

    const existing = this.candles.get(pair);
    if (existing && existing.startTime.getTime() === candleStart.getTime()) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += size;
      existing.tradeCount++;
    } else {
      if (existing) {
        this.flushCandle(pair, existing);
      }
      this.candles.set(pair, {
        pair,
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

  private async flushCandle(pair: string, candle: CandleData): Promise<void> {
    const candleId = uuidv5(`coinbase:candle:${pair}:${candle.startTime.toISOString()}`, UUID_NAMESPACE);
    try {
      await this.db.query(
        `INSERT INTO mod_coinbase.candles (id, pair, interval_seconds, open_price, high_price, low_price, close_price, volume, trade_count, start_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           high_price = GREATEST(mod_coinbase.candles.high_price, EXCLUDED.high_price),
           low_price = LEAST(mod_coinbase.candles.low_price, EXCLUDED.low_price),
           close_price = EXCLUDED.close_price,
           volume = EXCLUDED.volume,
           trade_count = EXCLUDED.trade_count`,
        [candleId, pair, this.settings.candleIntervalSeconds, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.tradeCount, candle.startTime]
      );
      this.log("debug", "flushed candle", { pair, startTime: candle.startTime.toISOString() });
    } catch (err) {
      this.log("error", "failed to flush candle", { pair, err: err instanceof Error ? err.message : err });
    }
  }

  private updateOrderbook(pair: string, side: string, price: number, size: number): void {
    if (!this.orderbook.has(pair)) {
      this.orderbook.set(pair, { bids: [], asks: [] });
    }
    const book = this.orderbook.get(pair)!;
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

  private async snapshotOrderbook(pair: string): Promise<void> {
    const book = this.orderbook.get(pair);
    if (!book || book.bids.length === 0 || book.asks.length === 0) return;

    const now = Date.now();
    const lastSnapshot = this.lastOrderbookSnapshot.get(pair) ?? 0;
    if (now - lastSnapshot < 60000) return;

    const bestBid = book.bids[0]?.price ?? 0;
    const bestAsk = book.asks[0]?.price ?? 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

    const snapshotId = uuidv5(`coinbase:orderbook:${pair}:${now}`, UUID_NAMESPACE);
    const snapshotTime = new Date(now);

    try {
      await this.db.query(
        `INSERT INTO mod_coinbase.orderbook_snapshots (id, pair, bids_json, asks_json, mid_price, spread_bps, snapshot_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [snapshotId, pair, JSON.stringify(book.bids.slice(0, 20)), JSON.stringify(book.asks.slice(0, 20)), midPrice, spreadBps, snapshotTime]
      );
      this.lastOrderbookSnapshot.set(pair, now);
      this.snapshotCounter++;
      this.log("debug", "saved orderbook snapshot", { pair, midPrice, spreadBps });
    } catch (err) {
      this.log("error", "failed to save orderbook snapshot", { pair, err: err instanceof Error ? err.message : err });
    }
  }

  private connectToUrl(wsUrl: string): Promise<void> {
    const pairs = this.getPairs();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.log("info", "WebSocket connected (public feed, no API key required)", { url: wsUrl });
        this.reconnectDelay = 1000;

        const channels = ["matches"];
        if (this.settings.orderbookEnabled) {
          channels.push("level2_batch");
        }

        const subscribeMsg = {
          type: "subscribe",
          product_ids: pairs,
          channels: channels,
        };
        this.ws!.send(JSON.stringify(subscribeMsg));
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
        if (this.isRunning) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private async connectWebSocket(): Promise<void> {
    const pairs = this.getPairs();
    this.log("info", "connecting to Coinbase public WebSocket", { url: this.settings.apiUrl, pairs });

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

    throw new Error("all Coinbase WebSocket URLs failed");
  }

  private async handleMessage(msg: any): Promise<void> {
    const msgType = msg.type;

    if (msgType === "match" || msgType === "last_match") {
      this.tradeCounter++;
      const trade: CoinbaseTrade = {
        trade_id: String(msg.trade_id),
        product_id: msg.product_id,
        price: msg.price,
        size: msg.size,
        side: msg.side,
        time: msg.time,
      };
      await this.storeTrade(trade);
      this.updateCandle(trade);
    } else if (msgType === "l2update") {
      const pair = msg.product_id;
      const changes = msg.changes || [];
      for (const change of changes) {
        if (change.length >= 3) {
          const side = change[0];
          const price = parseFloat(change[1]);
          const size = parseFloat(change[2]);
          this.updateOrderbook(pair, side, price, size);
        }
      }
      await this.snapshotOrderbook(pair);
    } else if (msgType === "snapshot") {
      const pair = msg.product_id;
      const bids = (msg.bids || []).slice(0, 20).map((b: string[]) => ({ price: parseFloat(b[0]!), size: parseFloat(b[1]!) }));
      const asks = (msg.asks || []).slice(0, 20).map((a: string[]) => ({ price: parseFloat(a[0]!), size: parseFloat(a[1]!) }));
      this.orderbook.set(pair, { bids, asks });
      this.log("info", "received orderbook snapshot", { pair, bids: bids.length, asks: asks.length });
    } else if (msgType === "subscriptions") {
      this.log("info", "subscription confirmed", { channels: msg.channels });
    } else if (msgType === "error") {
      this.log("error", "WebSocket error message", { message: msg.message, reason: msg.reason });
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
      subjectFor("coinbase", "reconnecting"),
      this.sc.encode(JSON.stringify({ module: "coinbase", attempt: this.reconnectAttempts, delay }))
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

      for (const [pair, candle] of this.candles.entries()) {
        await this.flushCandle(pair, candle);
        candlesFlushed++;
      }
      this.candles.clear();

    } catch (err) {
      this.log("error", "streaming error", { err: err instanceof Error ? err.message : err });
    } finally {
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

    for (const pair of pairs) {
      try {
        const url = `${this.settings.restApiUrl}/products/${pair}/trades?limit=100`;
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          this.log("warn", `REST API error for ${pair}`, { status: res.status });
          continue;
        }
        const trades = (await res.json()) as any[];
        for (const t of trades) {
          const trade: CoinbaseTrade = {
            trade_id: String(t.trade_id),
            product_id: pair,
            price: t.price,
            size: t.size,
            side: t.side,
            time: t.time,
          };
          const stored = await this.storeTrade(trade);
          if (stored) tradesCollected++;
        }
      } catch (err) {
        this.log("error", `failed to fetch trades for ${pair}`, { err: err instanceof Error ? err.message : err });
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
