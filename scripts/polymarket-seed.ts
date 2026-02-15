#!/usr/bin/env npx tsx
/**
 * Standalone Polymarket data seeder.
 * Bypasses FeedEater job scheduler — polls REST APIs directly,
 * seeds markets + trades into Postgres, publishes to NATS.
 *
 * Usage: npx tsx scripts/polymarket-seed.ts
 * Env: DATABASE_URL, NATS_URL (optional)
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://feedeater:feedeater@localhost:5432/feedeater";
const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

const db = new pg.Pool({ connectionString: DATABASE_URL });

async function ensureSchema() {
  await db.query("CREATE SCHEMA IF NOT EXISTS mod_polymarket");
  await db.query(`
    CREATE TABLE IF NOT EXISTS mod_polymarket.events (
      id text PRIMARY KEY,
      title text NOT NULL,
      slug text,
      category text,
      volume numeric DEFAULT 0,
      liquidity numeric DEFAULT 0,
      closed boolean DEFAULT false,
      payload jsonb,
      collected_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS mod_polymarket.markets (
      id text PRIMARY KEY,
      event_id text,
      question text NOT NULL,
      condition_id text,
      slug text,
      outcomes text,
      outcome_prices text,
      volume_24h numeric DEFAULT 0,
      liquidity numeric DEFAULT 0,
      closed boolean DEFAULT false,
      payload jsonb,
      collected_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS mod_polymarket.trades (
      id text PRIMARY KEY,
      market_id text,
      condition_id text,
      asset_id text,
      outcome text,
      side text NOT NULL,
      size numeric NOT NULL,
      price numeric NOT NULL,
      notional_usd numeric,
      size_category text,
      is_whale boolean DEFAULT false,
      taker_order_id text,
      timestamp_ms bigint,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS polymarket_trades_timestamp_idx ON mod_polymarket.trades (timestamp_ms DESC)`);
  console.log("[polymarket-seed] schema ready");
}

async function seedMarkets(): Promise<number> {
  // Fetch top markets by 24h volume
  const res = await fetch(`${GAMMA_API}/markets?closed=false&order=volume24hr&ascending=false&limit=100`);
  const markets = await res.json() as any[];

  let count = 0;
  for (const m of markets) {
    await db.query(`
      INSERT INTO mod_polymarket.markets (id, event_id, question, condition_id, slug, outcomes, outcome_prices, volume_24h, liquidity, closed, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        outcome_prices = EXCLUDED.outcome_prices,
        volume_24h = EXCLUDED.volume_24h,
        liquidity = EXCLUDED.liquidity,
        closed = EXCLUDED.closed,
        collected_at = now()
    `, [
      m.id, m.groupItemTitle ? null : m.id, m.question, m.conditionId, m.slug,
      m.outcomes, m.outcomePrices,
      m.volume24hr ?? 0, m.liquidity ?? 0, m.closed ?? false,
      JSON.stringify(m)
    ]);
    count++;
  }

  // Also fetch events
  const evRes = await fetch(`${GAMMA_API}/events?closed=false&order=volume24hr&ascending=false&limit=50`);
  const events = await evRes.json() as any[];
  for (const e of events) {
    await db.query(`
      INSERT INTO mod_polymarket.events (id, title, slug, category, volume, liquidity, closed, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        volume = EXCLUDED.volume,
        liquidity = EXCLUDED.liquidity,
        closed = EXCLUDED.closed,
        collected_at = now()
    `, [e.id, e.title, e.slug, e.category, e.volume ?? 0, e.liquidity ?? 0, e.closed ?? false, JSON.stringify(e)]);
  }

  console.log(`[polymarket-seed] seeded ${count} markets, ${events.length} events`);
  return count;
}

async function seedTrades(): Promise<number> {
  const res = await fetch(`${DATA_API}/trades?limit=100`);
  const trades = await res.json() as any[];

  let inserted = 0;
  for (const t of trades) {
    const id = t.transactionHash ? `${t.transactionHash}-${t.asset}-${t.timestamp}` : `${t.conditionId}-${t.timestamp}-${Math.random()}`;
    const notional = (t.size ?? 0) * (t.price ?? 0);
    const isWhale = notional >= 50000;
    const sizeCategory = notional >= 50000 ? "whale" : notional >= 10000 ? "large" : notional >= 1000 ? "medium" : "small";

    const result = await db.query(`
      INSERT INTO mod_polymarket.trades (id, market_id, condition_id, asset_id, outcome, side, size, price, notional_usd, size_category, is_whale, timestamp_ms)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO NOTHING
    `, [
      id, t.slug ?? null, t.conditionId, t.asset, t.outcome ?? null,
      t.side, t.size, t.price, notional, sizeCategory, isWhale,
      (t.timestamp ?? 0) * 1000
    ]);
    if (result.rowCount && result.rowCount > 0) inserted++;
  }

  console.log(`[polymarket-seed] inserted ${inserted} new trades (${trades.length} fetched)`);
  return inserted;
}

async function main() {
  console.log("[polymarket-seed] starting...");
  await ensureSchema();
  await seedMarkets();
  await seedTrades();

  // Poll loop — every 30 seconds
  console.log("[polymarket-seed] entering poll loop (30s interval)");
  setInterval(async () => {
    try {
      await seedTrades();
    } catch (err) {
      console.error("[polymarket-seed] trade poll error:", err);
    }
  }, 30_000);

  // Refresh markets every 5 minutes
  setInterval(async () => {
    try {
      await seedMarkets();
    } catch (err) {
      console.error("[polymarket-seed] market refresh error:", err);
    }
  }, 300_000);
}

main().catch((err) => {
  console.error("[polymarket-seed] fatal:", err);
  process.exit(1);
});
