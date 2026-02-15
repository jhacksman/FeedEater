import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";
import WebSocket from "ws";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type BinanceSettings = {
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

const UUID_NAMESPACE = "74b11840-44f9-4e97-b6bc-c5df3b289b31";

const PUBLIC_WS_URL = "wss://stream.binance.com:9443/ws";
const PUBLIC_REST_URL = "https://api.binance.com/api/v3";
const FALLBACK_WS_URLS = [
  "wss://stream.binance.com:9443/ws",
  "wss://stream.binance.us:9443/ws",
];

export function parseBinanceSettingsFromInternal(raw: Record<string, unknown>): BinanceSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const apiUrl = String(raw.apiUrl ?? PUBLIC_WS_URL);
  const restApiUrl = String(raw.restApiUrl ?? PUBLIC_REST_URL);
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedPairs = String(raw.watchedPairs ?? '["BTCUSDT", "ETHUSDT", "SOLUSDT"]');
  const orderbookEnabled = String(raw.orderbookEnabled ?? "true") === "true";
  const candleIntervalSeconds = raw.candleIntervalSeconds ? Number(raw.candleIntervalSeconds) : 60;
  const defaultContextPrompt =
    "You are summarizing CEX trading activity on Binance. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('Binance setting "whaleThreshold" must be a positive number');
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

interface BinanceTrade {
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

export class BinanceIngestor {
  private feedApiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
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
        "feedeater.binance.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "binance",
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
    private readonly settings: BinanceSettings,
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
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_binance");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_binance.trades (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS binance_trades_symbol_idx ON mod_binance.trades (symbol, created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS binance_trades_whale_idx ON mod_binance.trades (is_whale, created_at) WHERE is_whale = true`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_binance.candles (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS binance_candles_symbol_idx ON mod_binance.candles (symbol, start_time)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_binance.orderbook_snapshots (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS binance_orderbook_symbol_idx ON mod_binance.orderbook_snapshots (symbol, snapshot_at)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_binance.pair_embeddings (
        id text PRIMARY KEY,
        symbol text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS binance_embeddings_ctx_idx ON mod_binance.pair_embeddings (context_key, ts)`
    );
  }

  private getPairs(): string[] {
    try {
      return JSON.parse(this.settings.watchedPairs) as string[];
    } catch {
      return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    }
  }

  private async storeTrade(trade: BinanceTrade): Promise<boolean> {
    const notionalUsd = trade.price * trade.size;
    const isWhale = notionalUsd >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_binance.trades (id, symbol, price, size, side, notional_usd, is_whale, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [trade.trade_id, trade.symbol, trade.price, trade.size, trade.side, notionalUsd, isWhale, trade.time]
      );

      const tradeEvent = {
        source: "binance",
        symbol: trade.symbol,
        side: trade.side as "buy" | "sell",
        price: trade.price,
        size: trade.size,
        notional_usd: notionalUsd,
        timestamp: trade.time,
      };
      this.nats.publish(
        subjectFor("binance", "tradeExecuted"),
        this.sc.encode(JSON.stringify(tradeEvent))
      );

      if (isWhale) {
        const direction = trade.side === "buy" ? "bullish" : "bearish";
        const messageId = uuidv5(`binance:whale:${trade.trade_id}`, UUID_NAMESPACE);
        const messageText = `WHALE TRADE: ${trade.symbol} ${trade.side.toUpperCase()} ${trade.size.toFixed(4)} @ $${trade.price.toLocaleString()} = $${notionalUsd.toLocaleString()}`;

        const normalized = NormalizedMessageSchema.parse({
          id: messageId,
          createdAt: trade.time,
          source: { module: "binance", stream: trade.symbol },
          contextRef: { ownerModule: "binance", sourceKey: trade.symbol },
          Message: messageText,
          From: "Binance",
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

        this.nats.publish(subjectFor("binance", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
        this.log("info", "whale trade detected", { symbol: trade.symbol, notionalUsd, side: trade.side });
      }

      return true;
    } catch (err) {
      this.log("error", "failed to store trade", { tradeId: trade.trade_id, err: err instanceof Error ? err.message : err });
      return false;
    }
  }

  private updateCandle(trade: BinanceTrade): void {
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
    const candleId = uuidv5(`binance:candle:${symbol}:${candle.startTime.toISOString()}`, UUID_NAMESPACE);
    try {
      await this.db.query(
        `INSERT INTO mod_binance.candles (id, symbol, interval_seconds, open_price, high_price, low_price, close_price, volume, trade_count, start_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           high_price = GREATEST(mod_binance.candles.high_price, EXCLUDED.high_price),
           low_price = LEAST(mod_binance.candles.low_price, EXCLUDED.low_price),
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

    const snapshotId = uuidv5(`binance:orderbook:${symbol}:${now}`, UUID_NAMESPACE);
    const snapshotTime = new Date(now);

    try {
      await this.db.query(
        `INSERT INTO mod_binance.orderbook_snapshots (id, symbol, bids_json, asks_json, mid_price, spread_bps, snapshot_at)
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

  private buildWsUrl(baseUrl: string): string {
    const pairs = this.getPairs();
    const streams = pairs.map((p) => `${p.toLowerCase()}@trade`);
    if (this.settings.orderbookEnabled) {
      for (const p of pairs) {
        streams.push(`${p.toLowerCase()}@depth@100ms`);
      }
    }
    return `${baseUrl}/${streams.join("/")}`;
  }

  private connectToUrl(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.log("info", "WebSocket connected (public feed, no API key required)", { url: wsUrl });
        this.reconnectDelay = 1000;
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
    const primaryUrl = this.buildWsUrl(this.settings.apiUrl);
    this.log("info", "connecting to Binance public WebSocket", { url: primaryUrl, pairs: this.getPairs() });

    try {
      await this.connectToUrl(primaryUrl);
      return;
    } catch (err) {
      this.log("warn", "primary WebSocket failed, trying fallback URLs", { err: err instanceof Error ? err.message : err });
    }

    for (const fallbackBase of FALLBACK_WS_URLS) {
      const fallbackUrl = this.buildWsUrl(fallbackBase);
      if (fallbackUrl === primaryUrl) continue;
      try {
        this.log("info", "trying fallback URL", { url: fallbackUrl });
        await this.connectToUrl(fallbackUrl);
        return;
      } catch (err) {
        this.log("warn", "fallback URL failed", { url: fallbackUrl, err: err instanceof Error ? err.message : err });
      }
    }

    throw new Error("all Binance WebSocket URLs failed");
  }

  private async handleMessage(msg: any): Promise<void> {
    const eventType = msg.e;

    if (eventType === "trade") {
      this.tradeCounter++;
      const trade: BinanceTrade = {
        trade_id: `binance_${msg.s}_${msg.t}`,
        symbol: msg.s,
        price: parseFloat(msg.p),
        size: parseFloat(msg.q),
        side: msg.m ? "sell" : "buy",
        time: new Date(msg.T).toISOString(),
      };
      await this.storeTrade(trade);
      this.updateCandle(trade);
    } else if (eventType === "depthUpdate") {
      const symbol = msg.s;
      const bids = msg.b || [];
      const asks = msg.a || [];

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
    this.log("info", `scheduling reconnect in ${this.reconnectDelay}ms`);
    setTimeout(async () => {
      try {
        await this.connectWebSocket();
      } catch (err) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        if (this.isRunning) {
          this.scheduleReconnect();
        }
      }
    }, this.reconnectDelay);
  }

  async startStreaming(): Promise<{ tradesCollected: number; candlesFlushed: number; snapshotsSaved: number }> {
    this.isRunning = true;
    this.tradeCounter = 0;
    this.snapshotCounter = 0;
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
        const url = `${this.settings.restApiUrl}/trades?symbol=${symbol}&limit=1000`;
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
          const trade: BinanceTrade = {
            trade_id: `binance_${symbol}_${t.id}`,
            symbol: symbol,
            price: parseFloat(t.price),
            size: parseFloat(t.qty),
            side: t.isBuyerMaker ? "sell" : "buy",
            time: new Date(t.time).toISOString(),
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
