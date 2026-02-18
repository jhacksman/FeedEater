import type { Request, Response } from "express";
import type { NatsConnection } from "nats";
import type { StalenessTracker } from "./staleness.js";
import type { ApiKeyDb } from "./apiKeys.js";
import type { Webhook } from "./webhooks.js";
import type { DeliveryLog } from "./webhooks.js";
import { getReconnectSummary } from "./reconnects.js";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface SummaryDeps {
  stalenessTracker: StalenessTracker;
  disabledModules: Set<string>;
  webhooks: Webhook[];
  deliveryLog: DeliveryLog;
  apiKeyDb: ApiKeyDb;
  getNatsConn: () => Promise<NatsConnection>;
}

export function getStatusSummary(deps: SummaryDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const staleness = deps.stalenessTracker.getStalenessSummary();
    const reconnects = getReconnectSummary();
    const reconnectMap = new Map(reconnects.map((r) => [r.module, r.count]));
    const stalenessMap = new Map(staleness.map((s) => [s.module, s]));

    const modules = [...KNOWN_MODULES].sort().map((name) => {
      const s = stalenessMap.get(name);
      return {
        name,
        enabled: !deps.disabledModules.has(name),
        stale: s?.stale ?? false,
        staleSecs: s?.ageSeconds ?? 0,
        reconnectCount: reconnectMap.get(name) ?? 0,
      };
    });

    let totalDeliveries = 0;
    for (const w of deps.webhooks) {
      totalDeliveries += deps.deliveryLog.get(w.id).length;
    }

    const activeKeys = deps.apiKeyDb.listKeys().length;

    let natsConnected = false;
    try {
      await deps.getNatsConn();
      natsConnected = true;
    } catch {}

    res.json({
      timestamp: new Date().toISOString(),
      modules,
      storage: { totalMessages: 0, dbSizeMb: 0 },
      webhooks: { registered: deps.webhooks.length, totalDeliveries },
      apiKeys: { active: activeKeys },
      nats: { connected: natsConnected },
    });
  };
}
