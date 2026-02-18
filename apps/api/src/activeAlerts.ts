import type { Request, Response } from "express";
import type { StalenessTracker } from "./staleness.js";
import type { AcknowledgedAlerts } from "./alertAcknowledge.js";
import { getReconnectSummary } from "./reconnects.js";
import { KNOWN_MODULES } from "./moduleRestart.js";

type Severity = "info" | "warning" | "critical";

interface ActiveAlert {
  id: string;
  module: string;
  severity: Severity;
  message: string;
  triggered_at: string;
  age_seconds: number;
}

interface ActiveAlertsDeps {
  stalenessTracker: StalenessTracker;
  disabledModules: Set<string>;
  ackedAlerts: AcknowledgedAlerts;
  nowFn?: () => number;
  getReconnects?: () => Array<{ module: string; count: number; lastReconnectMs: number }>;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function getActiveAlerts(deps: ActiveAlertsDeps) {
  return (_req: Request, res: Response): void => {
    const now = deps.nowFn?.() ?? Date.now();
    const reconnects = deps.getReconnects?.() ?? getReconnectSummary();
    const alerts: ActiveAlert[] = [];

    const staleness = deps.stalenessTracker.getStalenessSummary();
    const stalenessMap = new Map(staleness.map((s) => [s.module, s]));
    const reconnectMap = new Map(reconnects.map((r) => [r.module, r]));

    const oneHourMs = 60 * 60 * 1000;
    let idCounter = 0;

    for (const name of KNOWN_MODULES) {
      const s = stalenessMap.get(name);
      if (s?.stale && !deps.ackedAlerts.isAcknowledged(name, "stale")) {
        const severity: Severity = s.ageSeconds > 300 ? "critical" : "warning";
        idCounter++;
        alerts.push({
          id: `alert-${idCounter}`,
          module: name,
          severity,
          message: `No data received for ${s.ageSeconds}s`,
          triggered_at: new Date(s.lastSeenMs).toISOString(),
          age_seconds: s.ageSeconds,
        });
      }

      const r = reconnectMap.get(name);
      if (r && r.count > 0 && (now - r.lastReconnectMs) < oneHourMs && !deps.ackedAlerts.isAcknowledged(name, "disconnected")) {
        const severity: Severity = r.count >= 5 ? "critical" : "warning";
        idCounter++;
        alerts.push({
          id: `alert-${idCounter}`,
          module: name,
          severity,
          message: `${r.count} reconnect(s) detected`,
          triggered_at: new Date(r.lastReconnectMs).toISOString(),
          age_seconds: Math.floor((now - r.lastReconnectMs) / 1000),
        });
      }

      if (deps.disabledModules.has(name) && !deps.ackedAlerts.isAcknowledged(name, "disabled")) {
        idCounter++;
        alerts.push({
          id: `alert-${idCounter}`,
          module: name,
          severity: "info",
          message: `Module ${name} is disabled`,
          triggered_at: new Date(now).toISOString(),
          age_seconds: 0,
        });
      }
    }

    alerts.sort((a, b) => {
      const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return new Date(a.triggered_at).getTime() - new Date(b.triggered_at).getTime();
    });

    const critical = alerts.filter((a) => a.severity === "critical").length;
    const warning = alerts.filter((a) => a.severity === "warning").length;
    const info = alerts.filter((a) => a.severity === "info").length;

    res.json({
      alerts,
      total: alerts.length,
      critical,
      warning,
      info,
    });
  };
}
