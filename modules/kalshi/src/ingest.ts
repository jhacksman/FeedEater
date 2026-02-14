import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";

import { ContextUpdatedEventSchema, MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type KalshiSettings = {
  enabled: boolean;
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
  watchedMarkets: string;
  collectTrades: boolean;
  collectOrderbook: boolean;
  collectCandles: boolean;
  lookbackHours: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

const UUID_NAMESPACE = "b2c4d6e8-1a3b-5c7d-9e0f-2a4b6c8d0e1f";
const KALSHI_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export function parseKalshiSettingsFromInternal(raw: Record<string, unknown>): KalshiSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const apiKey = raw.apiKey ? String(raw.apiKey) : undefined;
  const apiSecret = raw.apiSecret ? String(raw.apiSecret) : undefined;
  const watchedMarkets = String(raw.watchedMarkets ?? "[]");
  const collectTrades = String(raw.collectTrades ?? "true") !== "false";
  const collectOrderbook = String(raw.collectOrderbook ?? "false") === "true";
  const collectCandles = String(raw.collectCandles ?? "true") !== "false";
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const defaultContextPrompt =
    "You are summarizing prediction market activity. Summarize ONLY the market data provided. Include current prices, volume, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided market data in plain text. 1-3 short sentences about price and volume. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Kalshi setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    apiKey,
    apiSecret,
    watchedMarkets,
    collectTrades,
    collectOrderbook,
    collectCandles,
    lookbackHours,
    contextPrompt,
    contextPromptFallback,
  };
}

interface KalshiMarket {
  ticker: string;
  title: string;
  subtitle: string;
  event_ticker: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  status: string;
  close_time: string;
  result: string;
}

interface KalshiTrade {
  trade_id: string;
  ticker: string;
  count: number;
  yes_price: number;
  no_price: number;
  taker_side: string;
  created_time: string;
}

interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string;
}

interface KalshiTradesResponse {
  trades: KalshiTrade[];
  cursor: string;
}

interface KalshiCandle {
  end_period_ts: number;
  price: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface KalshiCandlesResponse {
  candlesticks: KalshiCandle[];
  ticker: string;
}

type KalshiMarketRow= {
  ticker: string;
  title: string;
  subtitle: string | null;
  last_price: number;
  yes_bid: number;
  yes_ask: number;
  volume_24h: number;
  open_interest: number;
  status: string;
};

export class KalshiIngestor {
  private feedApiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;
  private requestTimeoutMs: number;
  private lastOrderbookSnapshot = new Map<string, number>();

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.kalshi.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "kalshi",
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
    private readonly settings: KalshiSettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodec,
    opts: { apiBaseUrl: string; internalToken: string; contextTopK: number; embedDim: number }
  ) {
    this.feedApiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
    this.requestTimeoutMs = 15_000;
  }

