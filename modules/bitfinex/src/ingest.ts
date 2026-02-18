import { v5 as uuidv5 } from "uuid";
import type { NatsLike, DbLike, StringCodecLike } from "@feedeater/module-sdk";
import WebSocket from "ws";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type BitfinexSettings = {
  enabled: boolean;
  apiUrl: string;
  restApiUrl: string;
  whaleThreshold: number;
  watchedPairs: string;
  candleIntervalSeconds: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

// Deterministic UUID namespace for bitfinex (generated once, fixed)
const UUID_NAMESPACE = "b2f4a916-e8c1-4a73-9d21-3fc87e1a0042";

const PUBLIC_WS_URL = "wss://api-pub.bitfinex.com/ws/2";
const PUBLIC_REST_URL = "https://api-pub.bitfinex.com/v2";

export function parseBitfinexSettingsFromInternal(raw: Record<string, unknown>): BitfinexSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const apiUrl = String(raw.apiUrl ?? PUBLIC_WS_URL);
  const restApiUrl = String(raw.restApiUrl ?? PUBLIC_REST_URL);
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const watchedPairs = String(raw.watchedPairs ?? '["tBTCUSD", "tETHUSD", "tSOLUSD"]');
  const candleIntervalSeconds = raw.candleIntervalSeconds ? Number(raw.candleIntervalSeconds) : 60;

  const defaultContextPrompt =
    "You are summarizing CEX trading activity on Bitfinex. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('Bitfinex setting "whaleThreshold" must be a positive number');
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

// Bitfinex strip the 't' prefix for display symbol (tBTCUSD → BTCUSD)
function toDisplaySymbol(pair: string): string {
  return pair.startsWith("t") ? pair.slice(1) : pair;
}

interface BitfinexTrade {
  trade_id: string;
  symbol: string;
  displaySymbol: string;
  price: number;
  size: number;
  side: "buy" | "sell";
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

export class BitfinexIngestor {
  private feedApiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
  private isRunning = false;
  private candles: Map<string, CandleData> = new Map();
  private tradeCounter = 0;
  // chanId → Bitfinex symbol (e.g., "tBTCUSD")
  private channelMap: Map<number, string> = new Map();

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.bitfinex.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "bitfinex",
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
    private readonly settings: BitfinexSettings,
    private readonly db: DbLike,
    private readonly nats: NatsLike,
    private readonly sc: StringCodecLike,
    opts: { apiBaseUrl: string; internalToken: string; contextTopK: number; embedDim: number }
  ) {
    this.feedApiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_bitfinex");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_bitfinex.trades (
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
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS bitfinex_trades_symbol_idx ON mod_bitfinex.trades (symbol, created_at)`
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS bitfinex_trades_whale_idx ON mod_bitfinex.trades (is_whale, created_at) WHERE is_whale = true`
    );

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_bitfinex.candles (
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
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS bitfinex_candles_symbol_idx ON mod_bitfinex.candles (symbol, start_time)`
    );
  }

  private getPairs(): string[] {
    try {
      return JSON.parse(this.settings.watchedPairs) as string[];
    } catch {
      return ["tBTCUSD", "tETHUSD", "tSOLUSD"];
    }
  }

  private async storeTrade(trade: BitfinexTrade): Promise<boolean> {
    const notionalUsd = trade.price * trade.size;
    const isWhale = notionalUsd >= this.settings.whaleThreshold;

    try {
      await this.db.query(
        `INSERT INTO mod_bitfinex.trades (id, symbol, price, size, side, notional_usd, is_whale, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [trade.trade_id, trade.displaySymbol, trade.price, trade.size, trade.side, notionalUsd, isWhale, trade.time]
      );

      // Publish tradeExecuted event
      const tradeEvent = {
        source: "bitfinex",
        symbol: trade.displaySymbol,
        side: trade.side,
        price: trade.price,
        size: trade.size,
        notional_usd: notionalUsd,
        timestamp: trade.time,
      };
      this.nats.publish(subjectFor("bitfinex", "tradeExecuted"), this.sc.encode(JSON.stringify(tradeEvent)));

      if (isWhale) {
        const direction = trade.side === "buy" ? "bullish" : "bearish";
        const messageId = uuidv5(`bitfinex:whale:${trade.trade_id}`, UUID_NAMESPACE);
        const messageText = `WHALE TRADE: ${trade.displaySymbol} ${trade.side.toUpperCase()} ${trade.size.toFixed(4)} @ $${trade.price.toLocaleString()} = $${notionalUsd.toLocaleString()}`;

        const normalized = NormalizedMessageSchema.parse({
          id: messageId,
          createdAt: trade.time,
          source: { module: "bitfinex", stream: trade.displaySymbol },
          contextRef: { ownerModule: "bitfinex", sourceKey: trade.displaySymbol },
          Message: messageText,
          From: "Bitfinex",
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          likes: Math.floor(notionalUsd / 1000),
          tags: {
            symbol: trade.displaySymbol,
            tradeId: trade.trade_id,
            price: trade.price,
            size: trade.size,
            side: trade.side,
            notionalUsd,
            isWhale: true,
            direction,
          },
        });

        const msgEvent = MessageCreatedEventSchema.parse({
          type: "MessageCreated",
          message: normalized,
        });

        this.nats.publish(subjectFor("bitfinex", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
        this.log("info", "whale trade detected", { symbol: trade.displaySymbol, notionalUsd, side: trade.side });
      }

      return true;
    } catch (err) {
      this.log("error", "failed to store trade", {
        tradeId: trade.trade_id,
        err: err instanceof Error ? err.message : err,
      });
      return false;
    }
  }

  private updateCandle(trade: BitfinexTrade): void {
    const symbol = trade.displaySymbol;
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
        void this.flushCandle(symbol, existing);
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
    const candleId = uuidv5(`bitfinex:candle:${symbol}:${candle.startTime.toISOString()}`, UUID_NAMESPACE);
    try {
      await this.db.query(
        `INSERT INTO mod_bitfinex.candles (id, symbol, interval_seconds, open_price, high_price, low_price, close_price, volume, trade_count, start_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           high_price = GREATEST(mod_bitfinex.candles.high_price, EXCLUDED.high_price),
           low_price = LEAST(mod_bitfinex.candles.low_price, EXCLUDED.low_price),
           close_price = EXCLUDED.close_price,
           volume = EXCLUDED.volume,
           trade_count = EXCLUDED.trade_count`,
        [
          candleId,
          symbol,
          this.settings.candleIntervalSeconds,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          candle.tradeCount,
          candle.startTime,
        ]
      );
      this.log("debug", "flushed candle", { symbol, startTime: candle.startTime.toISOString() });
    } catch (err) {
      this.log("error", "failed to flush candle", { symbol, err: err instanceof Error ? err.message : err });
    }
  }

  // Handle a single Bitfinex trade array: [ID, TIME_MS, AMOUNT, PRICE]
  // amount > 0 = buy (taker bought), amount < 0 = sell (taker sold)
  private async handleTradeArray(symbol: string, tradeArr: unknown[]): Promise<void> {
    if (!Array.isArray(tradeArr) || tradeArr.length < 4) return;

    const [rawId, rawTime, rawAmount, rawPrice] = tradeArr;
    const tradeId = `bitfinex_${symbol}_${rawId}`;
    const timeMsRaw = Number(rawTime);
    const amount = Number(rawAmount);
    const price = Number(rawPrice);

    if (!Number.isFinite(price) || !Number.isFinite(amount) || price <= 0) return;

    const size = Math.abs(amount);
    const side: "buy" | "sell" = amount > 0 ? "buy" : "sell";
    const time = new Date(Number.isFinite(timeMsRaw) ? timeMsRaw : Date.now()).toISOString();
    const displaySymbol = toDisplaySymbol(symbol);

    const trade: BitfinexTrade = { trade_id: tradeId, symbol, displaySymbol, price, size, side, time };
    this.tradeCounter++;
    await this.storeTrade(trade);
    this.updateCandle(trade);
  }

  // Parse incoming WebSocket messages
  private async handleMessage(raw: unknown): Promise<void> {
    // Event objects: {"event": "...", ...}
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const ev = raw as Record<string, unknown>;
      if (ev.event === "subscribed" && ev.channel === "trades") {
        const chanId = Number(ev.chanId);
        const sym = String(ev.symbol ?? "");
        if (Number.isFinite(chanId) && sym) {
          this.channelMap.set(chanId, sym);
          this.log("info", "subscribed to trades channel", { chanId, symbol: sym });
        }
      } else if (ev.event === "error") {
        this.log("error", "Bitfinex WS error", { code: ev.code, msg: ev.msg });
      } else if (ev.event === "info") {
        const code = Number(ev.code);
        if (code === 20051) {
          this.log("warn", "Bitfinex server reload signal — reconnecting");
          if (this.ws) this.ws.close();
        } else if (code === 20060) {
          this.log("warn", "Bitfinex maintenance mode started");
        } else if (code === 20061) {
          this.log("info", "Bitfinex maintenance mode ended — resubscribing");
          this.resubscribeAll();
        }
      }
      return;
    }

    // Array messages: [chanId, "te" | "tu" | "hb" | [...snapshot]]
    if (!Array.isArray(raw) || raw.length < 2) return;

    const [chanId, payload] = raw as [unknown, unknown];
    const cid = Number(chanId);
    if (!Number.isFinite(cid)) return;

    const symbol = this.channelMap.get(cid);
    if (!symbol) return; // not a subscribed channel

    // Heartbeat
    if (payload === "hb") return;

    // Trade update: [chanId, "te", [ID, TIME, AMOUNT, PRICE]]
    // "tu" is the confirmed version — we use "te" for lowest latency
    if (payload === "te" && raw.length >= 3) {
      const tradeData = raw[2];
      if (Array.isArray(tradeData)) {
        await this.handleTradeArray(symbol, tradeData);
      }
      return;
    }

    // Initial snapshot: [chanId, [[ID,TIME,AMOUNT,PRICE], ...]]
    if (Array.isArray(payload)) {
      for (const entry of payload) {
        if (Array.isArray(entry)) {
          await this.handleTradeArray(symbol, entry);
        }
      }
    }
  }

  private resubscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.channelMap.clear();
    for (const pair of this.getPairs()) {
      this.ws.send(JSON.stringify({ event: "subscribe", channel: "trades", symbol: pair }));
    }
  }

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.settings.apiUrl;
      this.log("info", "connecting to Bitfinex WebSocket v2", { url: wsUrl, pairs: this.getPairs() });

      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.log("info", "Bitfinex WebSocket connected (public feed, no auth required)", { url: wsUrl });
        this.reconnectDelay = 1000;

        // Subscribe to trades for each watched pair
        for (const pair of this.getPairs()) {
          this.ws!.send(JSON.stringify({ event: "subscribe", channel: "trades", symbol: pair }));
        }
        resolve();
      });

      this.ws.on("message", async (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString());
          await this.handleMessage(parsed);
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

  private scheduleReconnect(): void {
    this.log("info", `scheduling reconnect in ${this.reconnectDelay}ms`);
    setTimeout(async () => {
      try {
        await this.connectWebSocket();
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        if (this.isRunning) {
          this.scheduleReconnect();
        }
      }
    }, this.reconnectDelay);
  }

  async startStreaming(): Promise<{ tradesCollected: number; candlesFlushed: number }> {
    this.isRunning = true;
    this.tradeCounter = 0;
    let candlesFlushed = 0;

    try {
      await this.connectWebSocket();

      // Run for 55 seconds (same as binance) then flush and exit
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

      // Flush all open candles
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

    return { tradesCollected: this.tradeCounter, candlesFlushed };
  }

  // REST fallback: pull recent trades for each pair
  async collectViaRest(): Promise<{ tradesCollected: number }> {
    this.log("info", "collecting via Bitfinex REST API (fallback)");
    const pairs = this.getPairs();
    let tradesCollected = 0;

    for (const pair of pairs) {
      try {
        const url = `${this.settings.restApiUrl}/trades/${pair}/hist?limit=500&sort=-1`;
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          this.log("warn", `REST API error for ${pair}`, { status: res.status });
          continue;
        }
        // Returns: [[ID, MTS, AMOUNT, PRICE], ...]
        const trades = (await res.json()) as unknown[][];
        for (const t of trades) {
          await this.handleTradeArray(pair, t);
          tradesCollected++;
        }
      } catch (err) {
        this.log("error", `failed to fetch trades for ${pair}`, {
          err: err instanceof Error ? err.message : err,
        });
      }
    }

    this.log("info", "REST collection complete", { tradesCollected });
    return { tradesCollected };
  }

  async refreshContexts(_opts: { lookbackHours: number }): Promise<{
    updated: number;
    aiSummaries: number;
    fallbackSummaries: number;
    embeddingsInserted: number;
    avgTokenRate?: number;
  }> {
    // Stub — context refresh handled by a future AI summarizer pass
    return { updated: 0, aiSummaries: 0, fallbackSummaries: 0, embeddingsInserted: 0 };
  }
}
