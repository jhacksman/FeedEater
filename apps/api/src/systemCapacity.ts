import os from "node:os";
import type { Request, Response } from "express";
import type { ModuleMetricsStore } from "./moduleMetrics.js";

interface CapacityDeps {
  metricsStore: ModuleMetricsStore;
  maxConnections?: number;
  nowFn?: () => number;
}

export function getSystemCapacity({ metricsStore, maxConnections, nowFn }: CapacityDeps) {
  const cpuCount = os.cpus().length;
  const memTotalMb = Math.round((os.totalmem() / 1024 / 1024) * 100) / 100;
  const maxConn = maxConnections ?? 100;

  return (_req: Request, res: Response): void => {
    const now = nowFn?.() ?? Date.now();
    const mem = process.memoryUsage();
    const memUsedMb = Math.round((mem.rss / 1024 / 1024) * 100) / 100;
    const memUsagePct = Math.round((memUsedMb / memTotalMb) * 10000) / 100;

    const activeNames = metricsStore.getModuleNames();
    const activeConnections = activeNames.length;

    let messageQueueDepth = 0;
    for (const name of activeNames) {
      const times = metricsStore.getMessageTimes(name);
      const cutoff = now - 60_000;
      for (const t of times) {
        if (t >= cutoff) messageQueueDepth++;
      }
    }

    const cpuUsage = process.cpuUsage();
    const cpuUsagePct = Math.round(((cpuUsage.user + cpuUsage.system) / 1_000_000 / (process.uptime() || 1)) * 10000) / 100;

    res.json({
      cpu_usage_pct: cpuUsagePct,
      memory_used_mb: memUsedMb,
      memory_total_mb: memTotalMb,
      memory_usage_pct: memUsagePct,
      active_connections: activeConnections,
      max_connections: maxConn,
      db_size_mb: 0,
      message_queue_depth: messageQueueDepth,
      timestamp: new Date(now).toISOString(),
    });
  };
}
