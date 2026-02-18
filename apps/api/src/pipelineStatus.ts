import type { Request, Response } from "express";
import type { NatsConnection } from "nats";
import type { StalenessTracker } from "./staleness.js";
import type { ModuleMetricsStore } from "./moduleMetrics.js";
import { KNOWN_MODULES } from "./moduleRestart.js";

type ModuleType = "cex" | "dex" | "prediction";
type PipelineHealth = "healthy" | "degraded" | "down";
type ModuleStatus = "active" | "inactive" | "stale" | "error";

interface ModulePipelineDef {
  name: string;
  type: ModuleType;
  upstream: string[];
  downstream: string[];
}

const PIPELINE_DEFS: ModulePipelineDef[] = [
  { name: "binance", type: "cex", upstream: ["binance-ws"], downstream: ["nats", "postgres"] },
  { name: "coinbase", type: "cex", upstream: ["coinbase-ws"], downstream: ["nats", "postgres"] },
  { name: "bybit", type: "cex", upstream: ["bybit-ws"], downstream: ["nats", "postgres"] },
  { name: "gemini", type: "cex", upstream: ["gemini-ws"], downstream: ["nats", "postgres"] },
  { name: "bitstamp", type: "cex", upstream: ["bitstamp-ws"], downstream: ["nats", "postgres"] },
  { name: "okx", type: "cex", upstream: ["okx-ws"], downstream: ["nats", "postgres"] },
  { name: "uniswap-base", type: "dex", upstream: ["base-rpc"], downstream: ["nats", "postgres"] },
  { name: "aerodrome-base", type: "dex", upstream: ["base-rpc"], downstream: ["nats", "postgres"] },
  { name: "kalshi", type: "prediction", upstream: ["kalshi-api"], downstream: ["nats", "postgres"] },
  { name: "polymarket", type: "prediction", upstream: ["polymarket-api"], downstream: ["nats", "postgres"] },
];

interface PipelineDeps {
  stalenessTracker: StalenessTracker;
  metricsStore: ModuleMetricsStore;
  disabledModules: Set<string>;
  getNatsConn: () => Promise<NatsConnection>;
  checkPostgres: () => Promise<boolean>;
}

export function getPipelineStatus(deps: PipelineDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const staleness = deps.stalenessTracker.getStalenessSummary();
    const stalenessMap = new Map(staleness.map((s) => [s.module, s]));

    let natsConnected = false;
    try {
      await deps.getNatsConn();
      natsConnected = true;
    } catch {}

    let postgresConnected = false;
    try {
      postgresConnected = await deps.checkPostgres();
    } catch {}

    const modules = PIPELINE_DEFS.map((def) => {
      const disabled = deps.disabledModules.has(def.name);
      const staleInfo = stalenessMap.get(def.name);
      const metrics = deps.metricsStore.getMetrics(def.name);

      let status: ModuleStatus;
      if (disabled) {
        status = "inactive";
      } else if (metrics && metrics.total_errors > 0 && metrics.error_rate > 0) {
        status = "error";
      } else if (staleInfo?.stale) {
        status = "stale";
      } else if (metrics && metrics.total_messages > 0) {
        status = "active";
      } else {
        status = "inactive";
      }

      return {
        name: def.name,
        type: def.type,
        status,
        upstream: def.upstream,
        downstream: def.downstream,
        throughput: {
          message_rate: metrics?.message_rate ?? 0,
          total_messages: metrics?.total_messages ?? 0,
          last_message_at: metrics?.last_message_at ?? null,
        },
      };
    });

    const activeCount = modules.filter((m) => m.status === "active").length;
    const errorCount = modules.filter((m) => m.status === "error").length;
    const totalEnabled = modules.filter((m) => m.status !== "inactive").length;

    let health: PipelineHealth;
    if (!natsConnected || !postgresConnected || totalEnabled === 0) {
      health = "down";
    } else if (errorCount > 0 || activeCount < totalEnabled) {
      health = "degraded";
    } else {
      health = "healthy";
    }

    const latencySamples = modules
      .map((m) => {
        const metrics = deps.metricsStore.getMetrics(m.name);
        return metrics?.avg_latency_ms ?? null;
      })
      .filter((v): v is number => v !== null);

    const avgLatency = latencySamples.length > 0
      ? +(latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length).toFixed(2)
      : null;

    res.json({
      health,
      timestamp: new Date().toISOString(),
      modules,
      infrastructure: {
        nats: { connected: natsConnected },
        postgres: { connected: postgresConnected },
      },
      latency_estimate_ms: avgLatency,
    });
  };
}
