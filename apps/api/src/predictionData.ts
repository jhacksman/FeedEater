/**
 * Public Prediction Market Data API (v1)
 *
 * Exposes Kalshi and Polymarket data collected by FeedEater
 * as a unified, clean API for researchers, quant funds, and data consumers.
 *
 * All endpoints are prefixed with /api/v1/data/predictions/
 */
import type { Request, Response, Router } from "express";
import { prisma } from "@feedeater/db";
import { Prisma } from "@feedeater/db";

// ---------- helpers ----------

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function parsePagination(req: Request): { limit: number; offset: number } {
  const limit = clamp(Number(req.query.limit) || 100, 1, 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  return { limit, offset };
}

function parseTimeRange(req: Request): { since?: Date; until?: Date } {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const until = req.query.until ? new Date(req.query.until as string) : undefined;
  return { since, until };
}

// ---------- Kalshi ----------

async function kalshiMarkets(req: Request, res: Response) {
  const { limit, offset } = parsePagination(req);
  const status = req.query.status as string | undefined;
  const search = req.query.q as string | undefined;

  const where: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (status) {
    where.push(`status = $${paramIdx++}`);
    params.push(status);
  }
  if (search) {
    where.push(`(title ILIKE $${paramIdx} OR subtitle ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  const markets: any[] = await prisma.$queryRawUnsafe(
    `SELECT ticker, title, subtitle, last_price, yes_bid, yes_ask,
            volume_24h, open_interest, status, close_time, collected_at
     FROM mod_kalshi.markets ${whereClause}
     ORDER BY volume_24h DESC NULLS LAST
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    ...params
  );

  const countResult: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int as total FROM mod_kalshi.markets ${whereClause}`,
    ...params.slice(0, params.length - 2)
  );

  res.json({
    venue: "kalshi",
    total: countResult[0]?.total ?? 0,
    limit,
    offset,
    data: markets.map((m) => ({
      ticker: m.ticker,
      title: m.title,
      subtitle: m.subtitle,
      lastPrice: m.last_price ? Number(m.last_price) : null,
      yesBid: m.yes_bid ? Number(m.yes_bid) : null,
      yesAsk: m.yes_ask ? Number(m.yes_ask) : null,
      volume24h: m.volume_24h ? Number(m.volume_24h) : null,
      openInterest: m.open_interest ? Number(m.open_interest) : null,
      status: m.status,
      closeTime: m.close_time,
      collectedAt: m.collected_at,
    })),
  });
}

async function kalshiTrades(req: Request, res: Response) {
  const { limit, offset } = parsePagination(req);
  const { since, until } = parseTimeRange(req);
  const ticker = req.query.ticker as string | undefined;

  const where: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (ticker) {
    where.push(`ticker = $${paramIdx++}`);
    params.push(ticker);
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
    `SELECT id, ticker, count, yes_price, taker_side, created_at
     FROM mod_kalshi.trades ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    ...params
  );

  res.json({
    venue: "kalshi",
    limit,
    offset,
    data: trades.map((t) => ({
      id: t.id,
      ticker: t.ticker,
      contracts: t.count,
      yesPrice: Number(t.yes_price),
      takerSide: t.taker_side,
      timestamp: t.created_at,
    })),
  });
}

async function kalshiMarketDetail(req: Request, res: Response) {
  const { ticker } = req.params;

  const markets: any[] = await prisma.$queryRawUnsafe(
    `SELECT ticker, title, subtitle, last_price, yes_bid, yes_ask,
            volume_24h, open_interest, status, close_time, payload, collected_at
     FROM mod_kalshi.markets WHERE ticker = $1`,
    ticker
  );

  if (!markets.length) {
    res.status(404).json({ error: "Market not found" });
    return;
  }

  const m = markets[0];

  // Get recent trades for this market
  const recentTrades: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, count, yes_price, taker_side, created_at
     FROM mod_kalshi.trades WHERE ticker = $1
     ORDER BY created_at DESC LIMIT 50`,
    ticker
  );

  res.json({
    venue: "kalshi",
    market: {
      ticker: m.ticker,
      title: m.title,
      subtitle: m.subtitle,
      lastPrice: m.last_price ? Number(m.last_price) : null,
      yesBid: m.yes_bid ? Number(m.yes_bid) : null,
      yesAsk: m.yes_ask ? Number(m.yes_ask) : null,
      volume24h: m.volume_24h ? Number(m.volume_24h) : null,
      openInterest: m.open_interest ? Number(m.open_interest) : null,
      status: m.status,
      closeTime: m.close_time,
      collectedAt: m.collected_at,
    },
    recentTrades: recentTrades.map((t) => ({
      id: t.id,
      contracts: t.count,
      yesPrice: Number(t.yes_price),
      takerSide: t.taker_side,
      timestamp: t.created_at,
    })),
  });
}

// ---------- Polymarket ----------

async function polymarketMarkets(req: Request, res: Response) {
  const { limit, offset } = parsePagination(req);
  const search = req.query.q as string | undefined;
  const closed = req.query.closed as string | undefined;

  const where: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (search) {
    where.push(`question ILIKE $${paramIdx++}`);
    params.push(`%${search}%`);
  }
  if (closed !== undefined) {
    where.push(`closed = $${paramIdx++}`);
    params.push(closed === "true");
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);

  const markets: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, event_id, question, slug, outcome_prices, outcomes,
            volume, volume_24h, liquidity, closed, end_date, collected_at
     FROM mod_polymarket.markets ${whereClause}
     ORDER BY volume_24h DESC NULLS LAST
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    ...params
  );

  const countResult: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int as total FROM mod_polymarket.markets ${whereClause}`,
    ...params.slice(0, params.length - 2)
  );

  res.json({
    venue: "polymarket",
    total: countResult[0]?.total ?? 0,
    limit,
    offset,
    data: markets.map((m) => ({
      id: m.id,
      eventId: m.event_id,
      question: m.question,
      slug: m.slug,
      outcomePrices: m.outcome_prices,
      outcomes: m.outcomes,
      volume: m.volume ? Number(m.volume) : null,
      volume24h: m.volume_24h ? Number(m.volume_24h) : null,
      liquidity: m.liquidity ? Number(m.liquidity) : null,
      closed: m.closed,
      endDate: m.end_date,
      collectedAt: m.collected_at,
    })),
  });
}

