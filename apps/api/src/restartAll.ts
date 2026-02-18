import type { Request, Response } from "express";
import type { NatsConnection, Codec } from "nats";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface RestartAllDeps {
  getNatsConn: () => Promise<NatsConnection>;
  sc: Codec<string>;
  disabledModules: Set<string>;
}

export function postRestartAll({ getNatsConn, sc, disabledModules }: RestartAllDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const enabled = [...KNOWN_MODULES].filter((m) => !disabledModules.has(m));

    if (enabled.length === 0) {
      res.json({ restarted: [], failed: [], total: 0 });
      return;
    }

    const restarted: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];

    for (const name of enabled) {
      const payload = {
        module: name,
        timestamp: new Date().toISOString(),
        requestedBy: req.headers.authorization
          ? "api-key-user"
          : "anonymous",
      };

      try {
        const nc = await getNatsConn();
        nc.publish(
          `feedeater.control.restart.${name}`,
          sc.encode(JSON.stringify(payload)),
        );
        restarted.push(name);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : "NATS publish failed";
        failed.push({ name, reason });
      }
    }

    const total = restarted.length + failed.length;
    const status = failed.length > 0 ? 500 : 200;
    res.status(status).json({ restarted, failed, total });
  };
}
