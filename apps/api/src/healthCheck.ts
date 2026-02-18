import type { Request, Response } from "express";
import type { NatsConnection } from "nats";
import { ModuleHealthStore } from "./moduleHealth.js";

interface HealthCheckDeps {
  getNatsConn: () => Promise<NatsConnection>;
  moduleHealthStore: ModuleHealthStore;
  startedAt: number;
}

export function getHealthCheck({ getNatsConn, moduleHealthStore, startedAt }: HealthCheckDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    const uptime = Math.floor((Date.now() - startedAt) / 1000);

    let natsStatus: "ok" | "error" = "error";
    try {
      const nc = await getNatsConn();
      natsStatus = nc.isClosed() ? "error" : "ok";
    } catch {
      natsStatus = "error";
    }

    const allModules = moduleHealthStore.getAll();
    const total = allModules.length;
    const running = allModules.filter((m) => m.status === "healthy" || m.status === "stale").length;
    const stopped = total - running;

    const allOk = natsStatus === "ok" && (total === 0 || running > 0);
    const statusCode = allOk ? 200 : 503;

    res.status(statusCode).json({
      status: allOk ? "ok" : "error",
      uptime,
      version: "1.0.0",
      checks: {
        nats: natsStatus,
        modules: { total, running, stopped },
      },
    });
  };
}
