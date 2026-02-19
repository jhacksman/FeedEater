import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { ModuleMetricsStore } from "./moduleMetrics.js";
import type { ReconnectStatsStore } from "./moduleReconnectStats.js";

interface FlushableStore {
  resetModule?: (name: string) => void;
  resetErrors?: (name: string) => void;
  resetThroughput?: (name: string) => void;
  reset?: (name: string) => boolean;
  clear?: () => void;
}

interface SystemFlushDeps {
  metricsStore: ModuleMetricsStore;
  reconnectStore: ReconnectStatsStore;
  extraStores?: FlushableStore[];
  nowFn?: () => number;
}

export function postSystemFlush({ metricsStore, reconnectStore, extraStores, nowFn }: SystemFlushDeps) {
  return (_req: Request, res: Response): void => {
    const modules = [...KNOWN_MODULES];

    for (const name of modules) {
      metricsStore.resetErrors(name);
      metricsStore.resetThroughput(name);
      reconnectStore.resetModule(name);
    }

    if (extraStores) {
      for (const store of extraStores) {
        if (store.clear) {
          store.clear();
        } else {
          for (const name of modules) {
            store.resetModule?.(name);
            store.reset?.(name);
          }
        }
      }
    }

    const now = nowFn?.() ?? Date.now();

    res.json({
      success: true,
      flushed_modules: modules,
      flushed_at: new Date(now).toISOString(),
      count: modules.length,
    });
  };
}
