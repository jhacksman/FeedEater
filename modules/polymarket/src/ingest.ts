import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type PolymarketSettings = {
  enabled: boolean;
  watchedMarkets: string;
  watchedCategories: string;
  minVolume: number;
  collectComments: boolean;
  lookbackHours: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

const UUID_NAMESPACE = "c3d5e7f9-2b4c-6d8e-0f1a-3b5c7d9e1f2a";
const POLYMARKET_API_BASE = "https://gamma-api.polymarket.com";
const POLYMARKET_CLOB_API = "https://clob.polymarket.com";

export function parsePolymarketSettingsFromInternal(raw: Record<string, unknown>): PolymarketSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const watchedMarkets = String(raw.watchedMarkets ?? "[]");
  const watchedCategories = String(raw.watchedCategories ?? "[\"politics\", \"crypto\", \"sports\"]");
  const minVolume = raw.minVolume ? Number(raw.minVolume) : 10000;
  const collectComments = String(raw.collectComments ?? "false") === "true";
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const defaultContextPrompt =
    "You are summarizing prediction market activity on Polymarket. Summarize ONLY the market data provided. Include current probabilities, volume, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided market data in plain text. 1-3 short sentences about probability and volume. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Polymarket setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    watchedMarkets,
    watchedCategories,
    minVolume,
    collectComments,
    lookbackHours,
    contextPrompt,
    contextPromptFallback,
  };
}

interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  markets: PolymarketMarket[];
}

interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomePrices: string; // JSON string of prices
  volume: string;
  volume24hr: number;
  liquidity: string;
  endDate?: string;
  closed: boolean;
  outcomes: string; // JSON string of outcome names
}

export class PolymarketIngestor {
  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.polymarket.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "polymarket",
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
    private readonly settings: PolymarketSettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodec
  ) {}

  async ensureSchema(): Promise<void> {
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_polymarket");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_polymarket.events (
        id text PRIMARY KEY,
        slug text NOT NULL,
        title text NOT NULL,
        description text,
        start_date timestamptz,
        end_date timestamptz,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_polymarket.markets (
        id text PRIMARY KEY,
        event_id text NOT NULL,
        condition_id text NOT NULL,
        question text NOT NULL,
        slug text NOT NULL,
        outcome_prices jsonb,
        outcomes jsonb,
        volume numeric,
        volume_24h numeric,
        liquidity numeric,
        closed boolean DEFAULT false,
        end_date timestamptz,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS polymarket_markets_event_idx ON mod_polymarket.markets (event_id)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS polymarket_markets_volume_idx ON mod_polymarket.markets (volume_24h DESC)`);
  }

  private async fetchEvents(): Promise<PolymarketEvent[]> {
    // TODO: Implement actual Polymarket API call
    // For now, return empty array - this is a stub
    this.log("info", "polymarket collect stub - API integration not yet implemented");
    return [];
  }

  async collectAndPersist(): Promise<{ eventsUpdated: number; marketsUpdated: number; messagesPublished: number }> {
    this.log("info", "polymarket collect starting", {
      watchedMarkets: this.settings.watchedMarkets,
      watchedCategories: this.settings.watchedCategories,
      minVolume: this.settings.minVolume,
    });

    const events = await this.fetchEvents();
    let eventsUpdated = 0;
    let marketsUpdated = 0;
    let messagesPublished = 0;

    for (const event of events) {
      // Upsert event
      await this.db.query(
        `INSERT INTO mod_polymarket.events (id, slug, title, description, start_date, end_date, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           payload = EXCLUDED.payload,
           collected_at = now()`,
        [
          event.id,
          event.slug,
          event.title,
          event.description ?? null,
          event.startDate ?? null,
          event.endDate ?? null,
          JSON.stringify(event),
        ]
      );
      eventsUpdated++;

      for (const market of event.markets) {
        // Parse prices
        let outcomePrices: number[] = [];
        let outcomes: string[] = [];
        try {
          outcomePrices = JSON.parse(market.outcomePrices);
          outcomes = JSON.parse(market.outcomes);
        } catch {
          // ignore parse errors
        }

        // Upsert market
        await this.db.query(
          `INSERT INTO mod_polymarket.markets (id, event_id, condition_id, question, slug, outcome_prices, outcomes, volume, volume_24h, liquidity, closed, end_date, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO UPDATE SET
             question = EXCLUDED.question,
             outcome_prices = EXCLUDED.outcome_prices,
             volume = EXCLUDED.volume,
             volume_24h = EXCLUDED.volume_24h,
             liquidity = EXCLUDED.liquidity,
             closed = EXCLUDED.closed,
             payload = EXCLUDED.payload,
             collected_at = now()`,
          [
            market.id,
            event.id,
            market.conditionId,
            market.question,
            market.slug,
            JSON.stringify(outcomePrices),
            JSON.stringify(outcomes),
            parseFloat(market.volume) || 0,
            market.volume24hr || 0,
            parseFloat(market.liquidity) || 0,
            market.closed,
            market.endDate ?? null,
            JSON.stringify(market),
          ]
        );
        marketsUpdated++;

        // Skip low-volume markets
        if (market.volume24hr < this.settings.minVolume) continue;

        // Publish market update as message
        const messageId = uuidv5(`polymarket:market:${market.id}:${Date.now()}`, UUID_NAMESPACE);
        const yesPrice = outcomePrices[0] ?? 0;
        const pricePercent = (yesPrice * 100).toFixed(0);
        const volumeStr = market.volume24hr.toLocaleString();
        const messageText = `${market.question}: YES ${pricePercent}% | 24h Vol: $${volumeStr}`;

        const normalized = NormalizedMessageSchema.parse({
          id: messageId,
          createdAt: new Date().toISOString(),
          source: { module: "polymarket", stream: event.slug },
          contextRef: { ownerModule: "polymarket", sourceKey: market.conditionId },
          Message: messageText,
          From: "Polymarket",
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          likes: Math.round(market.volume24hr),
          tags: {
            eventId: event.id,
            marketId: market.id,
            conditionId: market.conditionId,
            yesPrice,
            volume24h: market.volume24hr,
            closed: market.closed,
          },
        });

        const msgEvent = MessageCreatedEventSchema.parse({
          type: "MessageCreated",
          message: normalized,
        });

        this.nats.publish(subjectFor("polymarket", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
        messagesPublished++;
      }
    }

    this.log("info", "polymarket collect complete", { eventsUpdated, marketsUpdated, messagesPublished });
    return { eventsUpdated, marketsUpdated, messagesPublished };
  }

  async refreshContexts(): Promise<{ updated: number }> {
    // TODO: Implement context refresh with AI summaries
    this.log("info", "polymarket updateContexts stub - not yet implemented");
    return { updated: 0 };
  }
}
