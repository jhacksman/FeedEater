import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { ModuleMetricsStore } from "./moduleMetrics.js";

const DEFAULT_WINDOW_SECONDS = 60;

interface ThroughputDeps {
  metricsStore: ModuleMetricsStore;
  nowFn?: () => number;
}

export function getModuleThroughput({ metricsStore, nowFn }: ThroughputDeps) {
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

    const allTimes = metricsStore.getMessageTimes(name);
    const recent = allTimes.filter((t) => t >= windowStart);

    const totalMessages = recent.length;
    const messagesPerSecond = windowSeconds > 0 ? +(totalMessages / windowSeconds).toFixed(4) : 0;

    let peakPerSecond = 0;
    if (recent.length > 0) {
      const buckets = new Map<number, number>();
      for (const t of recent) {
        const bucket = Math.floor(t / 1000);
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      }
      for (const count of buckets.values()) {
        if (count > peakPerSecond) peakPerSecond = count;
      }
    }

    res.json({
      module: name,
      messages_per_second: messagesPerSecond,
      total_messages: totalMessages,
      window_seconds: windowSeconds,
      peak_messages_per_second: peakPerSecond,
      timestamp: new Date(now).toISOString(),
    });
  };
}
