import { v5 as uuidv5 } from "uuid";

import { ContextUpdatedEventSchema, subjectFor } from "@feedeater/core";
import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";

import { classifyMarketText, EventType, TICKER_TO_ASSET } from "./taxonomy.js";

const UUID_NAMESPACE = "d4e6f8a0-3c5d-7e9f-1b2a-4c6d8e0f2a3b";

type QueryResult<T = Record<string, unknown>> = { rows: T[]; rowCount: number };

function asResult<T = Record<string, unknown>>(raw: unknown): QueryResult<T> {
  const r = raw as QueryResult<T> | undefined;
  return { rows: r?.rows ?? [], rowCount: r?.rowCount ?? 0 };
}

export type EventResolverSettings = {
  enabled: boolean;
  minConfidence: number;
  textSimilarityWeight: number;
  embeddingSimilarityWeight: number;
  lookbackHours: number;
};

export function parseEventResolverSettingsFromInternal(raw: Record<string, unknown>): EventResolverSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const minConfidence = raw.minConfidence ? Number(raw.minConfidence) : 0.5;
  const textSimilarityWeight = raw.textSimilarityWeight ? Number(raw.textSimilarityWeight) : 0.4;
  const embeddingSimilarityWeight = raw.embeddingSimilarityWeight ? Number(raw.embeddingSimilarityWeight) : 0.6;
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;

  return {
    enabled,
    minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0.5,
    textSimilarityWeight: Number.isFinite(textSimilarityWeight) ? textSimilarityWeight : 0.4,
    embeddingSimilarityWeight: Number.isFinite(embeddingSimilarityWeight) ? embeddingSimilarityWeight : 0.6,
    lookbackHours: Number.isFinite(lookbackHours) && lookbackHours > 0 ? lookbackHours : 24,
  };
}

type KalshiRow = {
  ticker: string;
  title: string;
  subtitle: string | null;
  last_price: number;
  volume_24h: number;
  status: string;
  collected_at: string;
};

type PolymarketRow = {
  id: string;
  event_id: string;
  question: string;
  slug: string;
  outcome_prices: string | null;
  volume_24h: number;
  closed: boolean;
  collected_at: string;
};

type EventMapping = {
  id: string;
  context_id: string | null;
  venue_a: string;
  ticker_a: string;
  title_a: string;
  venue_b: string;
  ticker_b: string;
  title_b: string;
  underlying_asset: string | null;
  confidence: number;
  method: string;
  event_type: string;
  created_at: string;
  updated_at: string;
};

type EmbeddingRow = {
  context_key: string;
  embedding: number[];
};

export class EventResolver {
  private feedApiBaseUrl: string;
  private internalToken: string;
  private embedDim: number;