async function polymarketTrades(req: Request, res: Response) {
  const { limit, offset } = parsePagination(req);
  const { since, until } = parseTimeRange(req);
  const marketId = req.query.market_id as string | undefined;
  const whaleOnly = req.query.whale === "true";

  const where: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (marketId) {
    where.push(`market_id = $${paramIdx++}`);
    params.push(marketId);
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
    `SELECT id, market_id, outcome, side, size, price, notional_usd,
            size_category, is_whale, timestamp_ms, created_at
     FROM mod_polymarket.trades ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    ...params
  );

  res.json({
    venue: "polymarket",
    limit,
    offset,
    data: trades.map((t) => ({
      id: t.id,
      marketId: t.market_id,
      outcome: t.outcome,
      side: t.side,
      size: Number(t.size),
      price: Number(t.price),
      notionalUsd: Number(t.notional_usd),
      sizeCategory: t.size_category,
      isWhale: t.is_whale,
      timestampMs: Number(t.timestamp_ms),
      timestamp: t.created_at,
    })),
  });
}

async function polymarketMarketDetail(req: Request, res: Response) {
  const { id } = req.params;

  const markets: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, event_id, condition_id, question, slug, outcome_prices, outcomes,
            volume, volume_24h, liquidity, closed, end_date, payload, collected_at
     FROM mod_polymarket.markets WHERE id = $1`,
    id
  );

  if (!markets.length) {
    res.status(404).json({ error: "Market not found" });
    return;
  }

  const m = markets[0];

  const recentTrades: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, outcome, side, size, price, notional_usd, size_category, is_whale, created_at
     FROM mod_polymarket.trades WHERE market_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    id
  );

  res.json({
    venue: "polymarket",
    market: {
      id: m.id,
      eventId: m.event_id,
      conditionId: m.condition_id,
      question: m.question,
      slug: m.slug,
      outcomePrices: m.outcome_prices,
      outcomes: m.outcomes,
      volume: m.volume ? Number(m.volume) : null,
      volume24h: m.volume_24h ? Number(m.volume_24h) : null,
      liquidity: m.liquidity ? Number(m.liquidity) : null,
      closed: m.closed,
      endDate: m.end_date,
      collectedAt: m.collected_at,
    },
    recentTrades: recentTrades.map((t) => ({
      id: t.id,
      outcome: t.outcome,
      side: t.side,
      size: Number(t.size),
      price: Number(t.price),
      notionalUsd: Number(t.notional_usd),
      sizeCategory: t.size_category,
      isWhale: t.is_whale,
      timestamp: t.created_at,
    })),
  });
}

// ---------- Unified (cross-venue) ----------

async function unifiedStats(_req: Request, res: Response) {
  const kalshiStats: any[] = await prisma.$queryRawUnsafe(`
    SELECT
      count(*)::int as total_markets,
      count(*) FILTER (WHERE status = 'open')::int as active_markets,
      max(collected_at) as last_updated
    FROM mod_kalshi.markets
  `);

  const kalshiTradeStats: any[] = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int as total_trades,
           min(created_at) as earliest_trade,
           max(created_at) as latest_trade
    FROM mod_kalshi.trades
  `);

  const polyStats: any[] = await prisma.$queryRawUnsafe(`
    SELECT
      count(*)::int as total_markets,
      count(*) FILTER (WHERE closed = false)::int as active_markets,
      max(collected_at) as last_updated
    FROM mod_polymarket.markets
  `);

  const polyTradeStats: any[] = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int as total_trades,
           min(created_at) as earliest_trade,
           max(created_at) as latest_trade
    FROM mod_polymarket.trades
  `);

  res.json({
    venues: {
      kalshi: {
        markets: kalshiStats[0],
        trades: kalshiTradeStats[0],
      },
      polymarket: {
        markets: polyStats[0],
        trades: polyTradeStats[0],
      },
    },
    generatedAt: new Date().toISOString(),
  });
}

// ---------- Router registration ----------

export function registerPredictionDataRoutes(router: Router) {
  // Stats / overview
  router.get("/api/v1/data/predictions/stats", unifiedStats);

  // Kalshi
  router.get("/api/v1/data/predictions/kalshi/markets", kalshiMarkets);
  router.get("/api/v1/data/predictions/kalshi/markets/:ticker", kalshiMarketDetail);
  router.get("/api/v1/data/predictions/kalshi/trades", kalshiTrades);

  // Polymarket
  router.get("/api/v1/data/predictions/polymarket/markets", polymarketMarkets);
  router.get("/api/v1/data/predictions/polymarket/markets/:id", polymarketMarketDetail);
  router.get("/api/v1/data/predictions/polymarket/trades", polymarketTrades);
}
