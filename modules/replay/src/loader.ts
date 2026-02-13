import type { DbLike } from "@feedeater/module-sdk";

type QueryResult<T = Record<string, unknown>> = { rows: T[]; rowCount: number };

function asResult<T = Record<string, unknown>>(raw: unknown): QueryResult<T> {
  const r = raw as QueryResult<T> | undefined;
  return { rows: r?.rows ?? [], rowCount: r?.rowCount ?? 0 };
}

export type ReplayMessage = {
  id: string;
  createdAt: Date;
  sourceModule: string;
  sourceStream: string | null;
  message: string | null;
  from: string | null;
  tagsJson: Record<string, unknown> | null;
  rawJson: Record<string, unknown>;
};

export type ModuleMarketSnapshot = {
  ts: Date;
  sourceModule: string;
  ticker: string;
  title: string;
  price: number;
  volume24h: number;
  raw: Record<string, unknown>;
};

export async function loadBusMessages(
  db: DbLike,
  params: {
    startTime: Date;
    endTime: Date;
    filterModules: string[];
    batchSize: number;
    offset: number;
  }
): Promise<ReplayMessage[]> {
  const hasFilter = params.filterModules.length > 0;
  const sql = hasFilter
    ? `SELECT id, "createdAt", "sourceModule", "sourceStream", message, "from", "tagsJson", "rawJson"
       FROM bus_messages
       WHERE "createdAt" >= $1 AND "createdAt" <= $2
         AND "sourceModule" = ANY($3)
       ORDER BY "createdAt" ASC
       LIMIT $4 OFFSET $5`
    : `SELECT id, "createdAt", "sourceModule", "sourceStream", message, "from", "tagsJson", "rawJson"
       FROM bus_messages
       WHERE "createdAt" >= $1 AND "createdAt" <= $2
       ORDER BY "createdAt" ASC
       LIMIT $3 OFFSET $4`;

  const sqlParams = hasFilter
    ? [params.startTime, params.endTime, params.filterModules, params.batchSize, params.offset]
    : [params.startTime, params.endTime, params.batchSize, params.offset];

  const res = asResult<{
    id: string;
    createdAt: string | Date;
    sourceModule: string;
    sourceStream: string | null;
    message: string | null;
    from: string | null;
    tagsJson: Record<string, unknown> | null;
    rawJson: Record<string, unknown>;
  }>(await db.query(sql, sqlParams));

  return res.rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
    sourceModule: r.sourceModule,
    sourceStream: r.sourceStream,
    message: r.message,
    from: r.from,
    tagsJson: r.tagsJson,
    rawJson: r.rawJson,
  }));
}

export async function countBusMessages(
  db: DbLike,
  params: {
    startTime: Date;
    endTime: Date;
    filterModules: string[];
  }
): Promise<number> {
  const hasFilter = params.filterModules.length > 0;
  const sql = hasFilter
    ? `SELECT count(*) as cnt FROM bus_messages
       WHERE "createdAt" >= $1 AND "createdAt" <= $2
         AND "sourceModule" = ANY($3)`
    : `SELECT count(*) as cnt FROM bus_messages
       WHERE "createdAt" >= $1 AND "createdAt" <= $2`;

  const sqlParams = hasFilter
    ? [params.startTime, params.endTime, params.filterModules]
    : [params.startTime, params.endTime];

  const res = asResult<{ cnt: string }>(await db.query(sql, sqlParams));
  return Number(res.rows[0]?.cnt ?? 0);
}

export async function loadKalshiSnapshots(
  db: DbLike,
  params: { startTime: Date; endTime: Date }
): Promise<ModuleMarketSnapshot[]> {
  try {
    const res = asResult<{
      ticker: string;
      title: string;
      last_price: string;
      volume_24h: string;
      collected_at: string | Date;
      payload: Record<string, unknown>;
    }>(await db.query(
      `SELECT ticker, title, last_price, volume_24h, collected_at, payload
       FROM mod_kalshi.markets
       WHERE collected_at >= $1 AND collected_at <= $2
       ORDER BY collected_at ASC`,
      [params.startTime, params.endTime]
    ));

    return res.rows.map((r) => ({
      ts: r.collected_at instanceof Date ? r.collected_at : new Date(r.collected_at),
      sourceModule: "kalshi",
      ticker: r.ticker,
      title: r.title,
      price: Number(r.last_price),
      volume24h: Number(r.volume_24h),
      raw: r.payload,
    }));
  } catch {
    return [];
  }
}

export async function loadPolymarketSnapshots(
  db: DbLike,
  params: { startTime: Date; endTime: Date }
): Promise<ModuleMarketSnapshot[]> {
  try {
    const res = asResult<{
      id: string;
      question: string;
      outcome_prices: string | number[] | null;
      volume_24h: string;
      collected_at: string | Date;
      payload: Record<string, unknown>;
    }>(await db.query(
      `SELECT id, question, outcome_prices, volume_24h, collected_at, payload
       FROM mod_polymarket.markets
       WHERE collected_at >= $1 AND collected_at <= $2
       ORDER BY collected_at ASC`,
      [params.startTime, params.endTime]
    ));

    return res.rows.map((r) => {
      let price = 0;
      if (typeof r.outcome_prices === "string") {
        try {
          const parsed = JSON.parse(r.outcome_prices) as number[];
          price = parsed[0] ?? 0;
        } catch { /* ignore */ }
      } else if (Array.isArray(r.outcome_prices)) {
        price = r.outcome_prices[0] ?? 0;
      }
      return {
        ts: r.collected_at instanceof Date ? r.collected_at : new Date(r.collected_at),
        sourceModule: "polymarket",
        ticker: r.id,
        title: r.question,
        price,
        volume24h: Number(r.volume_24h),
        raw: r.payload,
      };
    });
  } catch {
    return [];
  }
}

export type EventMappingRow = {
  id: string;
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
};

export async function loadEventMappings(db: DbLike): Promise<EventMappingRow[]> {
  try {
    const res = asResult<EventMappingRow>(await db.query(
      `SELECT id, venue_a, ticker_a, title_a, venue_b, ticker_b, title_b,
              underlying_asset, confidence, method, event_type
       FROM mod_event_resolver.event_mappings
       ORDER BY confidence DESC`
    ));
    return res.rows;
  } catch {
    return [];
  }
}
