import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { ModuleHealthStore } from "./moduleHealth.js";

interface ModuleHealthCheckDeps {
  healthStore: ModuleHealthStore;
  disabledModules: Set<string>;
  startedAt: number;
  nowFn?: () => number;
}

export function getModuleHealthCheck({ healthStore, disabledModules, startedAt, nowFn }: ModuleHealthCheckDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const now = nowFn?.() ?? Date.now();
    const all = healthStore.getAll();
    const entry = all.find((m) => m.module === name);

    const lastHeartbeat = entry?.lastMessage ?? null;
    const messageCount = entry?.messageCount ?? 0;

    let status: "healthy" | "degraded" | "error";
    let consecutiveErrors = 0;

    if (disabledModules.has(name)) {
      status = "error";
    } else if (!lastHeartbeat) {
      status = "error";
    } else {
      const elapsed = now - new Date(lastHeartbeat).getTime();
      const fiveMin = 5 * 60 * 1000;
      const thirtyMin = 30 * 60 * 1000;
      if (elapsed > thirtyMin) {
        status = "error";
        consecutiveErrors = Math.floor(elapsed / fiveMin);
      } else if (elapsed > fiveMin) {
        status = "degraded";
        consecutiveErrors = Math.floor(elapsed / fiveMin);
      } else {
        status = "healthy";
      }
    }

    const uptimeSeconds = Math.floor((now - startedAt) / 1000);

    res.json({
      module: name,
      status,
      disabled: disabledModules.has(name),
      last_heartbeat: lastHeartbeat,
      message_count: messageCount,
      consecutive_errors: consecutiveErrors,
      uptime_seconds: uptimeSeconds,
    });
  };
}
