import type { Request, Response } from "express";
import type { LiveStatusStore } from "./status.js";
import { ALL_MODULES, toFilterStatus } from "./moduleList.js";

interface SummaryDeps {
  store: LiveStatusStore;
  nowFn?: () => number;
}

export function getModuleSummary({ store, nowFn }: SummaryDeps) {
  return (_req: Request, res: Response): void => {
    const liveModules = store.getAllModules();
    const liveMap = new Map(liveModules.map((m) => [m.name, m]));

    let active = 0;
    let inactive = 0;
    let error = 0;

    for (const def of ALL_MODULES) {
      const live = liveMap.get(def.name);
      const filter = toFilterStatus(live?.status);
      if (filter === "active") active++;
      else if (filter === "error") error++;
      else inactive++;
    }

    const now = nowFn?.() ?? Date.now();

    res.json({
      total: ALL_MODULES.length,
      active,
      inactive,
      error,
      last_updated: new Date(now).toISOString(),
    });
  };
}
