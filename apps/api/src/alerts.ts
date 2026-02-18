import type { Request, Response } from "express";
import type { StalenessTracker } from "./staleness.js";
import { getReconnectSummary } from "./reconnects.js";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface Alert {
  module: string;
  type: "stale" | "disconnected" | "disabled" | "error";
  severity: "warning" | "critical";
  message: string;
  since: string;
}

interface AlertsDeps {
  stalenessTracker: StalenessTracker;
  disabledModules: Set<string>;
  nowFn?: () => number;
}

export function getAlerts(deps: AlertsDeps) {
  return (_req: Request, res: Response): void => {
    const now = deps.nowFn?.() ?? Date.now();
    const alerts: Alert[] = [];

    const staleness = deps.stalenessTracker.getStalenessSummary();
    const stalenessMap = new Map(staleness.map((s) => [s.module, s]));

    const reconnects = getReconnectSummary();
    const reconnectMap = new Map(reconnects.map((r) => [r.module, r]));

    const oneHourMs = 60 * 60 * 1000;

    for (const name of KNOWN_MODULES) {
      const s = stalenessMap.get(name);
      if (s?.stale) {
        alerts.push({
          module: name,
          type: "stale",
          severity: s.ageSeconds > 300 ? "critical" : "warning",
          message: `No data received for ${s.ageSeconds}s`,
          since: new Date(s.lastSeenMs).toISOString(),
        });
      }

      const r = reconnectMap.get(name);
      if (r && r.count > 0 && (now - r.lastReconnectMs) < oneHourMs) {
        alerts.push({
          module: name,
          type: "disconnected",
          severity: r.count >= 5 ? "critical" : "warning",
          message: `${r.count} reconnect(s) detected`,
          since: new Date(r.lastReconnectMs).toISOString(),
        });
      }

      if (deps.disabledModules.has(name)) {
        alerts.push({
          module: name,
          type: "disabled",
          severity: "warning",
          message: `Module ${name} is disabled`,
          since: new Date(now).toISOString(),
        });
      }
    }

    const critical = alerts.filter((a) => a.severity === "critical").length;
    const warning = alerts.filter((a) => a.severity === "warning").length;

    res.json({
      alerts,
      count: alerts.length,
      critical,
      warning,
    });
  };
}
