import type { Request, Response } from "express";
import type { LiveStatusStore } from "./status.js";

const CEX_MODULES = ["binance", "coinbase", "bybit", "gemini", "bitstamp", "okx"] as const;

export interface MetricsDeps {
  store: LiveStatusStore;
}

export function getMetrics({ store }: MetricsDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const lines: string[] = [];
    const modules = store.getAllModules();
    const byName = new Map(modules.map((m) => [m.name, m]));

    lines.push("# HELP feedeater_module_running Whether the module is currently running (1) or not (0).");
    lines.push("# TYPE feedeater_module_running gauge");
    for (const mod of CEX_MODULES) {
      const entry = byName.get(mod);
      const running = entry && entry.status === "healthy" ? 1 : 0;
      lines.push(`feedeater_module_running{module="${mod}"} ${running}`);
    }

    lines.push("# HELP feedeater_messages_total Cumulative message count per module.");
    lines.push("# TYPE feedeater_messages_total counter");
    for (const mod of CEX_MODULES) {
      const entry = byName.get(mod);
      const count = entry?.message_count ?? 0;
      lines.push(`feedeater_messages_total{module="${mod}"} ${count}`);
    }

    lines.push("# HELP feedeater_uptime_seconds API process uptime in seconds.");
    lines.push("# TYPE feedeater_uptime_seconds gauge");
    lines.push(`feedeater_uptime_seconds ${store.getUptimeSeconds()}`);

    lines.push("# HELP feedeater_errors_total Cumulative error count per module and error type.");
    lines.push("# TYPE feedeater_errors_total counter");
    for (const mod of CEX_MODULES) {
      const entry = byName.get(mod);
      const reconnects = entry?.reconnect_count ?? 0;
      lines.push(`feedeater_errors_total{module="${mod}",error="circuit_breaker"} ${reconnects}`);
    }

    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(lines.join("\n") + "\n");
  };
}
