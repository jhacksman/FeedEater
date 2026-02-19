import type { Request, Response } from "express";
import type { LiveStatusStore } from "./status.js";
import { ALL_MODULES, toFilterStatus } from "./moduleList.js";

type ModuleType = "cex" | "dex" | "prediction";
type SearchStatus = "active" | "stopped" | "error";

const VALID_STATUSES = new Set<string>(["active", "stopped", "error"]);
const STATUS_TO_FILTER: Record<string, string> = { active: "active", stopped: "inactive", error: "error" };
const VALID_TYPES = new Set<string>(["cex", "dex", "prediction"]);

interface ModuleSearchDeps {
  store: LiveStatusStore;
}

export function getModuleSearch({ store }: ModuleSearchDeps) {
  return (req: Request, res: Response): void => {
    const liveModules = store.getAllModules();
    const liveMap = new Map(liveModules.map((m) => [m.name, m]));
    const uptimeSeconds = store.getUptimeSeconds();
    const uptimeMinutes = uptimeSeconds / 60;

    const statusParam = typeof req.query.status === "string" && VALID_STATUSES.has(req.query.status)
      ? req.query.status as SearchStatus
      : null;
    const typeParam = typeof req.query.type === "string" && VALID_TYPES.has(req.query.type)
      ? req.query.type as ModuleType
      : null;
    const qParam = typeof req.query.q === "string" && req.query.q.length > 0
      ? req.query.q.toLowerCase()
      : null;

    const all = ALL_MODULES.map((def) => {
      const live = liveMap.get(def.name);

      let status: "running" | "stopped" | "unknown";
      if (!live) {
        status = "unknown";
      } else if (live.status === "healthy") {
        status = "running";
      } else if (live.status === "offline") {
        status = "stopped";
      } else {
        status = "running";
      }

      let messageRate = 0;
      if (live && live.message_count > 0 && uptimeMinutes > 0) {
        messageRate = Math.round((live.message_count / uptimeMinutes) * 100) / 100;
      }

      const filterStatus = toFilterStatus(live?.status);

      return {
        name: def.name,
        type: def.type,
        natsSubject: `feedeater.${def.name}.tradeExecuted`,
        status,
        messageRate,
        _filterStatus: filterStatus,
      };
    });

    const total = all.length;

    let filtered = all;

    if (statusParam) {
      const internalStatus = STATUS_TO_FILTER[statusParam] ?? statusParam;
      filtered = filtered.filter((m) => m._filterStatus === internalStatus);
    }

    if (typeParam) {
      filtered = filtered.filter((m) => m.type === typeParam);
    }

    if (qParam) {
      filtered = filtered.filter((m) => m.name.toLowerCase().includes(qParam));
    }

    const modules = filtered.map(({ _filterStatus, ...rest }) => rest);

    res.json({
      modules,
      total,
      filtered: modules.length,
    });
  };
}
