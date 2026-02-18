import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { ModuleLogStore } from "./moduleLogs.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

interface ErrorsDeps {
  logStore: ModuleLogStore;
  nowFn?: () => number;
}

export function getModuleErrors({ logStore, nowFn }: ErrorsDeps) {
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
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(Math.floor(parsed), MAX_LIMIT);
      }
    }

    const since = typeof req.query.since === "string" ? req.query.since : null;
    let sinceMs = 0;
    if (since) {
      const parsed = new Date(since).getTime();
      if (Number.isFinite(parsed)) {
        sinceMs = parsed;
      }
    }

    const now = nowFn?.() ?? Date.now();
    const allEntries = logStore.tail(name, 1000);
    let errors = allEntries.filter((e) => e.level === "error");

    if (sinceMs > 0) {
      errors = errors.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
    }

    const totalErrors = errors.length;
    const limited = errors.slice(-limit);

    const windowStart = sinceMs > 0 ? new Date(sinceMs).toISOString() : (limited.length > 0 ? limited[0].timestamp : new Date(now).toISOString());
    const windowEnd = new Date(now).toISOString();

    res.json({
      module: name,
      errors: limited.map((e) => ({
        timestamp: e.timestamp,
        level: e.level,
        message: e.message,
        count: 1,
      })),
      total_errors: totalErrors,
      window_start: windowStart,
      window_end: windowEnd,
    });
  };
}
