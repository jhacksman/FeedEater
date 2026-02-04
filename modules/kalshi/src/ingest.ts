import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type KalshiSettings = {
  enabled: boolean;
  apiKey?: string;
  apiSecret?: string;
  watchedMarkets: string;
  collectTrades: boolean;
  collectOrderbook: boolean;
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
    lookbackHours,
    contextPrompt,
    contextPromptFallback,
  };
}

interface KalshiMarket {
  ticker: string;
  title: string;
  subtitle?: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  status: string;
  close_time?: string;
  result?: string;
}

interface KalshiTrade {
  trade_id: string;
  ticker: string;
  count: number;
  yes_price: number;
  no_price: number;
  taker_side: "yes" | "no";
  created_time: string;
}

export class KalshiIngestor {
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
    private readonly sc: StringCodec
  ) {}

  async ensureSchema(): Promise<void> {
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
  }

  private async fetchMarkets(): Promise<KalshiMarket[]> {
    // TODO: Implement actual Kalshi API call
    // For now, return empty array - this is a stub
    this.log("info", "kalshi collect stub - API integration not yet implemented");
    return [];
  }

  private async fetchTrades(_ticker: string): Promise<KalshiTrade[]> {
    // TODO: Implement actual Kalshi API call
    // For now, return empty array - this is a stub
    return [];
  }

  async collectAndPersist(): Promise<{ marketsUpdated: number; tradesCollected: number; messagesPublished: number }> {
    this.log("info", "kalshi collect starting", { watchedMarkets: this.settings.watchedMarkets });

    const markets = await this.fetchMarkets();
    let marketsUpdated = 0;
    let tradesCollected = 0;
    let messagesPublished = 0;

    for (const market of markets) {
      // Upsert market data
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

      // Publish market update as message
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
          lastPrice: market.last_price,
          status: market.status,
        },
      });

      const event = MessageCreatedEventSchema.parse({
        type: "MessageCreated",
        message: normalized,
      });

      this.nats.publish(subjectFor("kalshi", "messageCreated"), this.sc.encode(JSON.stringify(event)));
      messagesPublished++;

      // Collect trades if enabled
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
        }
      }
    }

    this.log("info", "kalshi collect complete", { marketsUpdated, tradesCollected, messagesPublished });
    return { marketsUpdated, tradesCollected, messagesPublished };
  }

  async refreshContexts(): Promise<{ updated: number }> {
    // TODO: Implement context refresh with AI summaries
    this.log("info", "kalshi updateContexts stub - not yet implemented");
    return { updated: 0 };
  }
}
