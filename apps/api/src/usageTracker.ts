import type { Request, Response } from "express";
import Database from "better-sqlite3";

export class UsageTracker {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage (
        key_id TEXT NOT NULL,
        date TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, date)
      )`,
    );
  }

  recordRequest(keyId: string): void {
    const date = new Date().toISOString().slice(0, 10);
    this.db.prepare(
      "INSERT INTO usage (key_id, date, count) VALUES (?, ?, 1) ON CONFLICT(key_id, date) DO UPDATE SET count = count + 1",
    ).run(keyId, date);
  }

  getUsage(keyId: string, days = 30): Array<{ date: string; count: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const rows = this.db
      .prepare("SELECT date, count FROM usage WHERE key_id = ? AND date >= ? ORDER BY date DESC")
      .all(keyId, cutoffStr) as Array<{ date: string; count: number }>;
    return rows;
  }

  getTotalUsage(keyId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(count), 0) as total FROM usage WHERE key_id = ?")
      .get(keyId) as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}

interface UsageDeps {
  tracker: UsageTracker;
}

export function getKeyUsage({ tracker }: UsageDeps) {
  return (req: Request, res: Response): void => {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const days = req.query.days ? Number(req.query.days) : 30;
    const totalRequests = tracker.getTotalUsage(id);
    const dailyBreakdown = tracker.getUsage(id, days);

    res.json({ keyId: id, totalRequests, dailyBreakdown });
  };
}
