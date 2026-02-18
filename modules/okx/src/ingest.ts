import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";
import WebSocket from "ws";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type OkxSettings = {
  enabled: boolean;
  apiUrl: string;
  restApiUrl: string;
  whaleThreshold: number;
  watchedPairs: string;
  candleIntervalSeconds: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

const UUID_NAMESPACE = "a1c2d3e4-f5a6-47b8-89c0-d1e2f3a4b5c6";

const PUBLIC_WS_URL = "wss://ws.okx.com:8443/ws/v5/public";
const PUBLIC_REST_URL = "https://www.okx.com/api/v5";
const FALLBACK_WS_URLS = [
  "wss://ws.okx.com:8443/ws/v5/public",
  "wss://wsaws.okx.com:8443/ws/v5/public",
];

const PING_INTERVAL_MS = 25000;

export function parseOkxSettingsFromInternal(raw: Record<string, unknown>): OkxSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const apiUrl = String(raw.apiUrl ?? PUBLIC_WS_URL);
  const restApiUrl = String(raw.restApiUrl ?? PUBLIC_REST_URL);
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedPairs = String(raw.watchedPairs ?? '["BTC-USDT", "ETH-USDT", "SOL-USDT"]');
  const candleIntervalSeconds = raw.candleIntervalSeconds ? Number(raw.candleIntervalSeconds) : 60;
  const defaultContextPrompt =
    "You are summarizing CEX trading activity on OKX. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('OKX setting "whaleThreshold" must be a positive number');
  }

  return {
    enabled,
    apiUrl,
    restApiUrl,
    whaleThreshold,
    watchedPairs,
    candleIntervalSeconds,
    contextPrompt,
    contextPromptFallback,
  };
}

interface OkxTrade {
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

export class OkxIngestor {
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
  private tradeCounter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.okx.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "okx",
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
    private readonly settings: OkxSettings,
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
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_okx");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_okx.trades (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS okx_trades_symbol_idx ON mod_okx.trades (symbol, created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS okx_trades_whale_idx ON mod_okx.trades (is_whale, created_at) WHERE is_whale = true`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_okx.candles (
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
    await this.db.query(`CREATE INDEX IF NOT EXISTS okx_candles_symbol_idx ON mod_okx.candles (symbol, start_time)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_okx.pair_embeddings (
        id text PRIMARY KEY,
        symbol text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS okx_embeddings_ctx_idx ON mod_okx.pair_embeddings (context_key, ts)`
    );
  }

  private getPairs(): string[] {
    try {
      return JSON.parse(this.settings.watchedPairs) as string[];
    } catch {
      return ["BTC-USDT", "ETH-USDT", "SOL-USDT"];
    }
  }