  private async fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const reqHeaders: Record<string, string> = {
        accept: "application/json",
        ...(headers ?? {}),
      };
      const res = await fetch(url, { signal: controller.signal, headers: reqHeaders });
      if (!res.ok) throw new Error(`Kalshi API error (${res.status}) for ${url}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_kalshi");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kalshi.markets (
        ticker text PRIMARY KEY,
        title text NOT NULL,
        subtitle text,
        last_price numeric,
        yes_bid numeric,
        yes_ask numeric,
        volume_24h numeric,
        open_interest numeric,
        status text,
        close_time timestamptz,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kalshi.trades (
        id text PRIMARY KEY,
        ticker text NOT NULL,
        count int NOT NULL,
        yes_price numeric NOT NULL,
        taker_side text NOT NULL,
        created_at timestamptz NOT NULL,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS kalshi_trades_ticker_idx ON mod_kalshi.trades (ticker, created_at)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kalshi.market_embeddings (
        id text PRIMARY KEY,
        ticker text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_kalshi.market_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS kalshi_embeddings_ctx_idx ON mod_kalshi.market_embeddings (context_key, ts)`
    );
    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS kalshi_embeddings_vec_idx ON mod_kalshi.market_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS kalshi_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kalshi.orderbook_snapshots (
        id text PRIMARY KEY,
        ticker text NOT NULL,
        yes_bid numeric,
        yes_ask numeric,
        no_bid numeric,
        no_ask numeric,
        mid_price numeric,
        spread numeric,
        snapshot_at timestamptz NOT NULL
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS kalshi_ob_ticker_idx ON mod_kalshi.orderbook_snapshots (ticker, snapshot_at)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kalshi.candles (
        id text PRIMARY KEY,
        ticker text NOT NULL,
        end_period_ts bigint NOT NULL,
        period_interval int NOT NULL DEFAULT 1,
        open numeric NOT NULL,
        high numeric NOT NULL,
        low numeric NOT NULL,
        close numeric NOT NULL,
        volume numeric NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS kalshi_candles_ticker_idx ON mod_kalshi.candles (ticker, end_period_ts)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_kalshi.settlements (
        id text PRIMARY KEY,
        ticker text NOT NULL,
        title text NOT NULL,
        result text NOT NULL,
        settled_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS kalshi_settlements_ticker_idx ON mod_kalshi.settlements (ticker)`);
  }

  private async fetchMarkets(): Promise<KalshiMarket[]> {
    const allMarkets: KalshiMarket[] = [];
    let cursor: string | undefined;
    const maxPages = 5;

    let watchedTickers: string[] = [];
    try {
      watchedTickers = JSON.parse(this.settings.watchedMarkets) as string[];
    } catch {
      watchedTickers = [];
    }

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("status", "open");
      if (cursor) params.set("cursor", cursor);

      const url = `${KALSHI_API_BASE}/markets?${params.toString()}`;
      this.log("debug", "fetching markets from Kalshi API", { url, page });

      try {
        const data = await this.fetchJson<KalshiMarketsResponse>(url);
        if (!data.markets || data.markets.length === 0) break;
        allMarkets.push(...data.markets);
        cursor = data.cursor;
        if (!cursor) break;
      } catch (err) {
        this.log("error", "failed to fetch markets page", {
          page,
          err: err instanceof Error ? { name: err.name, message: err.message } : err,
        });
        break;
      }
    }

    for (const ticker of watchedTickers) {
      if (allMarkets.some((m) => m.ticker === ticker)) continue;
      try {
        const data = await this.fetchJson<{ market: KalshiMarket }>(`${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}`);
        if (data.market) allMarkets.push(data.market);
      } catch (err) {
        this.log("warn", "failed to fetch watched market", {
          ticker,
          err: err instanceof Error ? { name: err.name, message: err.message } : err,
        });
      }
    }

    this.log("info", "fetched markets from Kalshi API", { count: allMarkets.length });
    return allMarkets;
  }

  private async fetchTrades(ticker: string): Promise<KalshiTrade[]> {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.set("ticker", ticker);

    const url = `${KALSHI_API_BASE}/markets/trades?${params.toString()}`;
    this.log("debug", "fetching trades from Kalshi API", { url, ticker });

    try {
      const data = await this.fetchJson<KalshiTradesResponse>(url);
      return data.trades ?? [];
    } catch (err) {
      this.log("warn", "failed to fetch trades", {
        ticker,
        err: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      return [];
    }
  }

  private async fetchCandles(ticker: string, startTs: number, endTs: number): Promise<KalshiCandle[]> {
    const url = `${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
    this.log("debug", "fetching candles from Kalshi API", { url, ticker });

    try {
      const data = await this.fetchJson<KalshiCandlesResponse>(url);
      return data.candlesticks ?? [];
    } catch (err) {
      this.log("warn", "failed to fetch candles", {
        ticker,
        err: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      return [];
    }
  }

  async collectAndPersist(): Promise<{ marketsUpdated: number; tradesCollected: number; messagesPublished: number; orderbookSnapshots: number; candlesCollected: number; settlementsDetected: number }> {
    this.log("info", "kalshi collect starting", { watchedMarkets: this.settings.watchedMarkets });

    const markets = await this.fetchMarkets();
    let marketsUpdated = 0;
    let tradesCollected = 0;
    let messagesPublished = 0;
    let orderbookSnapshots = 0;
    let candlesCollected = 0;
    let settlementsDetected = 0;

    for (const market of markets) {
      await this.db.query(
        `INSERT INTO mod_kalshi.markets (ticker, title, subtitle, last_price, yes_bid, yes_ask, volume_24h, open_interest, status, close_time, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (ticker) DO UPDATE SET
           title = EXCLUDED.title,
           last_price = EXCLUDED.last_price,
           yes_bid = EXCLUDED.yes_bid,
           yes_ask = EXCLUDED.yes_ask,
           volume_24h = EXCLUDED.volume_24h,
           open_interest = EXCLUDED.open_interest,
           status = EXCLUDED.status,
           payload = EXCLUDED.payload,
           collected_at = now()`,
        [
          market.ticker,
          market.title,
          market.subtitle ?? null,
          market.last_price,
          market.yes_bid,
          market.yes_ask,
          market.volume_24h,
          market.open_interest,
          market.status,
          market.close_time ?? null,
          JSON.stringify(market),
        ]
      );
      marketsUpdated++;

      const messageId = uuidv5(`kalshi:market:${market.ticker}:${Date.now()}`, UUID_NAMESPACE);
      const pricePercent = (market.last_price * 100).toFixed(0);
      const messageText = `${market.title}: YES ${pricePercent}% | Vol: ${market.volume_24h.toLocaleString()}`;

      const normalized = NormalizedMessageSchema.parse({
        id: messageId,
        createdAt: new Date().toISOString(),
        source: { module: "kalshi", stream: market.ticker },
        contextRef: { ownerModule: "kalshi", sourceKey: market.ticker },
        Message: messageText,
        From: "Kalshi",
        isDirectMention: false,
        isDigest: false,
        isSystemMessage: false,
        likes: market.volume_24h,
        tags: {
          ticker: market.ticker,
          eventTicker: market.event_ticker,
          lastPrice: market.last_price,
          status: market.status,
        },
      });

      const msgEvent = MessageCreatedEventSchema.parse({
        type: "MessageCreated",
        message: normalized,
      });

      this.nats.publish(subjectFor("kalshi", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
      messagesPublished++;

      if (this.settings.collectTrades) {
        const trades = await this.fetchTrades(market.ticker);
        for (const trade of trades) {
          await this.db.query(
            `INSERT INTO mod_kalshi.trades (id, ticker, count, yes_price, taker_side, created_at, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO NOTHING`,
            [
              trade.trade_id,
              trade.ticker,
              trade.count,
              trade.yes_price,
              trade.taker_side,
              trade.created_time,
              JSON.stringify(trade),
            ]
          );
          tradesCollected++;

          const tradeMessageId = uuidv5(`kalshi:trade:${trade.trade_id}`, UUID_NAMESPACE);
          const tradeNormalized = NormalizedMessageSchema.parse({
            id: tradeMessageId,
            createdAt: trade.created_time,
            source: { module: "kalshi", stream: trade.ticker },
            contextRef: { ownerModule: "kalshi", sourceKey: trade.ticker },
            Message: `Trade: ${trade.ticker} ${trade.count} @ ${(trade.yes_price * 100).toFixed(0)}¢ YES (${trade.taker_side})`,
            From: "Kalshi",
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            likes: trade.count,
            tags: {
              ticker: trade.ticker,
              tradeId: trade.trade_id,
              yesPrice: trade.yes_price,
              count: trade.count,
              takerSide: trade.taker_side,
            },
          });
          const tradeEvent = MessageCreatedEventSchema.parse({
            type: "MessageCreated",
            message: tradeNormalized,
          });
          this.nats.publish(subjectFor("kalshi", "tradeExecuted"), this.sc.encode(JSON.stringify(tradeEvent)));
        }
      }

      if (this.settings.collectOrderbook) {
        const now = Date.now();
        const lastSnapshot = this.lastOrderbookSnapshot.get(market.ticker) ?? 0;
        if (now - lastSnapshot >= 60000) {
          const midPrice = (market.yes_bid + market.yes_ask) / 2;
          const spread = market.yes_ask - market.yes_bid;
          const snapshotId = uuidv5(`kalshi:orderbook:${market.ticker}:${now}`, UUID_NAMESPACE);
          const snapshotTime = new Date(now);

          try {
            await this.db.query(
              `INSERT INTO mod_kalshi.orderbook_snapshots (id, ticker, yes_bid, yes_ask, no_bid, no_ask, mid_price, spread, snapshot_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (id) DO NOTHING`,
              [snapshotId, market.ticker, market.yes_bid, market.yes_ask, market.no_bid, market.no_ask, midPrice, spread, snapshotTime]
            );
            this.lastOrderbookSnapshot.set(market.ticker, now);
            orderbookSnapshots++;

            const obNormalized = NormalizedMessageSchema.parse({
              id: snapshotId,
              createdAt: snapshotTime.toISOString(),
              source: { module: "kalshi", stream: market.ticker },
              contextRef: { ownerModule: "kalshi", sourceKey: market.ticker },
              Message: `Orderbook: ${market.ticker} YES bid ${(market.yes_bid * 100).toFixed(0)}¢ / ask ${(market.yes_ask * 100).toFixed(0)}¢ (spread ${(spread * 100).toFixed(1)}¢)`,
              From: "Kalshi",
              isDirectMention: false,
              isDigest: false,
              isSystemMessage: false,
              likes: 0,
              tags: {
                ticker: market.ticker,
                yesBid: market.yes_bid,
                yesAsk: market.yes_ask,
                noBid: market.no_bid,
                noAsk: market.no_ask,
                midPrice,
                spread,
              },
            });
            const obEvent = MessageCreatedEventSchema.parse({
              type: "MessageCreated",
              message: obNormalized,
            });
            this.nats.publish(subjectFor("kalshi", "orderbookSnapshot"), this.sc.encode(JSON.stringify(obEvent)));
          } catch (err) {
            this.log("warn", "failed to store orderbook snapshot", {
              ticker: market.ticker,
              err: err instanceof Error ? err.message : err,
            });
          }
        }
      }

      if (this.settings.collectCandles) {
        const endTs = Math.floor(Date.now() / 1000);
        const startTs = endTs - 3600;
        const candles = await this.fetchCandles(market.ticker, startTs, endTs);
        for (const candle of candles) {
          const candleId = uuidv5(`kalshi:candle:${market.ticker}:${candle.end_period_ts}`, UUID_NAMESPACE);
          try {
            await this.db.query(
              `INSERT INTO mod_kalshi.candles (id, ticker, end_period_ts, period_interval, open, high, low, close, volume)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (id) DO NOTHING`,
              [candleId, market.ticker, candle.end_period_ts, 1, candle.open, candle.high, candle.low, candle.close, candle.volume]
            );
            candlesCollected++;

            const candleNormalized = NormalizedMessageSchema.parse({
              id: candleId,
              createdAt: new Date(candle.end_period_ts * 1000).toISOString(),
              source: { module: "kalshi", stream: market.ticker },
              contextRef: { ownerModule: "kalshi", sourceKey: market.ticker },
              Message: `Candle: ${market.ticker} O:${(candle.open * 100).toFixed(0)}¢ H:${(candle.high * 100).toFixed(0)}¢ L:${(candle.low * 100).toFixed(0)}¢ C:${(candle.close * 100).toFixed(0)}¢ Vol:${candle.volume}`,
              From: "Kalshi",
              isDirectMention: false,
              isDigest: false,
              isSystemMessage: false,
              likes: candle.volume,
              tags: {
                ticker: market.ticker,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                endPeriodTs: candle.end_period_ts,
              },
            });
            const candleEvent = MessageCreatedEventSchema.parse({
              type: "MessageCreated",
              message: candleNormalized,
            });
            this.nats.publish(subjectFor("kalshi", "candleClosed"), this.sc.encode(JSON.stringify(candleEvent)));
          } catch (err) {
            this.log("warn", "failed to store candle", {
              ticker: market.ticker,
              err: err instanceof Error ? err.message : err,
            });
          }
        }
      }

      if (market.result && market.result !== "") {
        const settlementId = uuidv5(`kalshi:settlement:${market.ticker}:${market.result}`, UUID_NAMESPACE);
        try {
          await this.db.query(
            `INSERT INTO mod_kalshi.settlements (id, ticker, title, result)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO NOTHING`,
            [settlementId, market.ticker, market.title, market.result]
          );
          settlementsDetected++;
        } catch (err) {
          this.log("warn", "failed to store settlement", {
            ticker: market.ticker,
            err: err instanceof Error ? err.message : err,
          });
        }
      }
    }

    this.log("info", "kalshi collect complete", { marketsUpdated, tradesCollected, messagesPublished, orderbookSnapshots, candlesCollected, settlementsDetected });
    return { marketsUpdated, tradesCollected, messagesPublished, orderbookSnapshots, candlesCollected, settlementsDetected };
  }

  private async aiGenerate(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
    tokenRate?: number;
    rawResponse?: string;
  }> {
    if (!this.feedApiBaseUrl || !this.internalToken) {
      throw new Error("AI summary unavailable: missing API base URL or internal token");
    }
    try {
      const res = await fetch(`${this.feedApiBaseUrl}/api/internal/ai/summary`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
        body: JSON.stringify({ prompt, system: this.settings.contextPrompt, format: "json" }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ai summary failed (${res.status}) ${body}`.trim());
      }
      const data = (await res.json()) as { response?: string; token_rate?: number | null };
      const rawResponse = String(data.response ?? "").trim();
      if (!rawResponse) throw new Error("invalid summary payload");
      const parsed = this.parseSummaryJson(rawResponse);
      if (!parsed) return await this.aiGenerateFallback(prompt);
      const summaryShort = parsed.summaryShort.slice(0, 128);
      const summaryLong = parsed.summaryLong;
      if (!summaryShort || !summaryLong) throw new Error("invalid summary payload");
      return {
        summaryShort,
        summaryLong,
        ...(typeof data.token_rate === "number" ? { tokenRate: data.token_rate } : {}),
        rawResponse,
      };
    } catch (err) {
      this.log("error", "ai summary failed", err instanceof Error ? { message: err.message } : { err });
      throw err;
    }
  }

  private async aiGenerateFallback(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
    tokenRate?: number;
    rawResponse?: string;
  }> {
    const res = await fetch(`${this.feedApiBaseUrl}/api/internal/ai/summary`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
      body: JSON.stringify({ prompt, system: this.settings.contextPromptFallback }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ai summary fallback failed (${res.status}) ${body}`.trim());
    }
    const data = (await res.json()) as { response?: string; token_rate?: number | null };
    const rawResponse = String(data.response ?? "").trim();
    if (!rawResponse) throw new Error("invalid fallback summary payload");
    return {
      summaryShort: rawResponse.slice(0, 128),
      summaryLong: rawResponse,
      ...(typeof data.token_rate === "number" ? { tokenRate: data.token_rate } : {}),
      rawResponse,
    };
  }

  private parseSummaryJson(rawResponse: string): { summaryShort: string; summaryLong: string } | null {
    const trimmed = rawResponse.trim();
    const candidate = trimmed.startsWith("```")
      ? trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim()
      : trimmed;
    try {
      const parsed = JSON.parse(candidate) as { summary_short?: string; summary_long?: string };
      const summaryShort = String(parsed.summary_short ?? "").trim();
      const summaryLong = String(parsed.summary_long ?? "").trim();
      if (!summaryShort && !summaryLong) return null;
      return {
        summaryShort: summaryShort || summaryLong.slice(0, 128),
        summaryLong: summaryLong || summaryShort,
      };
    } catch {
      return null;
    }
  }

  private async aiEmbed(text: string): Promise<number[]> {
    if (!this.feedApiBaseUrl || !this.internalToken) {
      throw new Error("AI embedding unavailable: missing API base URL or internal token");
    }
    try {
      const res = await fetch(`${this.feedApiBaseUrl}/api/internal/ai/embedding`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`ai embeddings failed (${res.status})`);
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) throw new Error("empty embedding");
      return data.embedding;
    } catch (err) {
      this.log("error", "ai embeddings failed", err instanceof Error ? { message: err.message } : { err });
      throw err;
    }
  }

  private async publishContextUpdate(params: {
    contextKey: string;
    messageId?: string;
    summaryShort: string;
    summaryLong: string;
    keyPoints?: string[];
    embedding?: number[];
  }) {
    const summaryShort = params.summaryShort.slice(0, 128);
    const contextEvent = ContextUpdatedEventSchema.parse({
      type: "ContextUpdated",
      createdAt: new Date().toISOString(),
      messageId: params.messageId,
      context: {
        ownerModule: "kalshi",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(subjectFor("kalshi", "contextUpdated"), this.sc.encode(JSON.stringify(contextEvent)));
  }

  async refreshContexts(params: { lookbackHours: number }): Promise<{
    updated: number;
    aiSummaries: number;
    fallbackSummaries: number;
    embeddingsInserted: number;
    avgTokenRate?: number;
  }> {
    const cutoff = new Date(Date.now() - params.lookbackHours * 3600_000);
    const res = await this.db.query(
      `SELECT ticker, title, subtitle, last_price, yes_bid, yes_ask, volume_24h, open_interest, status
       FROM mod_kalshi.markets
       WHERE collected_at >= $1
       ORDER BY volume_24h DESC
       LIMIT $2`,
      [cutoff, this.contextTopK]
    );

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of res.rows as KalshiMarketRow[]) {
      const contextKey = `market:${row.ticker}`;
      const msgId = uuidv5(`kalshi:${row.ticker}`, UUID_NAMESPACE);

      const prior = await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["kalshi", contextKey]
      );
      const priorSummary = String(prior.rows?.[0]?.summaryLong ?? "");

      const yesPct = (Number(row.last_price) * 100).toFixed(1);
      const bidPct = (Number(row.yes_bid) * 100).toFixed(1);
      const askPct = (Number(row.yes_ask) * 100).toFixed(1);

      const marketContent = [
        `Market: ${row.title}`,
        row.subtitle ? `Subtitle: ${row.subtitle}` : "",
        `YES Price: ${yesPct}% (Bid: ${bidPct}%, Ask: ${askPct}%)`,
        `24h Volume: ${Number(row.volume_24h).toLocaleString()} contracts`,
        `Open Interest: ${Number(row.open_interest).toLocaleString()} contracts`,
        `Status: ${row.status}`,
      ].filter(Boolean).join("\n");

      if (!marketContent) {
        const summaryShort = `${row.title}`.slice(0, 128);
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: summaryShort,
          keyPoints: [],
        });
        fallbackSummaries++;
        updated++;
        continue;
      }

      const prompt = [
        priorSummary ? `Prior summary:\n${priorSummary}` : "",
        marketContent,
      ].filter(Boolean).join("\n");
      const maxPromptChars = 8000;
      const promptText = prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;

      try {
        const aiSummary = await this.aiGenerate(promptText);
        const contextEmbedding = await this.aiEmbed(aiSummary.summaryLong);
        if (contextEmbedding.length) embeddingsInserted++;
        if (typeof aiSummary.tokenRate === "number") {
          tokenRateSum += aiSummary.tokenRate;
          tokenRateCount += 1;
        }
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort: aiSummary.summaryShort,
          summaryLong: aiSummary.summaryLong,
          keyPoints: [],
          ...(contextEmbedding.length ? { embedding: contextEmbedding } : {}),
        });
        aiSummaries++;
      } catch (err) {
        const summaryShort = `${row.title}`.slice(0, 128);
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: marketContent,
          keyPoints: [],
        });
        fallbackSummaries++;
        this.log("warn", "ai summary failed, using fallback", {
          ticker: row.ticker,
          err: err instanceof Error ? { message: err.message } : err,
        });
      }
      updated++;
    }

    return {
      updated,
      aiSummaries,
      fallbackSummaries,
      embeddingsInserted,
      ...(tokenRateCount ? { avgTokenRate: tokenRateSum / tokenRateCount } : {}),
    };
  }
}
