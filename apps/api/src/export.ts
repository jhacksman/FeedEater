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

function clampPerPage(raw: string | undefined): number {
  const n = Number(raw) || 100;
  return Math.min(Math.max(1, n), 1000);
}

function clampPage(raw: string | undefined): number {
  const n = Number(raw) || 1;
  return Math.max(1, n);
}

interface ExportRow {
  timestamp: string;
  price: string | null;
  volume: string | null;
  side: string | null;
  source: string | null;
}

function rowsToCsv(rows: ExportRow[]): string {
  const header = "timestamp,price,volume,side,source";
  const lines = rows.map(
    (r) =>
      `${r.timestamp},${r.price ?? ""},${r.volume ?? ""},${r.side ?? ""},${r.source ?? ""}`,
  );
  return [header, ...lines].join("\n") + "\n";
}

export async function getExport(req: Request, res: Response): Promise<void> {
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
  const format = (req.query.format as string | undefined) ?? "json";
  const perPage = clampPerPage(req.query.per_page as string | undefined);
  const page = clampPage(req.query.page as string | undefined);

  if (format !== "csv" && format !== "json") {
    res.status(400).json({ error: "Invalid 'format' param. Use 'csv' or 'json'." });
    return;
  }

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

  const offset = (page - 1) * perPage;
  params.push(perPage);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  const sql = `SELECT payload, received_at FROM raw_events WHERE ${conditions.join(" AND ")} ORDER BY received_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`;

  try {
    const result = await p.query(sql, params);
    const records: ExportRow[] = result.rows.map(
      (r: { payload: Record<string, unknown>; received_at: Date }) => ({
        timestamp: new Date(r.received_at).toISOString(),
        price: r.payload.price != null ? String(r.payload.price) : null,
        volume: r.payload.volume != null ? String(r.payload.volume) : null,
        side: r.payload.side != null ? String(r.payload.side) : null,
        source: r.payload.source != null ? String(r.payload.source) : null,
      }),
    );

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${market}-export.csv"`,
      );
      res.send(rowsToCsv(records));
      return;
    }

    res.json({ market, start: startRaw ?? null, end: endRaw ?? null, page, per_page: perPage, records });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "query failed";
    res.status(500).json({ error: message });
  }
}

export { isISOTimestamp, clampPerPage, clampPage, rowsToCsv };