  private log(level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.event_resolver.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "event-resolver",
            source: "resolver",
            at: new Date().toISOString(),
            message: msg,
            meta,
          })
        )
      );
    } catch {
      // ignore
    }
  }

  constructor(
    private readonly settings: EventResolverSettings,
    private readonly db: DbLike,
    private readonly nats: NatsLike,
    private readonly sc: StringCodecLike,
    opts: { apiBaseUrl: string; internalToken: string; embedDim: number }
  ) {
    this.feedApiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.embedDim = opts.embedDim;
  }

  async ensureSchema(): Promise<void> {
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_event_resolver");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_event_resolver.event_mappings (
        id text PRIMARY KEY,
        context_id text,
        venue_a text NOT NULL,
        ticker_a text NOT NULL,
        title_a text NOT NULL,
        venue_b text NOT NULL,
        ticker_b text NOT NULL,
        title_b text NOT NULL,
        underlying_asset text,
        confidence numeric NOT NULL,
        method text NOT NULL,
        event_type text NOT NULL DEFAULT 'unknown',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS event_mappings_venue_a_idx ON mod_event_resolver.event_mappings (venue_a, ticker_a)`
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS event_mappings_venue_b_idx ON mod_event_resolver.event_mappings (venue_b, ticker_b)`
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS event_mappings_asset_idx ON mod_event_resolver.event_mappings (underlying_asset)`
    );
    await this.db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS event_mappings_pair_idx ON mod_event_resolver.event_mappings (venue_a, ticker_a, venue_b, ticker_b)`
    );
  }

  async resolveEvents(): Promise<{
    kalshiScanned: number;
    polymarketScanned: number;
    mappingsCreated: number;
    mappingsUpdated: number;
    assetMappings: number;
  }> {
    const cutoff = new Date(Date.now() - this.settings.lookbackHours * 3600_000);
    this.log("info", "resolveEvents starting", { lookbackHours: this.settings.lookbackHours });

    let kalshiMarkets: KalshiRow[] = [];
    let polymarketMarkets: PolymarketRow[] = [];

    try {
      const kalshiRes = asResult<KalshiRow>(await this.db.query(
        `SELECT ticker, title, subtitle, last_price, volume_24h, status, collected_at
         FROM mod_kalshi.markets
         WHERE collected_at >= $1
         ORDER BY volume_24h DESC`,
        [cutoff]
      ));
      kalshiMarkets = kalshiRes.rows;
    } catch (err) {
      this.log("warn", "kalshi markets table not available", {
        err: err instanceof Error ? err.message : err,
      });
    }

    try {
      const polyRes = asResult<PolymarketRow>(await this.db.query(
        `SELECT id, event_id, question, slug, outcome_prices, volume_24h, closed, collected_at
         FROM mod_polymarket.markets
         WHERE collected_at >= $1 AND closed = false
         ORDER BY volume_24h DESC`,
        [cutoff]
      ));
      polymarketMarkets = polyRes.rows;
    } catch (err) {
      this.log("warn", "polymarket markets table not available", {
        err: err instanceof Error ? err.message : err,
      });
    }

    this.log("info", "markets loaded", {
      kalshi: kalshiMarkets.length,
      polymarket: polymarketMarkets.length,
    });

    let mappingsCreated = 0;
    let mappingsUpdated = 0;
    let assetMappings = 0;

    const kalshiEmbeddings = await this.loadEmbeddings("kalshi");
    const polyEmbeddings = await this.loadEmbeddings("polymarket");

    for (const kalshi of kalshiMarkets) {
      for (const poly of polymarketMarkets) {
        const textSim = this.textSimilarity(kalshi.title, poly.question);
        const kalshiEmb = kalshiEmbeddings.get(kalshi.ticker);
        const polyEmb = polyEmbeddings.get(poly.id);
        const embSim = kalshiEmb && polyEmb ? this.cosineSimilarity(kalshiEmb, polyEmb) : 0;

        const confidence =
          this.settings.textSimilarityWeight * textSim +
          this.settings.embeddingSimilarityWeight * embSim;

        if (confidence < this.settings.minConfidence) continue;

        const classification = classifyMarketText(kalshi.title + " " + poly.question);
        const underlying = this.resolveUnderlyingAsset(kalshi.ticker, poly.question);
        const method =
          embSim > 0 ? "text+embedding" : "text";
        const mappingId = uuidv5(`kalshi:${kalshi.ticker}:polymarket:${poly.id}`, UUID_NAMESPACE);

        const result = await this.upsertMapping({
          id: mappingId,
          venueA: "kalshi",
          tickerA: kalshi.ticker,
          titleA: kalshi.title,
          venueB: "polymarket",
          tickerB: poly.id,
          titleB: poly.question,
          underlyingAsset: underlying,
          confidence,
          method,
          eventType: classification.eventType,
        });

        if (result === "created") mappingsCreated++;
        if (result === "updated") mappingsUpdated++;
        if (underlying) assetMappings++;
      }

      const kalshiAsset = this.resolveUnderlyingAsset(kalshi.ticker, kalshi.title);
      if (kalshiAsset) {
        const assetMappingId = uuidv5(`kalshi:${kalshi.ticker}:asset:${kalshiAsset}`, UUID_NAMESPACE);
        const assetVenues = this.getAssetVenues(kalshi.ticker);
        for (const venue of assetVenues) {
          const venueId = uuidv5(`kalshi:${kalshi.ticker}:${venue}:${kalshiAsset}`, UUID_NAMESPACE);
          const result = await this.upsertMapping({
            id: venueId,
            venueA: "kalshi",
            tickerA: kalshi.ticker,
            titleA: kalshi.title,
            venueB: venue,
            tickerB: kalshiAsset,
            titleB: `${kalshiAsset} spot price`,
            underlyingAsset: kalshiAsset,
            confidence: 0.95,
            method: "ticker_map",
            eventType: EventType.PRICE_MOVEMENT,
          });
          if (result === "created") { mappingsCreated++; assetMappings++; }
          if (result === "updated") mappingsUpdated++;
        }
      }
    }

    for (const poly of polymarketMarkets) {
      const polyAsset = this.resolveUnderlyingAsset(poly.slug, poly.question);
      if (polyAsset) {
        const assetVenues = this.getAssetVenuesFromSymbol(polyAsset);
        for (const venue of assetVenues) {
          const venueId = uuidv5(`polymarket:${poly.id}:${venue}:${polyAsset}`, UUID_NAMESPACE);
          const result = await this.upsertMapping({
            id: venueId,
            venueA: "polymarket",
            tickerA: poly.id,
            titleA: poly.question,
            venueB: venue,
            tickerB: polyAsset,
            titleB: `${polyAsset} spot price`,
            underlyingAsset: polyAsset,
            confidence: 0.9,
            method: "text_extract",
            eventType: EventType.PRICE_MOVEMENT,
          });
          if (result === "created") { mappingsCreated++; assetMappings++; }
          if (result === "updated") mappingsUpdated++;
        }
      }
    }

    await this.publishResolverContext(kalshiMarkets.length, polymarketMarkets.length, mappingsCreated + mappingsUpdated);

    this.log("info", "resolveEvents complete", {
      kalshiScanned: kalshiMarkets.length,
      polymarketScanned: polymarketMarkets.length,
      mappingsCreated,
      mappingsUpdated,
      assetMappings,
    });

    return {
      kalshiScanned: kalshiMarkets.length,
      polymarketScanned: polymarketMarkets.length,
      mappingsCreated,
      mappingsUpdated,
      assetMappings,
    };
  }

  async resolveForMessage(params: {
    sourceModule: string;
    ticker: string;
    title: string;
  }): Promise<{ mappingsCreated: number; mappingsUpdated: number }> {
    let mappingsCreated = 0;
    let mappingsUpdated = 0;

    if (params.sourceModule === "kalshi") {
      let polymarketMarkets: PolymarketRow[] = [];
      try {
        const polyRes = asResult<PolymarketRow>(await this.db.query(
          `SELECT id, event_id, question, slug, outcome_prices, volume_24h, closed, collected_at
           FROM mod_polymarket.markets
           WHERE closed = false
           ORDER BY volume_24h DESC
           LIMIT 200`
        ));
        polymarketMarkets = polyRes.rows;
      } catch {
        return { mappingsCreated: 0, mappingsUpdated: 0 };
      }

      for (const poly of polymarketMarkets) {
        const textSim = this.textSimilarity(params.title, poly.question);
        if (textSim < this.settings.minConfidence * 0.8) continue;

        const classification = classifyMarketText(params.title + " " + poly.question);
        const underlying = this.resolveUnderlyingAsset(params.ticker, poly.question);
        const mappingId = uuidv5(`kalshi:${params.ticker}:polymarket:${poly.id}`, UUID_NAMESPACE);

        const result = await this.upsertMapping({
          id: mappingId,
          venueA: "kalshi",
          tickerA: params.ticker,
          titleA: params.title,
          venueB: "polymarket",
          tickerB: poly.id,
          titleB: poly.question,
          underlyingAsset: underlying,
          confidence: textSim,
          method: "text",
          eventType: classification.eventType,
        });

        if (result === "created") mappingsCreated++;
        if (result === "updated") mappingsUpdated++;
      }
    }

    if (params.sourceModule === "polymarket") {
      let kalshiMarkets: KalshiRow[] = [];
      try {
        const kalshiRes = asResult<KalshiRow>(await this.db.query(
          `SELECT ticker, title, subtitle, last_price, volume_24h, status, collected_at
           FROM mod_kalshi.markets
           ORDER BY volume_24h DESC
           LIMIT 200`
        ));
        kalshiMarkets = kalshiRes.rows;
      } catch {
        return { mappingsCreated: 0, mappingsUpdated: 0 };
      }

      for (const kalshi of kalshiMarkets) {
        const textSim = this.textSimilarity(kalshi.title, params.title);
        if (textSim < this.settings.minConfidence * 0.8) continue;

        const classification = classifyMarketText(kalshi.title + " " + params.title);
        const underlying = this.resolveUnderlyingAsset(kalshi.ticker, params.title);
        const mappingId = uuidv5(`kalshi:${kalshi.ticker}:polymarket:${params.ticker}`, UUID_NAMESPACE);

        const result = await this.upsertMapping({
          id: mappingId,
          venueA: "kalshi",
          tickerA: kalshi.ticker,
          titleA: kalshi.title,
          venueB: "polymarket",
          tickerB: params.ticker,
          titleB: params.title,
          underlyingAsset: underlying,
          confidence: textSim,
          method: "text",
          eventType: classification.eventType,
        });

        if (result === "created") mappingsCreated++;
        if (result === "updated") mappingsUpdated++;
      }
    }

    return { mappingsCreated, mappingsUpdated };
  }

  async queryEquivalents(params: {
    venue: string;
    ticker: string;
  }): Promise<EventMapping[]> {
    const res = asResult<EventMapping>(await this.db.query(
      `SELECT * FROM mod_event_resolver.event_mappings
       WHERE (venue_a = $1 AND ticker_a = $2)
          OR (venue_b = $1 AND ticker_b = $2)
       ORDER BY confidence DESC`,
      [params.venue, params.ticker]
    ));
    return res.rows;
  }

  async queryByAsset(asset: string): Promise<EventMapping[]> {
    const res = asResult<EventMapping>(await this.db.query(
      `SELECT * FROM mod_event_resolver.event_mappings
       WHERE underlying_asset = $1
       ORDER BY confidence DESC`,
      [asset]
    ));
    return res.rows;
  }

  async getMappingStats(): Promise<{
    totalMappings: number;
    crossVenueMappings: number;
    assetMappings: number;
    avgConfidence: number;
    byMethod: Record<string, number>;
    byEventType: Record<string, number>;
  }> {
    const totalRes = asResult<{ total: string }>(await this.db.query(
      `SELECT count(*) as total FROM mod_event_resolver.event_mappings`
    ));
    const total = Number(totalRes.rows[0]?.total ?? 0);

    const crossRes = asResult<{ total: string }>(await this.db.query(
      `SELECT count(*) as total FROM mod_event_resolver.event_mappings
       WHERE venue_a IN ('kalshi', 'polymarket') AND venue_b IN ('kalshi', 'polymarket')`
    ));
    const crossVenue = Number(crossRes.rows[0]?.total ?? 0);

    const assetRes = asResult<{ total: string }>(await this.db.query(
      `SELECT count(*) as total FROM mod_event_resolver.event_mappings
       WHERE underlying_asset IS NOT NULL`
    ));
    const assetCount = Number(assetRes.rows[0]?.total ?? 0);

    const avgRes = asResult<{ avg_conf: string }>(await this.db.query(
      `SELECT avg(confidence) as avg_conf FROM mod_event_resolver.event_mappings`
    ));
    const avgConf = Number(avgRes.rows[0]?.avg_conf ?? 0);

    const methodRes = asResult<{ method: string; cnt: string }>(await this.db.query(
      `SELECT method, count(*) as cnt FROM mod_event_resolver.event_mappings GROUP BY method`
    ));
    const byMethod: Record<string, number> = {};
    for (const row of methodRes.rows) {
      byMethod[row.method] = Number(row.cnt);
    }

    const typeRes = asResult<{ event_type: string; cnt: string }>(await this.db.query(
      `SELECT event_type, count(*) as cnt FROM mod_event_resolver.event_mappings GROUP BY event_type`
    ));
    const byEventType: Record<string, number> = {};
    for (const row of typeRes.rows) {
      byEventType[row.event_type] = Number(row.cnt);
    }

    return {
      totalMappings: total,
      crossVenueMappings: crossVenue,
      assetMappings: assetCount,
      avgConfidence: avgConf,
      byMethod,
      byEventType,
    };
  }

  private async loadEmbeddings(module: string): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    const schema = module === "kalshi" ? "mod_kalshi" : "mod_polymarket";
    const keyCol = module === "kalshi" ? "ticker" : "market_id";

    try {
      const res = asResult<{ context_key: string; embedding: string }>(await this.db.query(
        `SELECT ${keyCol} as context_key, embedding::text
         FROM ${schema}.market_embeddings
         WHERE embedding IS NOT NULL
         ORDER BY ts DESC`
      ));

      for (const row of res.rows) {
        if (map.has(row.context_key)) continue;
        try {
          const vec = JSON.parse(row.embedding.replace(/^\[/, "[").replace(/\]$/, "]")) as number[];
          map.set(row.context_key, vec);
        } catch {
          // skip malformed
        }
      }
    } catch (err) {
      this.log("debug", `no embeddings available for ${module}`, {
        err: err instanceof Error ? err.message : err,
      });
    }

    return map;
  }

  private async upsertMapping(params: {
    id: string;
    venueA: string;
    tickerA: string;
    titleA: string;
    venueB: string;
    tickerB: string;
    titleB: string;
    underlyingAsset: string | null;
    confidence: number;
    method: string;
    eventType: EventType;
  }): Promise<"created" | "updated" | "skipped"> {
    const res = asResult<{ inserted: boolean }>(await this.db.query(
      `INSERT INTO mod_event_resolver.event_mappings
       (id, venue_a, ticker_a, title_a, venue_b, ticker_b, title_b, underlying_asset, confidence, method, event_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (venue_a, ticker_a, venue_b, ticker_b)
       DO UPDATE SET
         confidence = GREATEST(mod_event_resolver.event_mappings.confidence, EXCLUDED.confidence),
         method = EXCLUDED.method,
         underlying_asset = COALESCE(EXCLUDED.underlying_asset, mod_event_resolver.event_mappings.underlying_asset),
         event_type = EXCLUDED.event_type,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        params.id,
        params.venueA,
        params.tickerA,
        params.titleA,
        params.venueB,
        params.tickerB,
        params.titleB,
        params.underlyingAsset,
        params.confidence,
        params.method,
        params.eventType,
      ]
    ));

    const inserted = res.rows[0]?.inserted;
    if (inserted === true) return "created";
    if (inserted === false) return "updated";
    return "skipped";
  }

  textSimilarity(a: string, b: string): number {
    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++;
    }

    const union = new Set([...tokensA, ...tokensB]).size;
    return union > 0 ? intersection / union : 0;
  }

  private tokenize(text: string): Set<string> {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been",
      "will", "would", "could", "should", "do", "does", "did",
      "to", "of", "in", "for", "on", "at", "by", "with", "from",
      "or", "and", "not", "no", "but", "if", "than", "that", "this",
      "it", "its", "as", "has", "have", "had",
      "what", "which", "who", "how", "when", "where", "why",
      "above", "below", "over", "under", "between",
      "yes", "no",
    ]);

    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && !stopWords.has(t))
    );
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  private resolveUnderlyingAsset(ticker: string, text: string): string | null {
    const upper = ticker.toUpperCase();
    const mapped = TICKER_TO_ASSET[upper];
    if (mapped) return mapped.symbol;

    for (const [prefix, asset] of Object.entries(TICKER_TO_ASSET)) {
      if (upper.startsWith(prefix)) return asset.symbol;
    }

    const lower = text.toLowerCase();
    if (lower.includes("bitcoin") || lower.includes("btc")) return "BTC/USD";
    if (lower.includes("ethereum") || lower.includes("eth")) return "ETH/USD";
    if (lower.includes("solana") || lower.includes("sol")) return "SOL/USD";
    if (lower.includes("cardano") || lower.includes("ada")) return "ADA/USD";
    if (lower.includes("dogecoin") || lower.includes("doge")) return "DOGE/USD";
    if (lower.includes("ripple") || lower.includes("xrp")) return "XRP/USD";
    if (lower.includes("polkadot") || lower.includes("dot")) return "DOT/USD";
    if (lower.includes("avalanche") || lower.includes("avax")) return "AVAX/USD";
    if (lower.includes("chainlink") || lower.includes("link")) return "LINK/USD";
    if (lower.includes("polygon") || lower.includes("matic")) return "MATIC/USD";

    return null;
  }

  private getAssetVenues(ticker: string): string[] {
    const upper = ticker.toUpperCase();
    const mapped = TICKER_TO_ASSET[upper];
    if (mapped) return mapped.venues;

    for (const [prefix, asset] of Object.entries(TICKER_TO_ASSET)) {
      if (upper.startsWith(prefix)) return asset.venues;
    }

    return ["coinbase", "binance"];
  }

  private getAssetVenuesFromSymbol(symbol: string): string[] {
    for (const asset of Object.values(TICKER_TO_ASSET)) {
      if (asset.symbol === symbol) return asset.venues;
    }
    return ["coinbase", "binance"];
  }

  private async publishResolverContext(
    kalshiCount: number,
    polyCount: number,
    totalMappings: number
  ) {
    try {
      const summaryShort = `Event resolver: ${totalMappings} mappings across ${kalshiCount + polyCount} markets`.slice(0, 128);
      const summaryLong = [
        `Cross-venue event resolver scan complete.`,
        `Kalshi markets scanned: ${kalshiCount}`,
        `Polymarket markets scanned: ${polyCount}`,
        `Total mappings: ${totalMappings}`,
      ].join("\n");

      const contextEvent = ContextUpdatedEventSchema.parse({
        type: "ContextUpdated",
        createdAt: new Date().toISOString(),
        context: {
          ownerModule: "event-resolver",
          sourceKey: "resolver:status",
          summaryShort,
          summaryLong,
          keyPoints: [
            `${kalshiCount} Kalshi markets`,
            `${polyCount} Polymarket markets`,
            `${totalMappings} cross-references`,
          ],
        },
      });

      this.nats.publish(
        subjectFor("event-resolver", "contextUpdated"),
        this.sc.encode(JSON.stringify(contextEvent))
      );
    } catch (err) {
      this.log("warn", "failed to publish resolver context", {
        err: err instanceof Error ? err.message : err,
      });
    }
  }
}
