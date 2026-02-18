import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { ModuleMetricsStore } from "./moduleMetrics.js";

const DEFAULT_WINDOW_SECONDS = 300;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

interface LatencyDeps {
  metricsStore: ModuleMetricsStore;
  nowFn?: () => number;
}

export function getModuleLatency({ metricsStore, nowFn }: LatencyDeps) {
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
    const samples = metricsStore.getLatencySamples?.(name, windowSeconds * 1000) ?? [];

    const sorted = [...samples].sort((a, b) => a - b);

    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);

    res.json({
      module: name,
      p50_ms: +p50.toFixed(2),
      p95_ms: +p95.toFixed(2),
      p99_ms: +p99.toFixed(2),
      sample_count: sorted.length,
      window_seconds: windowSeconds,
      timestamp: new Date(now).toISOString(),
    });
  };
}
