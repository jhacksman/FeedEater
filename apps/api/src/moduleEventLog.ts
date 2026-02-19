import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_ENTRIES = 10_000;

const VALID_TYPES = new Set(["connect", "disconnect", "error", "restart", "config"]);

export interface EventLogEntry {
  type: "connect" | "disconnect" | "error" | "restart" | "config";
  message: string;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

export class EventLogStore {
  private logs = new Map<string, EventLogEntry[]>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  record(module: string, type: EventLogEntry["type"], message: string, metadata?: Record<string, unknown>): void {
    let entries = this.logs.get(module);
    if (!entries) {
      entries = [];
      this.logs.set(module, entries);
    }
    entries.push({
      type,
      message,
      occurred_at: new Date(this.nowFn()).toISOString(),
      metadata: metadata ?? {},
    });
    if (entries.length > MAX_ENTRIES) {
      entries.splice(0, entries.length - MAX_ENTRIES);
    }
  }

  getEntries(module: string): EventLogEntry[] {
    return this.logs.get(module) ?? [];
  }
}

interface EventLogDeps {
  eventLogStore: EventLogStore;
}

export function getModuleEventLog({ eventLogStore }: EventLogDeps) {
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

    const typeFilter = typeof req.query.type === "string" ? req.query.type : null;
    if (typeFilter && !VALID_TYPES.has(typeFilter)) {
      res.status(400).json({ error: `Invalid type filter: ${typeFilter}. Must be one of: ${[...VALID_TYPES].join(", ")}` });
      return;
    }

    const since = typeof req.query.since === "string" ? req.query.since : null;
    let sinceMs = 0;
    if (since) {
      const parsed = new Date(since).getTime();
      if (!Number.isFinite(parsed)) {
        res.status(400).json({ error: "since must be a valid ISO timestamp" });
        return;
      }
      sinceMs = parsed;
    }

    let entries = eventLogStore.getEntries(name);

    if (typeFilter) {
      entries = entries.filter((e) => e.type === typeFilter);
    }

    if (sinceMs > 0) {
      entries = entries.filter((e) => new Date(e.occurred_at).getTime() >= sinceMs);
    }

    const total = entries.length;
    const limited = entries.slice(-limit);

    res.json({
      module: name,
      events: limited,
      total,
    });
  };
}
