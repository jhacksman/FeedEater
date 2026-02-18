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

interface SinceSpec {
  value: number;
  unit: string;
}

function parseSince(raw: string): SinceSpec | null {
  const m = raw.match(/^(\d+)([smhd])$/);
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2]! };
}

function sinceToInterval(spec: SinceSpec): string {
  const units: Record<string, string> = {
    s: "seconds",
    m: "minutes",
    h: "hours",
    d: "days",
  };
  return `${spec.value} ${units[spec.unit]}`;
}

export async function getHistory(req: Request, res: Response): Promise<void> {
  const p = getPool();
  if (!p) {
    res.status(503).json({ error: "Postgres not configured" });
    return;
  }

  const subject = req.query.subject as string | undefined;
  const sinceRaw = (req.query.since as string) ?? "1h";
  const limitRaw = (req.query.limit as string) ?? "100";

  const limit = Math.min(Math.max(1, Number(limitRaw) || 100), 1000);

  const since = parseSince(sinceRaw);
  if (!since) {
    res.status(400).json({ error: "Invalid 'since' param. Use e.g. 30m, 1h, 2d" });
    return;
  }

  const interval = sinceToInterval(since);
  const conditions: string[] = [`received_at >= NOW() - $1::interval`];
  const params: (string | number)[] = [interval];

  if (subject) {
    params.push(subject);
    conditions.push(`subject = $${params.length}`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `SELECT subject, payload, received_at FROM raw_events WHERE ${conditions.join(" AND ")} ORDER BY received_at DESC LIMIT ${limitParam}`;

  try {
    const result = await p.query(sql, params);
    const rows = result.rows.map((r: { subject: string; payload: unknown; received_at: Date }) => ({
      subject: r.subject,
      payload: r.payload,
      received_at: r.received_at,
    }));
    res.json(rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "query failed";
    res.status(500).json({ error: message });
  }
}

export { parseSince, sinceToInterval };
