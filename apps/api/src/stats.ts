import type { Request, Response } from "express";
import pg from "pg";

const ALL_MODULES = [
  "binance", "coinbase", "bybit", "gemini", "bitstamp", "okx",
  "kalshi", "polymarket", "uniswap-base", "aerodrome-base",
];

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (pool) return pool;
  const url = process.env.POSTGRES_URL;
  if (!url) return null;
  pool = new pg.Pool({ connectionString: url });
  return pool;
}

interface ModuleStats {
  rowCount: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  estimatedSizeMb: number;
}

const EMPTY_STATS: ModuleStats = {
  rowCount: 0,
  oldestTimestamp: null,
  newestTimestamp: null,
  estimatedSizeMb: 0,
};

async function queryModuleStats(p: pg.Pool, moduleName: string): Promise<ModuleStats> {
  const subject = `feedeater.${moduleName}.%`;

  try {
    const countResult = await p.query(
      "SELECT COUNT(*)::int AS cnt FROM raw_events WHERE subject LIKE $1",
      [subject],
    );
    const rowCount: number = countResult.rows[0]?.cnt ?? 0;

    if (rowCount === 0) return { ...EMPTY_STATS };

    const rangeResult = await p.query(
      "SELECT MIN(received_at) AS oldest, MAX(received_at) AS newest FROM raw_events WHERE subject LIKE $1",
      [subject],
    );
    const oldest = rangeResult.rows[0]?.oldest;
    const newest = rangeResult.rows[0]?.newest;

    const sizeResult = await p.query(
      "SELECT pg_total_relation_size('raw_events') AS size_bytes",
    );
    const totalSizeBytes: number = Number(sizeResult.rows[0]?.size_bytes ?? 0);

    const totalCountResult = await p.query("SELECT COUNT(*)::int AS cnt FROM raw_events");
    const totalCount: number = totalCountResult.rows[0]?.cnt ?? 1;

    const fraction = totalCount > 0 ? rowCount / totalCount : 0;
    const estimatedSizeMb = Math.round((totalSizeBytes * fraction / (1024 * 1024)) * 100) / 100;

    return {
      rowCount,
      oldestTimestamp: oldest ? new Date(oldest).toISOString() : null,
      newestTimestamp: newest ? new Date(newest).toISOString() : null,
      estimatedSizeMb,
    };
  } catch {
    return { ...EMPTY_STATS };
  }
}

export async function getStats(_req: Request, res: Response): Promise<void> {
  const p = getPool();
  if (!p) {
    res.status(503).json({ error: "Postgres not configured" });
    return;
  }

  try {
    const modules: Record<string, ModuleStats> = {};
    let totalRows = 0;

    const results = await Promise.all(
      ALL_MODULES.map(async (name) => {
        const stats = await queryModuleStats(p, name);
        return { name, stats };
      }),
    );

    for (const { name, stats } of results) {
      modules[name] = stats;
      totalRows += stats.rowCount;
    }

    res.json({
      modules,
      totalRows,
      generatedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "query failed";
    res.status(500).json({ error: message });
  }
}
