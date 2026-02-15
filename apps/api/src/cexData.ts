/**
 * Public CEX Trade Data API (v1)
 *
 * Exposes Coinbase, Kraken, and Binance trade data collected by FeedEater.
 */
import type { Request, Response, Router } from "express";
import { prisma } from "@feedeater/db";

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function parsePagination(req: Request): { limit: number; offset: number } {
  const limit = clamp(Number(req.query.limit) || 100, 1, 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  return { limit, offset };
}

type CexVenue = "coinbase" | "kraken" | "binance";

const VENUE_CONFIG: Record<CexVenue, { schema: string; pairCol: string }> = {
  coinbase: { schema: "mod_coinbase", pairCol: "pair" },
  kraken: { schema: "mod_kraken", pairCol: "pair" },
  binance: { schema: "mod_binance", pairCol: "symbol" },
};

function isValidVenue(v: string): v is CexVenue {
  return v in VENUE_CONFIG;
}

async function cexTrades(req: Request, res: Response) {
  const venue = req.params.venue;
  if (!isValidVenue(venue)) {
    res.status(400).json({ error: `Invalid venue. Use: ${Object.keys(VENUE_CONFIG).join(", ")}` });
    return;
  }

  const { schema, pairCol } = VENUE_CONFIG[venue];
  const { limit, offset } = parsePagination(req);
  const pair = req.query.pair as string | undefined;
  const whaleOnly = req.query.whale === "true";
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const until = req.query.until ? new Date(req.query.until as string) : undefined;

  const where: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (pair) {
    where.push(`${pairCol} = $${paramIdx++}`);
    params.push(pair);
  }
  if (whaleOnly) {
    where.push(`is_whale = true`);
  }
  if (since) {
    where.push(`created_at >= $${paramIdx++}`);
    params.push(since);
  }
  if (until) {
    where.push(`created_at <= $${paramIdx++}`);
    params.push(until);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  const trades: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, ${pairCol} as pair, price, size, side, notional_usd, is_whale, created_at
     FROM ${schema}.trades ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    ...params
  );

  res.json({
    venue,
    limit,
    offset,
    data: trades.map((t) => ({
      id: t.id,
      pair: t.pair,
      price: Number(t.price),
      size: Number(t.size),
      side: t.side,
      notionalUsd: Number(t.notional_usd),
      isWhale: t.is_whale,
      timestamp: t.created_at,
    })),
  });
}

async function cexPairs(req: Request, res: Response) {
  const venue = req.params.venue;
  if (!isValidVenue(venue)) {
    res.status(400).json({ error: `Invalid venue. Use: ${Object.keys(VENUE_CONFIG).join(", ")}` });
    return;
  }

  const { schema, pairCol } = VENUE_CONFIG[venue];

  const pairs: any[] = await prisma.$queryRawUnsafe(
    `SELECT ${pairCol} as pair, count(*)::int as trade_count,
            min(created_at) as first_trade, max(created_at) as last_trade
     FROM ${schema}.trades
     GROUP BY ${pairCol}
     ORDER BY trade_count DESC`
  );

  res.json({
    venue,
    data: pairs.map((p) => ({
      pair: p.pair,
      tradeCount: p.trade_count,
      firstTrade: p.first_trade,
      lastTrade: p.last_trade,
    })),
  });
}

async function cexStats(_req: Request, res: Response) {
  const stats: Record<string, any> = {};

  for (const [venue, { schema }] of Object.entries(VENUE_CONFIG)) {
    const result: any[] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::int as total_trades,
             count(*) FILTER (WHERE is_whale = true)::int as whale_trades,
             min(created_at) as earliest,
             max(created_at) as latest
      FROM ${schema}.trades
    `);
    stats[venue] = result[0];
  }

  res.json({ venues: stats, generatedAt: new Date().toISOString() });
}

export function registerCexDataRoutes(router: Router) {
  router.get("/api/v1/data/cex/stats", cexStats);
  router.get("/api/v1/data/cex/:venue/pairs", cexPairs);
  router.get("/api/v1/data/cex/:venue/trades", cexTrades);
}
