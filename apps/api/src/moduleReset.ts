import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { ModuleMetricsStore } from "./moduleMetrics.js";
import type { ReconnectStatsStore } from "./moduleReconnectStats.js";

const VALID_COUNTERS = ["errors", "reconnects", "throughput"] as const;
type Counter = (typeof VALID_COUNTERS)[number];

interface ResetDeps {
  metricsStore: ModuleMetricsStore;
  reconnectStore: ReconnectStatsStore;
  nowFn?: () => number;
}

export function postModuleReset({ metricsStore, reconnectStore, nowFn }: ResetDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const body = req.body as { counters?: string[] } | undefined;
    let countersToReset: Counter[];

    if (body?.counters && Array.isArray(body.counters) && body.counters.length > 0) {
      const invalid = body.counters.filter((c: string) => !VALID_COUNTERS.includes(c as Counter));
      if (invalid.length > 0) {
        res.status(400).json({ error: `Invalid counters: ${invalid.join(", ")}. Valid: ${VALID_COUNTERS.join(", ")}` });
        return;
      }
      countersToReset = body.counters as Counter[];
    } else {
      countersToReset = [...VALID_COUNTERS];
    }

    for (const counter of countersToReset) {
      switch (counter) {
        case "errors":
          metricsStore.resetErrors(name);
          break;
        case "reconnects":
          reconnectStore.resetModule(name);
          break;
        case "throughput":
          metricsStore.resetThroughput(name);
          break;
      }
    }

    const now = nowFn?.() ?? Date.now();

    res.json({
      module_name: name,
      reset_at: new Date(now).toISOString(),
      counters_reset: countersToReset,
    });
  };
}
