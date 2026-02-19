import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface PurgeResult {
  rowCount: number;
}

interface PurgeDeps {
  runPurge: (module: string) => Promise<PurgeResult>;
  nowFn?: () => number;
}

export function postModulePurge({ runPurge, nowFn }: PurgeDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const body = req.body as { confirm?: boolean } | undefined;

    if (!body || body.confirm !== true) {
      res.status(400).json({
        error: "Missing required field: confirm must be true. This action permanently deletes all historical data for the module.",
      });
      return;
    }

    try {
      const result = await runPurge(name);
      const now = nowFn?.() ?? Date.now();

      res.json({
        module: name,
        purged: true,
        records_deleted: result.rowCount,
        purged_at: new Date(now).toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Purge failed";
      res.status(500).json({ error: message });
    }
  };
}

let purgePool: import("pg").Pool | null = null;

export function makePostgresPurge(): (module: string) => Promise<PurgeResult> {
  return async (module: string): Promise<PurgeResult> => {
    if (!purgePool) {
      const url = process.env.POSTGRES_URL;
      if (!url) throw new Error("Postgres not configured");
      const pg = await import("pg");
      purgePool = new pg.default.Pool({ connectionString: url });
    }
    const subject = `feedeater.${module}.messageCreated`;
    const result = await purgePool.query("DELETE FROM raw_events WHERE subject = $1", [subject]);
    return { rowCount: result.rowCount ?? 0 };
  };
}
