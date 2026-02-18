import type { Request, Response } from "express";
import Database from "better-sqlite3";
import { KNOWN_MODULES } from "./moduleRestart.js";

export type StatusEventType = "started" | "stopped" | "error" | "reconnected" | "rate-limited" | "config-changed";

interface StatusEvent {
  id: number;
  module: string;
  timestamp: string;
  event_type: StatusEventType;
  message: string;
  details: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export class StatusHistoryDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_status_events_module ON status_events (module, id DESC)`,
    );
  }

  record(module: string, eventType: StatusEventType, message: string, details?: Record<string, unknown>): void {
    this.db.prepare(
      "INSERT INTO status_events (module, timestamp, event_type, message, details) VALUES (?, ?, ?, ?, ?)",
    ).run(
      module,
      new Date().toISOString(),
      eventType,
      message,
      details ? JSON.stringify(details) : null,
    );
  }

  getEvents(module: string, limit: number): StatusEvent[] {
    const rows = this.db
      .prepare("SELECT id, module, timestamp, event_type, message, details FROM status_events WHERE module = ? ORDER BY id DESC LIMIT ?")
      .all(module, limit) as StatusEvent[];
    return rows.reverse();
  }

  totalEvents(module: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM status_events WHERE module = ?")
      .get(module) as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}

interface StatusHistoryDeps {
  historyDb: StatusHistoryDb;
}

export function getModuleStatusHistory({ historyDb }: StatusHistoryDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const rawLimit = req.query.limit;
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isFinite(parsed) || parsed < 1) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      limit = Math.min(Math.floor(parsed), MAX_LIMIT);
    }

    const events = historyDb.getEvents(name, limit);
    const total = historyDb.totalEvents(name);

    const parsed = events.map((e) => ({
      id: e.id,
      module: e.module,
      timestamp: e.timestamp,
      event_type: e.event_type,
      message: e.message,
      details: e.details ? JSON.parse(e.details) : null,
    }));

    const result: {
      module: string;
      events: typeof parsed;
      total_events: number;
      note?: string;
    } = {
      module: name,
      events: parsed,
      total_events: total,
    };

    if (parsed.length === 0) {
      result.note = "No status events recorded for this module";
    }

    res.json(result);
  };
}
