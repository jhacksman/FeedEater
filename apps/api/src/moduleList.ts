import type { Request, Response } from "express";
import type { LiveStatusStore } from "./status.js";

type ModuleType = "cex" | "dex" | "prediction";

interface ModuleDef {
  name: string;
  type: ModuleType;
}

const ALL_MODULES: ModuleDef[] = [
  { name: "binance", type: "cex" },
  { name: "coinbase", type: "cex" },
  { name: "bybit", type: "cex" },
  { name: "gemini", type: "cex" },
  { name: "bitstamp", type: "cex" },
  { name: "okx", type: "cex" },
  { name: "uniswap-base", type: "dex" },
  { name: "aerodrome-base", type: "dex" },
  { name: "kalshi", type: "prediction" },
  { name: "polymarket", type: "prediction" },
];

interface ModuleListDeps {
  store: LiveStatusStore;
}

export function getModuleList({ store }: ModuleListDeps) {
  return (_req: Request, res: Response): void => {
    const liveModules = store.getAllModules();
    const liveMap = new Map(liveModules.map((m) => [m.name, m]));
    const uptimeSeconds = store.getUptimeSeconds();
    const uptimeMinutes = uptimeSeconds / 60;

    const modules = ALL_MODULES.map((def) => {
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

      return {
        name: def.name,
        type: def.type,
        natsSubject: `feedeater.${def.name}.tradeExecuted`,
        status,
        messageRate,
      };
    });

    res.json(modules);
  };
}
