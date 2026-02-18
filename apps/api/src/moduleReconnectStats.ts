import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

const DEFAULT_WINDOW_SECONDS = 3600;

export class ReconnectStatsStore {
  private timestamps = new Map<string, number[]>();

  record(module: string): void {
    let times = this.timestamps.get(module);
    if (!times) {
      times = [];
      this.timestamps.set(module, times);
    }
    times.push(Date.now());
  }

  getTimestamps(module: string): number[] {
    return this.timestamps.get(module) ?? [];
  }

  clear(): void {
    this.timestamps.clear();
  }
}

interface ReconnectStatsDeps {
  store: ReconnectStatsStore;
  nowFn?: () => number;
}

export function getModuleReconnectStats({ store, nowFn }: ReconnectStatsDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const rawWindow = req.query.window;
    let windowSeconds = DEFAULT_WINDOW_SECONDS;
    if (rawWindow !== undefined) {
      const parsed = Number(rawWindow);
      if (Number.isFinite(parsed) && parsed > 0) {
        windowSeconds = Math.floor(parsed);
      }
    }

    const now = nowFn?.() ?? Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;

    const allTimes = store.getTimestamps(name);
    const recent = allTimes.filter((t) => t >= windowStart);

    const reconnectCount = recent.length;
    const lastReconnectAt = recent.length > 0 ? new Date(recent[recent.length - 1]).toISOString() : null;

    let avgInterval = 0;
    let maxGap = 0;

    if (recent.length >= 2) {
      const sorted = [...recent].sort((a, b) => a - b);
      let totalGap = 0;
      for (let i = 1; i < sorted.length; i++) {
        const gap = (sorted[i] - sorted[i - 1]) / 1000;
        totalGap += gap;
        if (gap > maxGap) maxGap = gap;
      }
      avgInterval = +(totalGap / (sorted.length - 1)).toFixed(2);
      maxGap = +maxGap.toFixed(2);
    }

    res.json({
      module: name,
      reconnect_count: reconnectCount,
      last_reconnect_at: lastReconnectAt,
      avg_reconnect_interval_seconds: avgInterval,
      max_gap_seconds: maxGap,
      window_seconds: windowSeconds,
      timestamp: new Date(now).toISOString(),
    });
  };
}
