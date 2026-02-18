import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { ModuleMetricsStore } from "./moduleMetrics.js";
import type { ReconnectStatsStore } from "./moduleReconnectStats.js";
import type { UptimeStore } from "./moduleUptime.js";

interface SystemMetricsDeps {
  metricsStore: ModuleMetricsStore;
  reconnectStore: ReconnectStatsStore;
  uptimeStore: UptimeStore;
  nowFn?: () => number;
}

export function getSystemMetrics({ metricsStore, reconnectStore, uptimeStore, nowFn }: SystemMetricsDeps) {
  return (_req: Request, res: Response): void => {
    const now = nowFn?.() ?? Date.now();
    const totalModules = KNOWN_MODULES.size;

    const activeNames = metricsStore.getModuleNames();
    const activeModules = activeNames.length;

    let totalMessages = 0;
    let totalErrors = 0;
    let totalMessageTimes = 0;

    for (const name of activeNames) {
      const metrics = metricsStore.getMetrics(name);
      if (metrics) {
        totalMessages += metrics.total_messages;
        totalErrors += metrics.total_errors;
      }
      totalMessageTimes += metricsStore.getMessageTimes(name).length;
    }

    let totalReconnects = 0;
    for (const name of reconnectStore.getModuleNames()) {
      totalReconnects += reconnectStore.getTimestamps(name).length;
    }

    let uptimeSum = 0;
    let uptimeCount = 0;
    for (const modName of [...KNOWN_MODULES]) {
      const data = uptimeStore.getData(modName);
      if (data) {
        uptimeSum += Math.floor((now - data.startedAt) / 1000);
        uptimeCount += 1;
      }
    }
    const avgUptimeSeconds = uptimeCount > 0 ? Math.floor(uptimeSum / uptimeCount) : 0;

    const windowMs = 60_000;
    const windowStart = now - windowMs;
    let recentMessages = 0;
    for (const name of activeNames) {
      const times = metricsStore.getMessageTimes(name);
      for (const t of times) {
        if (t >= windowStart) recentMessages++;
      }
    }
    const systemThroughput = +(recentMessages / 60).toFixed(4);

    res.json({
      total_modules: totalModules,
      active_modules: activeModules,
      total_messages_processed: totalMessages,
      total_errors: totalErrors,
      avg_uptime_seconds: avgUptimeSeconds,
      total_reconnects: totalReconnects,
      system_throughput_per_second: systemThroughput,
      timestamp: new Date(now).toISOString(),
    });
  };
}
