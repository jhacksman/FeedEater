import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";
import WebSocket from "ws";

import { ContextUpdatedEventSchema, MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

const POLYMARKET_CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/";

export type PolymarketSettings = {
  enabled: boolean;
  watchedMarkets: string;
  watchedCategories: string;
  minVolume: number;
  collectComments: boolean;
  collectAllTrades: boolean;
  whaleThreshold: number;
  orderbookEnabled: boolean;
  orderbookIntervalMs: number;
  lookbackHours: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

const UUID_NAMESPACE = "c3d5e7f9-2b4c-6d8e-0f1a-3b5c7d9e1f2a";
const POLYMARKET_API_BASE = "https://gamma-api.polymarket.com";
const POLYMARKET_DATA_API = "https://data-api.polymarket.com";

export function parsePolymarketSettingsFromInternal(raw: Record<string, unknown>): PolymarketSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const watchedMarkets = String(raw.watchedMarkets ?? "[]");
  const watchedCategories = String(raw.watchedCategories ?? "[\"politics\", \"crypto\", \"sports\"]");
  const minVolume = raw.minVolume ? Number(raw.minVolume) : 10000;
  const collectComments = String(raw.collectComments ?? "false") === "true";
  const collectAllTrades = String(raw.collectAllTrades ?? "true") === "true";
  const whaleThreshold = raw.whaleThreshold ? Number(raw.whaleThreshold) : 50000;
  const orderbookEnabled = String(raw.orderbookEnabled ?? "true") === "true";
  const orderbookIntervalMs = raw.orderbookIntervalMs ? Number(raw.orderbookIntervalMs) : 60000;
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
  if (!Number.isFinite(whaleThreshold) || whaleThreshold <= 0) {
    throw new Error('Polymarket setting "whaleThreshold" must be a positive number');
  }

  return {
    enabled,
    watchedMarkets,
    watchedCategories,
    minVolume,
    collectComments,
    collectAllTrades,
    whaleThreshold,
    orderbookEnabled,
    orderbookIntervalMs,
    lookbackHours,
    contextPrompt,
    contextPromptFallback,
  };
}

interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  markets: PolymarketMarket[];
}

interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomePrices: string;
  volume: string;
  volume24hr: number;
  liquidity: string;
  endDate: string;
  closed: boolean;
  outcomes: string;
}

type MarketRow = {
  id: string;
  event_id: string;
  question: string;
  condition_id: string;
  slug: string;
  outcome_prices: number[] | null;
  outcomes: string[] | null;
  volume: number;
  volume_24h: number;
  liquidity: number;
  closed: boolean;
};

