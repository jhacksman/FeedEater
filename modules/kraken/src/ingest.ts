import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";
import WebSocket from "ws";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type KrakenSettings = {
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

const UUID_NAMESPACE = "k1a2b3c4-d5e6-f7a8-b9c0-d1e2f3a4b5c6";

export function parseKrakenSettingsFromInternal(raw: Record<string, unknown>): KrakenSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const apiUrl = String(raw.apiUrl ?? "wss://ws.kraken.com/v2");
  const restApiUrl = String(raw.restApiUrl ?? "https://api.kraken.com/0/public");
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedPairs = String(raw.watchedPairs ?? '["XBT/USD", "ETH/USD", "SOL/USD"]');
  const orderbookEnabled = String(raw.orderbookEnabled ?? "true") === "true";
  const candleIntervalSeconds = raw.candleIntervalSeconds ? Number(raw.candleIntervalSeconds) : 60;
  const defaultContextPrompt =
    "You are summarizing CEX trading activity on Kraken. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('Kraken setting "whaleThreshold" must be a positive number');
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

interface KrakenTrade {
  trade_id: string;
  pair: string;
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

export class KrakenIngestor {
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
        "feedeater.kraken.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "kraken",
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
    private readonly settings: KrakenSettings,
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
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_kraken");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kraken.trades (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS kraken_trades_pair_idx ON mod_kraken.trades (pair, created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS kraken_trades_whale_idx ON mod_kraken.trades (is_whale, created_at) WHERE is_whale = true`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kraken.candles (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS kraken_candles_pair_idx ON mod_kraken.candles (pair, start_time)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kraken.orderbook_snapshots (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS kraken_orderbook_pair_idx ON mod_kraken.orderbook_snapshots (pair, snapshot_at)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kraken.pair_embeddings (
        id text PRIMARY KEY,
        pair text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS kraken_embeddings_ctx_idx ON mod_kraken.pair_embeddings (context_key, ts)`
    );
  }

  private getPairs(): string[] {
    try {
      return JSON.parse(this.settings.watchedPairs) as string[];
    } catch {
      return ["XBT/USD", "ETH/USD", "SOL/USD"];
    }
  }

  private async storeTrade(trade: KrakenTrade): Promise<boolean> {
    const notionalUsd = trade.price * trade.size;
    const isWhale = notionalUsd >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_kraken.trades (id, pair, price, size, side, notional_usd, is_whale, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [trade.trade_id, trade.pair, trade.price, trade.size, trade.side, notionalUsd, isWhale, trade.time]
      );

      const tradeEvent = {
        source: "kraken",
        symbol: trade.pair,
        side: trade.side as "buy" | "sell",
        price: trade.price,
        size: trade.size,
        notional_usd: notionalUsd,
        timestamp: trade.time,
      };
      this.nats.publish(
        subjectFor("kraken", "tradeExecuted"),
        this.sc.encode(JSON.stringify(tradeEvent))
      );

      if (isWhale) {
        const direction = trade.side === "buy" ? "bullish" : "bearish";
        const messageId = uuidv5(`kraken:whale:${trade.trade_id}`, UUID_NAMESPACE);
        const messageText = `WHALE TRADE: ${trade.pair} ${trade.side.toUpperCase()} ${trade.size.toFixed(4)} @ $${trade.price.toLocaleString()} = $${notionalUsd.toLocaleString()}`;

        const normalized = NormalizedMessageSchema.parse({
          id: messageId,
          createdAt: trade.time,
          source: { module: "kraken", stream: trade.pair },
          contextRef: { ownerModule: "kraken", sourceKey: trade.pair },
          Message: messageText,
          From: "Kraken",
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          likes: Math.floor(notionalUsd / 1000),
          tags: {
            pair: trade.pair,
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

        this.nats.publish(subjectFor("kraken", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
        this.log("info", "whale trade detected", { pair: trade.pair, notionalUsd, side: trade.side });
      }

      return true;
    } catch (err) {
      this.log("error", "failed to store trade", { tradeId: trade.trade_id, err: err instanceof Error ? err.message : err });
      return false;
    }
  }

  private updateCandle(trade: KrakenTrade): void {
    const pair = trade.pair;
    const price = trade.price;
    const size = trade.size;
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
    const candleId = uuidv5(`kraken:candle:${pair}:${candle.startTime.toISOString()}`, UUID_NAMESPACE);
    try {
      await this.db.query(
        `INSERT INTO mod_kraken.candles (id, pair, interval_seconds, open_price, high_price, low_price, close_price, volume, trade_count, start_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           high_price = GREATEST(mod_kraken.candles.high_price, EXCLUDED.high_price),
           low_price = LEAST(mod_kraken.candles.low_price, EXCLUDED.low_price),
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

    const snapshotId = uuidv5(`kraken:orderbook:${pair}:${now}`, UUID_NAMESPACE);
    const snapshotTime = new Date(now);

    try {
      await this.db.query(
        `INSERT INTO mod_kraken.orderbook_snapshots (id, pair, bids_json, asks_json, mid_price, spread_bps, snapshot_at)
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

  private async connectWebSocket(): Promise<void> {
    const pairs = this.getPairs();
    this.log("info", "connecting to Kraken WebSocket", { url: this.settings.apiUrl, pairs });

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.settings.apiUrl);

      this.ws.on("open", () => {
        this.log("info", "WebSocket connected");
        this.reconnectDelay = 1000;

        const tradeSubscribe = {
          method: "subscribe",
          params: {
            channel: "trade",
            symbol: pairs,
          },
        };
        this.ws!.send(JSON.stringify(tradeSubscribe));

        if (this.settings.orderbookEnabled) {
          const bookSubscribe = {
            method: "subscribe",
            params: {
              channel: "book",
              symbol: pairs,
              depth: 25,
            },
          };
          this.ws!.send(JSON.stringify(bookSubscribe));
        }

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

  private async handleMessage(msg: any): Promise<void> {
    const channel = msg.channel;

    if (channel === "trade") {
      const trades = msg.data || [];
      for (const t of trades) {
        this.tradeCounter++;
        const trade: KrakenTrade = {
          trade_id: `kraken_${t.symbol}_${t.timestamp}_${this.tradeCounter}`,
          pair: t.symbol,
          price: parseFloat(t.price),
          size: parseFloat(t.qty),
          side: t.side,
          time: new Date(t.timestamp).toISOString(),
        };
        await this.storeTrade(trade);
        this.updateCandle(trade);
      }
    } else if (channel === "book") {
      const pair = msg.data?.[0]?.symbol;
      if (!pair) return;

      const bookData = msg.data[0];
      if (bookData.bids) {
        for (const bid of bookData.bids) {
          const price = parseFloat(bid.price);
          const size = parseFloat(bid.qty);
          this.updateOrderbook(pair, "bid", price, size);
        }
      }
      if (bookData.asks) {
        for (const ask of bookData.asks) {
          const price = parseFloat(ask.price);
          const size = parseFloat(ask.qty);
          this.updateOrderbook(pair, "ask", price, size);
        }
      }
      await this.snapshotOrderbook(pair);
    } else if (msg.method === "subscribe" && msg.success) {
      this.log("info", "subscription confirmed", { channel: msg.result?.channel });
    } else if (msg.error) {
      this.log("error", "WebSocket error message", { error: msg.error });
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

    const pairMapping: Record<string, string> = {
      "XBT/USD": "XBTUSD",
      "ETH/USD": "ETHUSD",
      "SOL/USD": "SOLUSD",
    };

    for (const pair of pairs) {
      try {
        const restPair = pairMapping[pair] ?? pair.replace("/", "");
        const url = `${this.settings.restApiUrl}/Trades?pair=${restPair}`;
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          this.log("warn", `REST API error for ${pair}`, { status: res.status });
          continue;
        }
        const data = (await res.json()) as any;
        if (data.error && data.error.length > 0) {
          this.log("warn", `Kraken API error for ${pair}`, { error: data.error });
          continue;
        }

        const result = data.result || {};
        for (const [key, trades] of Object.entries(result)) {
          if (key === "last" || !Array.isArray(trades)) continue;
          for (const t of trades as any[]) {
            this.tradeCounter++;
            const trade: KrakenTrade = {
              trade_id: `kraken_${pair}_${t[2]}_${this.tradeCounter}`,
              pair: pair,
              price: parseFloat(t[0]),
              size: parseFloat(t[1]),
              side: t[3] === "b" ? "buy" : "sell",
              time: new Date(parseFloat(t[2]) * 1000).toISOString(),
            };
            const stored = await this.storeTrade(trade);
            if (stored) tradesCollected++;
          }
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
