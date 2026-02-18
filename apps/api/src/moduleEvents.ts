import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { StatusHistoryDb } from "./moduleStatusHistory.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

const SEVERITY_MAP: Record<string, string> = {
  started: "info",
  stopped: "warning",
  error: "error",
  reconnected: "warning",
  "rate-limited": "warning",
  "config-changed": "info",
};

interface ModuleEventsDeps {
  historyDb: StatusHistoryDb;
}

export function getModuleEvents({ historyDb }: ModuleEventsDeps) {
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

    const rows = historyDb.getEvents(name, limit);
    const total = historyDb.totalEvents(name);

    const events = rows.map((e) => ({
      id: e.id,
      event_type: e.event_type,
      severity: SEVERITY_MAP[e.event_type] ?? "info",
      timestamp: e.timestamp,
      message: e.message,
      details: e.details ? JSON.parse(e.details) : null,
    }));

    res.json({
      module: name,
      events,
      total_events: total,
      returned: events.length,
    });
  };
}