export class PolymarketIngestor {
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;
  private requestTimeoutMs: number;

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
    private readonly sc: StringCodec,
    opts: { apiBaseUrl: string; internalToken: string; contextTopK: number; embedDim: number }
  ) {
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
    this.requestTimeoutMs = 15_000;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Polymarket API error (${res.status}) for ${url}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
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

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_polymarket.trades (
        id text PRIMARY KEY,
        market_id text NOT NULL,
        condition_id text NOT NULL,
        asset_id text NOT NULL,
        outcome text,
        side text NOT NULL,
        size numeric NOT NULL,
        price numeric NOT NULL,
        notional_usd numeric NOT NULL,
        size_category text NOT NULL,
        is_whale boolean NOT NULL DEFAULT false,
        taker_order_id text,
        timestamp_ms bigint NOT NULL,
        created_at timestamptz NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS polymarket_trades_market_idx ON mod_polymarket.trades (market_id, created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS polymarket_trades_timestamp_idx ON mod_polymarket.trades (timestamp_ms DESC)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS polymarket_trades_whale_idx ON mod_polymarket.trades (is_whale, created_at) WHERE is_whale = true`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS polymarket_trades_condition_idx ON mod_polymarket.trades (condition_id, created_at)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_polymarket.orderbook_snapshots (
        id text PRIMARY KEY,
        market_id text NOT NULL,
        condition_id text NOT NULL,
        asset_id text NOT NULL,
        bids_json text NOT NULL,
        asks_json text NOT NULL,
        mid_price numeric NOT NULL,
        spread_bps numeric NOT NULL,
        snapshot_at timestamptz NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS polymarket_orderbook_market_idx ON mod_polymarket.orderbook_snapshots (market_id, snapshot_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS polymarket_orderbook_condition_idx ON mod_polymarket.orderbook_snapshots (condition_id, snapshot_at)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_polymarket.market_embeddings (
        id text PRIMARY KEY,
        market_id text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_polymarket.market_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS polymarket_embeddings_ctx_idx ON mod_polymarket.market_embeddings (context_key, ts)`
    );
    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS polymarket_embeddings_vec_idx ON mod_polymarket.market_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS polymarket_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }
  }

  private getSizeCategory(notionalUsd: number): string {
    if (notionalUsd >= this.settings.whaleThreshold) return "whale";
    if (notionalUsd >= 10000) return "large";
    if (notionalUsd >= 1000) return "medium";
    return "small";
  }

  private async getActiveAssetIds(): Promise<{ assetId: string; conditionId: string; marketId: string; outcome: string }[]> {
    const res = await this.db.query(
      `SELECT m.id as market_id, m.condition_id, m.outcomes, m.payload
       FROM mod_polymarket.markets m
       WHERE m.closed = false AND m.volume_24h >= $1
       ORDER BY m.volume_24h DESC
       LIMIT 50`,
      [this.settings.minVolume]
    );

    const assetIds: { assetId: string; conditionId: string; marketId: string; outcome: string }[] = [];
    for (const row of res.rows) {
      try {
        const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        const outcomes = typeof row.outcomes === "string" ? JSON.parse(row.outcomes) : row.outcomes;
        const tokens = payload?.tokens || payload?.clobTokenIds || [];
        if (Array.isArray(tokens)) {
          for (let i = 0; i < tokens.length; i++) {
            const tokenId = typeof tokens[i] === "object" ? tokens[i]?.token_id : tokens[i];
            if (tokenId) {
              assetIds.push({
                assetId: String(tokenId),
                conditionId: row.condition_id,
                marketId: row.market_id,
                outcome: outcomes?.[i] ?? `Outcome ${i}`,
              });
            }
          }
        }
      } catch (err) {
        this.log("warn", "failed to parse market payload for asset IDs", { marketId: row.market_id });
      }
    }
    return assetIds;
  }

  private ws: WebSocket | null = null;
  private isStreaming = false;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
  private orderbook: Map<string, { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }> = new Map();
  private lastOrderbookSnapshot: Map<string, number> = new Map();
  private assetToMarketMap: Map<string, { conditionId: string; marketId: string; outcome: string }> = new Map();
  private tradesCollected = 0;
  private snapshotsSaved = 0;
  private messagesPublished = 0;

  async startStreaming(): Promise<{ tradesCollected: number; snapshotsSaved: number; messagesPublished: number }> {
    this.isStreaming = true;
    this.tradesCollected = 0;
    this.snapshotsSaved = 0;
    this.messagesPublished = 0;

    const assetInfos = await this.getActiveAssetIds();
    if (assetInfos.length === 0) {
      this.log("warn", "no active markets found for streaming");
      return { tradesCollected: 0, snapshotsSaved: 0, messagesPublished: 0 };
    }

    this.assetToMarketMap.clear();
    for (const info of assetInfos) {
      this.assetToMarketMap.set(info.assetId, { conditionId: info.conditionId, marketId: info.marketId, outcome: info.outcome });
    }

    const assetIds = assetInfos.map((a) => a.assetId);
    this.log("info", "starting WebSocket stream", { assetCount: assetIds.length });

    try {
      await this.connectWebSocket(assetIds);

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!this.isStreaming) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 1000);

        setTimeout(() => {
          this.isStreaming = false;
          clearInterval(checkInterval);
          resolve();
        }, 55000);
      });
    } catch (err) {
      this.log("error", "streaming error", { err: err instanceof Error ? err.message : err });
    } finally {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.isStreaming = false;
    }

    return { tradesCollected: this.tradesCollected, snapshotsSaved: this.snapshotsSaved, messagesPublished: this.messagesPublished };
  }

  private async connectWebSocket(assetIds: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(POLYMARKET_CLOB_WS);

      this.ws.on("open", () => {
        this.log("info", "WebSocket connected to Polymarket CLOB");
        this.reconnectDelay = 1000;

        const subscribeMsg = {
          type: "MARKET",
          assets_ids: assetIds,
        };
        this.ws!.send(JSON.stringify(subscribeMsg));
        this.log("debug", "subscribed to market channel", { assetCount: assetIds.length });
        resolve();
      });

      this.ws.on("message", async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          await this.handleWebSocketMessage(msg);
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
        if (this.isStreaming) {
          this.scheduleReconnect(assetIds);
        }
      });
    });
  }

  private scheduleReconnect(assetIds: string[]): void {
    this.log("info", `scheduling reconnect in ${this.reconnectDelay}ms`);
    setTimeout(async () => {
      try {
        await this.connectWebSocket(assetIds);
      } catch (err) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        if (this.isStreaming) {
          this.scheduleReconnect(assetIds);
        }
      }
    }, this.reconnectDelay);
  }

  private async handleWebSocketMessage(msg: any): Promise<void> {
    const eventType = msg.event_type;

    if (eventType === "book") {
      await this.handleBookMessage(msg);
    } else if (eventType === "price_change") {
      await this.handlePriceChangeMessage(msg);
    } else if (eventType === "last_trade_price") {
      await this.handleTradeMessage(msg);
    }
  }

  private async handleBookMessage(msg: any): Promise<void> {
    const assetId = msg.asset_id;
    const marketInfo = this.assetToMarketMap.get(assetId);
    if (!marketInfo) return;

    const bids = (msg.bids || msg.buys || []).map((b: any) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    }));
    const asks = (msg.asks || msg.sells || []).map((a: any) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    this.orderbook.set(assetId, { bids, asks });

    if (this.settings.orderbookEnabled) {
      await this.maybeSnapshotOrderbook(assetId, marketInfo);
    }
  }

  private async maybeSnapshotOrderbook(assetId: string, marketInfo: { conditionId: string; marketId: string; outcome: string }): Promise<void> {
    const now = Date.now();
    const lastSnapshot = this.lastOrderbookSnapshot.get(assetId) ?? 0;
    if (now - lastSnapshot < this.settings.orderbookIntervalMs) return;

    const book = this.orderbook.get(assetId);
    if (!book || book.bids.length === 0 || book.asks.length === 0) return;

    const topBids = book.bids.slice(0, 20);
    const topAsks = book.asks.slice(0, 20);
    const bestBid = topBids[0]?.price ?? 0;
    const bestAsk = topAsks[0]?.price ?? 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

    const snapshotId = uuidv5(`polymarket:orderbook:${assetId}:${now}`, UUID_NAMESPACE);
    const snapshotTime = new Date(now);

    try {
      await this.db.query(
        `INSERT INTO mod_polymarket.orderbook_snapshots (id, market_id, condition_id, asset_id, bids_json, asks_json, mid_price, spread_bps, snapshot_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [snapshotId, marketInfo.marketId, marketInfo.conditionId, assetId, JSON.stringify(topBids), JSON.stringify(topAsks), midPrice, spreadBps, snapshotTime]
      );
      this.lastOrderbookSnapshot.set(assetId, now);
      this.snapshotsSaved++;

      const snapshotPayload = {
        id: snapshotId,
        marketId: marketInfo.marketId,
        conditionId: marketInfo.conditionId,
        assetId,
        outcome: marketInfo.outcome,
        midPrice,
        spreadBps,
        bidsDepth: topBids.length,
        asksDepth: topAsks.length,
        snapshotAt: snapshotTime.toISOString(),
      };
      this.nats.publish(subjectFor("polymarket", "orderbookSnapshot"), this.sc.encode(JSON.stringify(snapshotPayload)));
      this.log("debug", "saved orderbook snapshot", { assetId, midPrice, spreadBps });
    } catch (err) {
      this.log("error", "failed to save orderbook snapshot", { assetId, err: err instanceof Error ? err.message : err });
    }
  }

  private async handlePriceChangeMessage(msg: any): Promise<void> {
    const assetId = msg.asset_id;
    const marketInfo = this.assetToMarketMap.get(assetId);
    if (!marketInfo) return;

    const price = parseFloat(msg.price || "0");
    const size = parseFloat(msg.size || "0");
    const side = msg.side?.toUpperCase() === "BUY" ? "buy" : "sell";
    const timestampMs = parseInt(msg.timestamp || String(Date.now()), 10);

    if (size > 0 && this.settings.collectAllTrades) {
      await this.storeTrade({
        tradeId: `pm_pc_${assetId}_${timestampMs}`,
        marketId: marketInfo.marketId,
        conditionId: marketInfo.conditionId,
        assetId,
        outcome: marketInfo.outcome,
        side,
        size,
        price,
        timestampMs,
      });
    }
  }

  private async handleTradeMessage(msg: any): Promise<void> {
    const assetId = msg.asset_id;
    const marketInfo = this.assetToMarketMap.get(assetId);
    if (!marketInfo) return;

    const price = parseFloat(msg.price || "0");
    const size = parseFloat(msg.size || "0");
    const side = msg.side?.toUpperCase() === "BUY" ? "buy" : "sell";
    const timestampMs = parseInt(msg.timestamp || String(Date.now()), 10);

    if (size > 0 && this.settings.collectAllTrades) {
      await this.storeTrade({
        tradeId: `pm_ltp_${assetId}_${timestampMs}`,
        marketId: marketInfo.marketId,
        conditionId: marketInfo.conditionId,
        assetId,
        outcome: marketInfo.outcome,
        side,
        size,
        price,
        timestampMs,
      });
    }
  }

  private async storeTrade(trade: {
    tradeId: string;
    marketId: string;
    conditionId: string;
    assetId: string;
    outcome: string;
    side: string;
    size: number;
    price: number;
    timestampMs: number;
    takerOrderId?: string | undefined;
  }): Promise<void> {
    const notionalUsd = trade.size * trade.price;
    const sizeCategory = this.getSizeCategory(notionalUsd);
    const isWhale = sizeCategory === "whale";
    const createdAt = new Date(trade.timestampMs);

    try {
      await this.db.query(
        `INSERT INTO mod_polymarket.trades (id, market_id, condition_id, asset_id, outcome, side, size, price, notional_usd, size_category, is_whale, taker_order_id, timestamp_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO NOTHING`,
        [trade.tradeId, trade.marketId, trade.conditionId, trade.assetId, trade.outcome, trade.side, trade.size, trade.price, notionalUsd, sizeCategory, isWhale, trade.takerOrderId ?? null, trade.timestampMs, createdAt]
      );
      this.tradesCollected++;

      const messageId = uuidv5(`polymarket:trade:${trade.tradeId}`, UUID_NAMESPACE);
      const direction = trade.side === "buy" ? "bullish" : "bearish";
      const messageText = `${trade.outcome} ${trade.side.toUpperCase()} ${trade.size.toFixed(2)} @ ${(trade.price * 100).toFixed(1)}% = $${notionalUsd.toLocaleString()}`;

      const normalized = NormalizedMessageSchema.parse({
        id: messageId,
        createdAt: createdAt.toISOString(),
        source: { module: "polymarket", stream: trade.conditionId },
        contextRef: { ownerModule: "polymarket", sourceKey: `market:${trade.conditionId}` },
        Message: messageText,
        From: "Polymarket",
        isDirectMention: false,
        isDigest: false,
        isSystemMessage: false,
        likes: Math.floor(notionalUsd),
        tags: {
          marketId: trade.marketId,
          conditionId: trade.conditionId,
          assetId: trade.assetId,
          outcome: trade.outcome,
          side: trade.side,
          size: trade.size,
          price: trade.price,
          notionalUsd,
          sizeCategory,
          isWhale,
          direction,
        },
      });

      const msgEvent = MessageCreatedEventSchema.parse({
        type: "MessageCreated",
        message: normalized,
      });

      this.nats.publish(subjectFor("polymarket", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
      this.nats.publish(subjectFor("polymarket", "tradeExecuted"), this.sc.encode(JSON.stringify(msgEvent)));
      this.messagesPublished++;
    } catch (err) {
      this.log("error", "failed to store trade", { tradeId: trade.tradeId, err: err instanceof Error ? err.message : err });
    }
  }

  async collectTrades(params: { lookbackHours: number }): Promise<{ tradesCollected: number; messagesPublished: number }> {
    this.tradesCollected = 0;
    this.messagesPublished = 0;

    const cutoffMs = Date.now() - params.lookbackHours * 3600_000;
    const markets = await this.db.query(
      `SELECT m.id as market_id, m.condition_id, m.outcomes, m.payload
       FROM mod_polymarket.markets m
       WHERE m.closed = false AND m.volume_24h >= $1
       ORDER BY m.volume_24h DESC
       LIMIT 50`,
      [this.settings.minVolume]
    );

    for (const row of markets.rows) {
      let outcomes: string[] = [];
      let tokenToOutcome: Map<string, string> = new Map();
      try {
        outcomes = typeof row.outcomes === "string" ? JSON.parse(row.outcomes) : (row.outcomes ?? []);
        const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        const tokens = payload?.tokens || payload?.clobTokenIds || [];
        if (Array.isArray(tokens)) {
          for (let i = 0; i < tokens.length; i++) {
            const tokenId = typeof tokens[i] === "object" ? tokens[i]?.token_id : tokens[i];
            if (tokenId) tokenToOutcome.set(String(tokenId), outcomes[i] ?? `Outcome ${i}`);
          }
        }
      } catch {
        this.log("warn", "failed to parse market payload for REST trades", { marketId: row.market_id });
      }

      const conditionId = row.condition_id;
      let cursor: string | undefined;
      let pageCount = 0;
      const maxPages = 10;

      while (pageCount < maxPages) {
        const tradeParams = new URLSearchParams();
        tradeParams.set("condition_id", conditionId);
        tradeParams.set("limit", "100");
        if (cursor) tradeParams.set("next_cursor", cursor);

        const url = `${POLYMARKET_DATA_API}/trades?${tradeParams.toString()}`;
        try {
          const resp = await this.fetchJson<{ data?: any[]; next_cursor?: string }>(url);
          const trades = resp.data ?? (Array.isArray(resp) ? resp : []);
          if (trades.length === 0) break;

          let reachedCutoff = false;
          for (const t of trades) {
            const timestampMs = parseInt(t.timestamp || t.match_time || String(Date.now()), 10);
            if (timestampMs < cutoffMs) {
              reachedCutoff = true;
              break;
            }

            const assetId = String(t.asset_id ?? t.token_id ?? "");
            const outcome = tokenToOutcome.get(assetId) ?? outcomes[0] ?? "Unknown";
            const size = parseFloat(t.size ?? t.amount ?? "0");
            const price = parseFloat(t.price ?? "0");
            const side = (t.side ?? "buy").toLowerCase() === "buy" ? "buy" : "sell";
            const tradeId = t.id ? String(t.id) : `pm_rest_${conditionId}_${timestampMs}_${assetId}`;

            if (size > 0) {
              await this.storeTrade({
                tradeId,
                marketId: row.market_id,
                conditionId,
                assetId,
                outcome,
                side,
                size,
                price,
                timestampMs,
                takerOrderId: t.taker_order_id ? String(t.taker_order_id) : undefined,
              });
            }
          }

          if (reachedCutoff) break;
          cursor = resp.next_cursor;
          if (!cursor) break;
          pageCount++;
        } catch (err) {
          this.log("error", "failed to fetch REST trades", {
            conditionId,
            err: err instanceof Error ? err.message : err,
          });
          break;
        }
      }
    }

    this.log("info", "REST trade collection complete", {
      tradesCollected: this.tradesCollected,
      messagesPublished: this.messagesPublished,
    });

    return { tradesCollected: this.tradesCollected, messagesPublished: this.messagesPublished };
  }

  private async fetchEvents(): Promise<PolymarketEvent[]> {
    let categories: string[] = [];
    try {
      categories = JSON.parse(this.settings.watchedCategories) as string[];
    } catch {
      categories = ["politics", "crypto", "sports"];
    }

    const allEvents: PolymarketEvent[] = [];
    const seenIds = new Set<string>();

    const params = new URLSearchParams();
    params.set("closed", "false");
    params.set("limit", "100");
    params.set("order", "volume24hr");
    params.set("ascending", "false");

    if (categories.length > 0) {
      params.set("tag_slug", categories.join(","));
    }

    const url = `${POLYMARKET_API_BASE}/events?${params.toString()}`;
    this.log("debug", "fetching events from Gamma API", { url });

    try {
      const events = await this.fetchJson<PolymarketEvent[]>(url);
      for (const ev of events) {
        if (!seenIds.has(ev.id)) {
          seenIds.add(ev.id);
          allEvents.push(ev);
        }
      }
    } catch (err) {
      this.log("error", "failed to fetch events by category", {
        err: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
    }

    let watchedIds: string[] = [];
    try {
      watchedIds = JSON.parse(this.settings.watchedMarkets) as string[];
    } catch {
      watchedIds = [];
    }

    for (const slug of watchedIds) {
      if (seenIds.has(slug)) continue;
      try {
        const ev = await this.fetchJson<PolymarketEvent>(`${POLYMARKET_API_BASE}/events/${encodeURIComponent(slug)}`);
        if (ev && ev.id) {
          seenIds.add(ev.id);
          allEvents.push(ev);
        }
      } catch (err) {
        this.log("warn", "failed to fetch watched event", {
          slug,
          err: err instanceof Error ? { name: err.name, message: err.message } : err,
        });
      }
    }

    this.log("info", "fetched events from Gamma API", { count: allEvents.length });
    return allEvents;
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

      const markets = Array.isArray(event.markets) ? event.markets : [];
      for (const market of markets) {
        let outcomePrices: number[] = [];
        let outcomes: string[] = [];
        try {
          outcomePrices = JSON.parse(market.outcomePrices) as number[];
        } catch {
          outcomePrices = [];
        }
        try {
          outcomes = JSON.parse(market.outcomes) as string[];
        } catch {
          outcomes = [];
        }

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

        if (market.volume24hr < this.settings.minVolume) continue;

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

  private async aiGenerate(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
    tokenRate?: number;
    rawResponse?: string;
  }> {
    if (!this.apiBaseUrl || !this.internalToken) {
      throw new Error("AI summary unavailable: missing API base URL or internal token");
    }
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/summary`, {
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
    const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/summary`, {
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
    if (!this.apiBaseUrl || !this.internalToken) {
      throw new Error("AI embedding unavailable: missing API base URL or internal token");
    }
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/embedding`, {
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
        ownerModule: "polymarket",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(subjectFor("polymarket", "contextUpdated"), this.sc.encode(JSON.stringify(contextEvent)));
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
      `SELECT m.id, m.event_id, m.question, m.condition_id, m.slug,
              m.outcome_prices, m.outcomes, m.volume, m.volume_24h, m.liquidity, m.closed
       FROM mod_polymarket.markets m
       WHERE m.collected_at >= $1 AND m.volume_24h >= $2
       ORDER BY m.volume_24h DESC
       LIMIT $3`,
      [cutoff, this.settings.minVolume, this.contextTopK]
    );

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of res.rows as MarketRow[]) {
      const contextKey = `market:${row.condition_id}`;
      const msgId = uuidv5(`polymarket:${row.id}`, UUID_NAMESPACE);

      const prior = await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["polymarket", contextKey]
      );
      const priorSummary = String(prior.rows?.[0]?.summaryLong ?? "");

      const prices = Array.isArray(row.outcome_prices) ? row.outcome_prices : [];
      const outcomeNames = Array.isArray(row.outcomes) ? row.outcomes : [];
      const priceLines = outcomeNames.map((name: string, i: number) => {
        const p = prices[i] ?? 0;
        return `${name}: ${(p * 100).toFixed(1)}%`;
      });

      const marketContent = [
        `Market: ${row.question}`,
        priceLines.length > 0 ? `Prices: ${priceLines.join(", ")}` : "",
        `24h Volume: $${Number(row.volume_24h).toLocaleString()}`,
        `Total Volume: $${Number(row.volume).toLocaleString()}`,
        `Liquidity: $${Number(row.liquidity).toLocaleString()}`,
        row.closed ? "Status: CLOSED" : "Status: OPEN",
      ].filter(Boolean).join("\n");

      if (!marketContent) {
        const summaryShort = `${row.question}`.slice(0, 128);
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
        const summaryShort = `${row.question}`.slice(0, 128);
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: marketContent,
          keyPoints: [],
        });
        fallbackSummaries++;
        this.log("warn", "ai summary failed, using fallback", {
          marketId: row.id,
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
