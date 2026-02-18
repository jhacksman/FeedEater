import type { Request, Response } from "express";
import type { NatsConnection, Codec } from "nats";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface ControlDeps {
  getNatsConn: () => Promise<NatsConnection>;
  sc: Codec<string>;
  disabledModules: Set<string>;
}

export function postModuleDisable({ getNatsConn, sc, disabledModules }: ControlDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({
        error: `Unknown module: ${name}`,
      });
      return;
    }

    if (disabledModules.has(name)) {
      res.json({ ok: true, module: name, message: `Module ${name} is already disabled` });
      return;
    }

    const payload = {
      module: name,
      action: "disable",
      timestamp: new Date().toISOString(),
      requestedBy: req.headers.authorization
        ? "api-key-user"
        : "anonymous",
    };

    try {
      const nc = await getNatsConn();
      nc.publish(
        `feedeater.control.disable.${name}`,
        sc.encode(JSON.stringify(payload)),
      );
      disabledModules.add(name);
      res.json({ ok: true, module: name, message: `Module ${name} disabled` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "NATS publish failed";
      res.status(500).json({ error: message });
    }
  };
}

export function postModuleEnable({ getNatsConn, sc, disabledModules }: ControlDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({
        error: `Unknown module: ${name}`,
      });
      return;
    }

    if (!disabledModules.has(name)) {
      res.json({ ok: true, module: name, message: `Module ${name} is already enabled` });
      return;
    }

    const payload = {
      module: name,
      action: "enable",
      timestamp: new Date().toISOString(),
      requestedBy: req.headers.authorization
        ? "api-key-user"
        : "anonymous",
    };

    try {
      const nc = await getNatsConn();
      nc.publish(
        `feedeater.control.enable.${name}`,
        sc.encode(JSON.stringify(payload)),
      );
      disabledModules.delete(name);
      res.json({ ok: true, module: name, message: `Module ${name} enabled` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "NATS publish failed";
      res.status(500).json({ error: message });
    }
  };
}
