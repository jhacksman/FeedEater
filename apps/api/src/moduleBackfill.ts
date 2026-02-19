import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface BackfillState {
  backfill_active: boolean;
  progress_pct: number;
  records_backfilled: number;
  records_total: number;
  started_at: number | null;
  eta_seconds: number | null;
  since: string | null;
  limit: number | null;
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 100000;

export class BackfillStore {
  private states = new Map<string, BackfillState>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  getState(module: string): BackfillState {
    return this.states.get(module) ?? {
      backfill_active: false,
      progress_pct: 0,
      records_backfilled: 0,
      records_total: 0,
      started_at: null,
      eta_seconds: null,
      since: null,
      limit: null,
    };
  }

  start(module: string, since: string, limit: number): BackfillState {
    const state: BackfillState = {
      backfill_active: true,
      progress_pct: 0,
      records_backfilled: 0,
      records_total: limit,
      started_at: this.nowFn(),
      eta_seconds: null,
      since,
      limit,
    };
    this.states.set(module, state);
    return state;
  }

  updateProgress(module: string, records_backfilled: number): void {
    const state = this.states.get(module);
    if (!state || !state.backfill_active) return;
    state.records_backfilled = records_backfilled;
    state.progress_pct = state.records_total > 0
      ? Math.round((records_backfilled / state.records_total) * 10000) / 100
      : 0;
    if (state.started_at && records_backfilled > 0) {
      const elapsed = (this.nowFn() - state.started_at) / 1000;
      const rate = records_backfilled / elapsed;
      const remaining = state.records_total - records_backfilled;
      state.eta_seconds = rate > 0 ? Math.round(remaining / rate) : null;
    }
    if (records_backfilled >= state.records_total) {
      state.backfill_active = false;
      state.progress_pct = 100;
      state.eta_seconds = 0;
    }
  }
}

interface BackfillDeps {
  backfillStore: BackfillStore;
  nowFn?: () => number;
}

export function getModuleBackfillStatus({ backfillStore }: BackfillDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const state = backfillStore.getState(name);

    if (!state.backfill_active && state.started_at === null) {
      res.json({ module: name, backfill_active: false });
      return;
    }

    res.json({
      module: name,
      backfill_active: state.backfill_active,
      progress_pct: state.progress_pct,
      records_backfilled: state.records_backfilled,
      records_total: state.records_total,
      started_at: state.started_at ? new Date(state.started_at).toISOString() : null,
      eta_seconds: state.eta_seconds,
    });
  };
}

export function postModuleBackfill({ backfillStore, nowFn }: BackfillDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const current = backfillStore.getState(name);
    if (current.backfill_active) {
      res.status(409).json({ error: `Backfill already in progress for ${name}` });
      return;
    }

    if (!req.body?.since) {
      res.status(400).json({ error: "since is required (ISO timestamp)" });
      return;
    }

    const sinceTs = Date.parse(String(req.body.since));
    if (Number.isNaN(sinceTs)) {
      res.status(400).json({ error: "since must be a valid ISO timestamp" });
      return;
    }

    let limit = DEFAULT_LIMIT;
    if (req.body?.limit !== undefined) {
      const parsed = Number(req.body.limit);
      if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      if (parsed > MAX_LIMIT) {
        res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
        return;
      }
      limit = parsed;
    }

    const now = nowFn?.() ?? Date.now();
    const state = backfillStore.start(name, req.body.since, limit);

    res.json({
      module: name,
      backfill_active: true,
      since: req.body.since,
      limit,
      records_total: limit,
      started_at: new Date(state.started_at!).toISOString(),
    });
  };
}
