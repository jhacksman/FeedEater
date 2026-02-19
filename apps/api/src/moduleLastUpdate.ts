import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

const MODULE_DATA_TYPES: Record<string, string> = {
  binance: "trade",
  coinbase: "trade",
  bybit: "trade",
  gemini: "trade",
  bitstamp: "trade",
  okx: "trade",
  kalshi: "event",
  polymarket: "event",
  "aerodrome-base": "swap",
  "uniswap-base": "swap",
};

interface UpdateRecord {
  timestamp: number;
  record_count: number;
}

export class LastUpdateStore {
  private updates = new Map<string, UpdateRecord[]>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  record(module: string, recordCount: number): void {
    let entries = this.updates.get(module);
    if (!entries) {
      entries = [];
      this.updates.set(module, entries);
    }
    entries.push({ timestamp: this.nowFn(), record_count: recordCount });
    if (entries.length > 100_000) {
      entries.splice(0, entries.length - 100_000);
    }
  }

  getLatest(module: string): UpdateRecord | null {
    const entries = this.updates.get(module);
    if (!entries || entries.length === 0) return null;
    return entries[entries.length - 1]!;
  }

  countSince(module: string, sinceMs: number): number {
    const entries = this.updates.get(module);
    if (!entries) return 0;
    let count = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.timestamp >= sinceMs) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
}

interface LastUpdateDeps {
  updateStore: LastUpdateStore;
  nowFn?: () => number;
}

export function getModuleLastUpdate({ updateStore, nowFn }: LastUpdateDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const now = nowFn ?? (() => Date.now());
    const currentTime = now();
    const latest = updateStore.getLatest(name);

    if (!latest) {
      res.json({
        module: name,
        last_update_at: null,
        seconds_ago: null,
        update_count_last_60s: 0,
        data_type: MODULE_DATA_TYPES[name] ?? "unknown",
        record_count: 0,
      });
      return;
    }

    const secondsAgo = Math.round((currentTime - latest.timestamp) / 1000);
    const sixtySecondsAgo = currentTime - 60_000;

    res.json({
      module: name,
      last_update_at: new Date(latest.timestamp).toISOString(),
      seconds_ago: secondsAgo,
      update_count_last_60s: updateStore.countSince(name, sixtySecondsAgo),
      data_type: MODULE_DATA_TYPES[name] ?? "unknown",
      record_count: latest.record_count,
    });
  };
}
