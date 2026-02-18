import type { Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";

export class RateLimitDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS rate_limits (
        api_key TEXT PRIMARY KEY,
        requests_per_minute INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    );
  }

  getLimit(apiKey: string): number | null {
    const row = this.db
      .prepare("SELECT requests_per_minute FROM rate_limits WHERE api_key = ?")
      .get(apiKey) as { requests_per_minute: number } | undefined;
    return row?.requests_per_minute ?? null;
  }

  setLimit(apiKey: string, rpm: number): void {
    this.db
      .prepare(
        "INSERT INTO rate_limits (api_key, requests_per_minute, updated_at) VALUES (?, ?, ?) ON CONFLICT(api_key) DO UPDATE SET requests_per_minute = excluded.requests_per_minute, updated_at = excluded.updated_at",
      )
      .run(apiKey, rpm, new Date().toISOString());
  }

  deleteLimit(apiKey: string): boolean {
    const result = this.db
      .prepare("DELETE FROM rate_limits WHERE api_key = ?")
      .run(apiKey);
    return result.changes > 0;
  }

  listAll(): Array<{ apiKey: string; requestsPerMinute: number; updatedAt: string }> {
    const rows = this.db
      .prepare("SELECT api_key, requests_per_minute, updated_at FROM rate_limits")
      .all() as Array<{ api_key: string; requests_per_minute: number; updated_at: string }>;
    return rows.map((r) => ({
      apiKey: r.api_key,
      requestsPerMinute: r.requests_per_minute,
      updatedAt: r.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export function adminKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(503).json({ error: "Admin key not configured" });
    return;
  }

  const provided = req.headers["x-admin-key"];
  if (!provided || provided !== adminKey) {
    res.status(401).json({ error: "Invalid or missing admin key" });
    return;
  }

  next();
}

interface RateLimitsDeps {
  db: RateLimitDb;
  defaultLimit: number;
}

export function listRateLimits({ db, defaultLimit }: RateLimitsDeps) {
  return (_req: Request, res: Response): void => {
    const overrides = db.listAll();
    res.json({ defaultLimit, overrides });
  };
}

export function putRateLimit({ db }: RateLimitsDeps) {
  return (req: Request, res: Response): void => {
    const { key } = req.params;

    if (!key) {
      res.status(400).json({ error: "key is required" });
      return;
    }

    const { requestsPerMinute } = req.body as { requestsPerMinute?: number };

    if (
      requestsPerMinute === undefined ||
      typeof requestsPerMinute !== "number" ||
      !Number.isFinite(requestsPerMinute) ||
      requestsPerMinute < 1 ||
      requestsPerMinute > 10000
    ) {
      res.status(400).json({ error: "requestsPerMinute must be a number between 1 and 10000" });
      return;
    }

    db.setLimit(key, Math.floor(requestsPerMinute));
    res.json({ apiKey: key, requestsPerMinute: Math.floor(requestsPerMinute) });
  };
}

export function deleteRateLimit({ db, defaultLimit }: RateLimitsDeps) {
  return (req: Request, res: Response): void => {
    const { key } = req.params;

    if (!key) {
      res.status(400).json({ error: "key is required" });
      return;
    }

    const deleted = db.deleteLimit(key);
    if (!deleted) {
      res.status(404).json({ error: `No custom rate limit for key: ${key}` });
      return;
    }

    res.json({ apiKey: key, resetToDefault: defaultLimit });
  };
}
