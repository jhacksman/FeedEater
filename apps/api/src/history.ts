import type { Request, Response } from "express";
import pg from "pg";

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (pool) return pool;
  const url = process.env.POSTGRES_URL;
  if (!url) return null;
  pool = new pg.Pool({ connectionString: url });
  return pool;
}

function isISOTimestamp(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function clampLimit(raw: string | undefined): number {
  const n = Number(raw) || 100;
  return Math.min(Math.max(1, n), 1000);
}

export async function getHistory(req: Request, res: Response): Promise<void> {
  const p = getPool();
  if (!p) {
    res.status(503).json({ error: "Postgres not configured" });
    return;
  }

  const market = req.query.market as string | undefined;
  if (!market) {
    res.status(400).json({ error: "Missing required query param: market" });
    return;
  }

  const startRaw = req.query.start as string | undefined;
  const endRaw = req.query.end as string | undefined;
  const limit = clampLimit(req.query.limit as string | undefined);

  if (startRaw && !isISOTimestamp(startRaw)) {
    res.status(400).json({ error: "Invalid 'start' param. Use ISO 8601 timestamp." });
    return;
  }
  if (endRaw && !isISOTimestamp(endRaw)) {
    res.status(400).json({ error: "Invalid 'end' param. Use ISO 8601 timestamp." });
    return;
  }

  const conditions: string[] = ["subject = $1"];
  const params: (string | number)[] = [market];

  if (startRaw) {
    params.push(startRaw);
    conditions.push(`received_at >= $${params.length}::timestamptz`);
  }
  if (endRaw) {
    params.push(endRaw);
    conditions.push(`received_at <= $${params.length}::timestamptz`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `SELECT payload, received_at FROM raw_events WHERE ${conditions.join(" AND ")} ORDER BY received_at DESC LIMIT ${limitParam}`;

  try {
    const result = await p.query(sql, params);
    const records = result.rows.map((r: { payload: Record<string, unknown>; received_at: Date }) => ({
      timestamp: r.received_at,
      price: r.payload.price ?? null,
      volume: r.payload.volume ?? null,
      side: r.payload.side ?? null,
      source: r.payload.source ?? null,
    }));

    const start = startRaw ?? null;
    const end = endRaw ?? null;

    res.json({ market, start, end, records });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "query failed";
    res.status(500).json({ error: message });
  }
}

export { isISOTimestamp, clampLimit };
