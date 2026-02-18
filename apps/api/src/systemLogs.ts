import type { Request, Response } from "express";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
}

const MAX_STORED = 5000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const VALID_LEVELS = new Set<string>(["debug", "info", "warn", "error"]);

export class SystemLogStore {
  private entries: LogEntry[] = [];
  private nextId = 1;

  append(level: LogLevel, message: string, source: string, timestamp?: string): LogEntry {
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: timestamp ?? new Date().toISOString(),
      level,
      message,
      source,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_STORED) {
      this.entries = this.entries.slice(-MAX_STORED);
    }
    return entry;
  }

  all(): LogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.nextId = 1;
  }
}

function encodeCursor(id: number): string {
  return Buffer.from(String(id)).toString("base64");
}

function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const n = Number(decoded);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

interface SystemLogsDeps {
  logStore: SystemLogStore;
}

export function getSystemLogs({ logStore }: SystemLogsDeps) {
  return (_req: Request, res: Response): void => {
    const rawLimit = _req.query.limit;
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(Math.floor(parsed), MAX_LIMIT);
      }
    }

    const levelFilter = typeof _req.query.level === "string" && VALID_LEVELS.has(_req.query.level)
      ? _req.query.level as LogLevel
      : null;

    const sinceFilter = typeof _req.query.since === "string" ? _req.query.since : null;
    let sinceMs: number | null = null;
    if (sinceFilter) {
      const d = new Date(sinceFilter);
      if (!isNaN(d.getTime())) {
        sinceMs = d.getTime();
      }
    }

    const cursorRaw = typeof _req.query.cursor === "string" ? _req.query.cursor : null;
    let afterId: number | null = null;
    if (cursorRaw) {
      afterId = decodeCursor(cursorRaw);
      if (afterId === null) {
        res.status(400).json({ error: "Invalid cursor" });
        return;
      }
    }

    let entries = logStore.all();

    if (afterId !== null) {
      const idx = entries.findIndex((e) => e.id === afterId);
      entries = idx >= 0 ? entries.slice(idx + 1) : entries;
    }

    if (levelFilter) {
      entries = entries.filter((e) => e.level === levelFilter);
    }

    if (sinceMs !== null) {
      entries = entries.filter((e) => new Date(e.timestamp).getTime() >= sinceMs!);
    }

    const total = entries.length;
    const page = entries.slice(0, limit);

    let cursor: string | null = null;
    if (page.length > 0 && page.length < total) {
      cursor = encodeCursor(page[page.length - 1].id);
    }

    res.json({
      logs: page.map(({ id: _id, ...rest }) => rest),
      total,
      cursor,
    });
  };
}

export { encodeCursor, decodeCursor };