  private async storeTrade(trade: OkxTrade): Promise<boolean> {
    const notionalUsd = trade.price * trade.size;
    const isWhale = notionalUsd >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_okx.trades (id, symbol, price, size, side, notional_usd, is_whale, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [trade.trade_id, trade.symbol, trade.price, trade.size, trade.side, notionalUsd, isWhale, trade.time]
      );

      const tradeEvent = {
        source: "okx",
        symbol: trade.symbol,
        side: trade.side as "buy" | "sell",
        price: trade.price,
        size: trade.size,
        notional_usd: notionalUsd,
        timestamp: trade.time,
      };
      this.nats.publish(
        subjectFor("okx", "tradeExecuted"),
        this.sc.encode(JSON.stringify(tradeEvent))
      );

      if (isWhale) {
        const direction = trade.side === "buy" ? "bullish" : "bearish";
        const messageId = uuidv5(`okx:whale:${trade.trade_id}`, UUID_NAMESPACE);
        const messageText = `WHALE TRADE: ${trade.symbol} ${trade.side.toUpperCase()} ${trade.size.toFixed(4)} @ $${trade.price.toLocaleString()} = $${notionalUsd.toLocaleString()}`;

        const normalized = NormalizedMessageSchema.parse({
          id: messageId,
          createdAt: trade.time,
          source: { module: "okx", stream: trade.symbol },
          contextRef: { ownerModule: "okx", sourceKey: trade.symbol },
          Message: messageText,
          From: "OKX",
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

        this.nats.publish(subjectFor("okx", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
        this.log("info", "whale trade detected", { symbol: trade.symbol, notionalUsd, side: trade.side });
      }

      return true;
    } catch (err) {
      this.log("error", "failed to store trade", { tradeId: trade.trade_id, err: err instanceof Error ? err.message : err });
      return false;
    }
  }

  private updateCandle(trade: OkxTrade): void {
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
    const candleId = uuidv5(`okx:candle:${symbol}:${candle.startTime.toISOString()}`, UUID_NAMESPACE);
    try {
      await this.db.query(
        `INSERT INTO mod_okx.candles (id, symbol, interval_seconds, open_price, high_price, low_price, close_price, volume, trade_count, start_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           high_price = GREATEST(mod_okx.candles.high_price, EXCLUDED.high_price),
           low_price = LEAST(mod_okx.candles.low_price, EXCLUDED.low_price),
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

  private subscribeToTrades(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const pairs = this.getPairs();
    const args = pairs.map((instId) => ({ channel: "trades", instId }));
    const subscribeMsg = JSON.stringify({ op: "subscribe", args });
    this.ws.send(subscribeMsg);
    this.log("info", "subscribed to trades channels", { pairs });
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("ping");
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
        this.subscribeToTrades();
        this.startPingInterval();
        resolve();
      });

      this.ws.on("message", async (data: Buffer) => {
        try {
          const raw = data.toString();
          if (raw === "pong") {
            return;
          }
          const msg = JSON.parse(raw);
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
    const primaryUrl = this.settings.apiUrl;
    this.log("info", "connecting to OKX public WebSocket", { url: primaryUrl, pairs: this.getPairs() });

    try {
      await this.connectToUrl(primaryUrl);
      return;
    } catch (err) {
      this.log("warn", "primary WebSocket failed, trying fallback URLs", { err: err instanceof Error ? err.message : err });
    }

    for (const fallbackUrl of FALLBACK_WS_URLS) {
      if (fallbackUrl === primaryUrl) continue;
      try {
        this.log("info", "trying fallback URL", { url: fallbackUrl });
        await this.connectToUrl(fallbackUrl);
        return;
      } catch (err) {
        this.log("warn", "fallback URL failed", { url: fallbackUrl, err: err instanceof Error ? err.message : err });
      }
    }

    throw new Error("all OKX WebSocket URLs failed");
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.event === "subscribe") {
      this.log("info", "subscription confirmed", { arg: msg.arg });
      return;
    }

    if (msg.event === "error") {
      this.log("error", "OKX WebSocket error event", { code: msg.code, msg: msg.msg });
      return;
    }

    if (msg.arg && msg.arg.channel === "trades" && Array.isArray(msg.data)) {
      for (const d of msg.data) {
        this.tradeCounter++;
        const trade: OkxTrade = {
          trade_id: `okx_${d.instId}_${d.tradeId}`,
          symbol: d.instId,
          price: parseFloat(d.px),
          size: parseFloat(d.sz),
          side: d.side,
          time: new Date(parseInt(d.ts, 10)).toISOString(),
        };
        await this.storeTrade(trade);
        this.updateCandle(trade);
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= 10) {
      this.log("error", "module okx circuit breaker tripped", {
        attempts: this.reconnectAttempts,
      });
      this.nats.publish(
        "feedeater.module.dead.okx",
        this.sc.encode(JSON.stringify({ module: "okx", timestamp: new Date().toISOString() }))
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
      subjectFor("okx", "reconnecting"),
      this.sc.encode(JSON.stringify({ module: "okx", attempt: this.reconnectAttempts, delay }))
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

  async startStreaming(): Promise<{ tradesCollected: number; candlesFlushed: number }> {
    this.isRunning = true;
    this.tradeCounter = 0;
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

    return { tradesCollected: this.tradeCounter, candlesFlushed };
  }

  async collectViaRest(): Promise<{ tradesCollected: number; messagesPublished: number }> {
    this.log("info", "collecting via REST API (fallback)");
    const pairs = this.getPairs();
    let tradesCollected = 0;
    let messagesPublished = 0;

    for (const instId of pairs) {
      try {
        const url = `${this.settings.restApiUrl}/market/trades?instId=${instId}&limit=100`;
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          this.log("warn", `REST API error for ${instId}`, { status: res.status });
          continue;
        }
        const body = (await res.json()) as { code: string; data: any[] };
        if (body.code !== "0" || !Array.isArray(body.data)) {
          this.log("warn", `REST API unexpected response for ${instId}`, { code: body.code });
          continue;
        }
        for (const t of body.data) {
          this.tradeCounter++;
          const trade: OkxTrade = {
            trade_id: `okx_${instId}_${t.tradeId}`,
            symbol: instId,
            price: parseFloat(t.px),
            size: parseFloat(t.sz),
            side: t.side,
            time: new Date(parseInt(t.ts, 10)).toISOString(),
          };
          const stored = await this.storeTrade(trade);
          if (stored) tradesCollected++;
        }
      } catch (err) {
        this.log("error", `failed to fetch trades for ${instId}`, { err: err instanceof Error ? err.message : err });
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
