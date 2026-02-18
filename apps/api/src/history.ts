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

function encodeCursor(timestamp: string, id: string | number): string {
  return Buffer.from(`${timestamp}:${id}`).toString("base64");
}

function decodeCursor(cursor: string): { timestamp: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const idx = decoded.lastIndexOf(":");
    if (idx < 1) return null;
    const timestamp = decoded.slice(0, idx);
    const id = decoded.slice(idx + 1);
    if (!isISOTimestamp(timestamp) || !id) return null;
    return { timestamp, id };
  } catch {
    return null;
  }
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

  const cursorRaw = req.query.cursor as string | undefined;
  let cursorData: { timestamp: string; id: string } | null = null;
  if (cursorRaw) {
    cursorData = decodeCursor(cursorRaw);
    if (!cursorData) {
      res.status(400).json({ error: "Invalid cursor" });
      return;
    }
  }

  const conditions: string[] = ["subject = $1"];
  const params: (string | number)[] = [market];

  if (cursorData) {
    params.push(cursorData.timestamp);
    const tsIdx = params.length;
    params.push(cursorData.id);
    const idIdx = params.length;
    conditions.push(`(received_at < $${tsIdx}::timestamptz OR (received_at = $${tsIdx}::timestamptz AND id::text < $${idIdx}))`);
  }

  if (startRaw) {
    params.push(startRaw);
    conditions.push(`received_at >= $${params.length}::timestamptz`);
  }
  if (endRaw) {
    params.push(endRaw);
    conditions.push(`received_at <= $${params.length}::timestamptz`);
  }

  const fetchCount = limit + 1;
  params.push(fetchCount);
  const limitParam = `$${params.length}`;

  const sql = `SELECT id, payload, received_at FROM raw_events WHERE ${conditions.join(" AND ")} ORDER BY received_at DESC, id DESC LIMIT ${limitParam}`;

  try {
    const result = await p.query(sql, params);
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

    const records = rows.map((r: { id: number | string; payload: Record<string, unknown>; received_at: Date }) => ({
      timestamp: r.received_at,
      price: r.payload.price ?? null,
      volume: r.payload.volume ?? null,
      side: r.payload.side ?? null,
      source: r.payload.source ?? null,
    }));

    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      const lastRow = rows[rows.length - 1] as { id: number | string; received_at: Date };
      nextCursor = encodeCursor(new Date(lastRow.received_at).toISOString(), String(lastRow.id));
    }

    const start = startRaw ?? null;
    const end = endRaw ?? null;

    res.json({ market, start, end, records, next_cursor: nextCursor, has_more: hasMore });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "query failed";
    res.status(500).json({ error: message });
  }
}

export { isISOTimestamp, clampLimit, encodeCursor, decodeCursor };
