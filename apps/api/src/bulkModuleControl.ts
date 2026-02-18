import type { Request, Response } from "express";
import type { NatsConnection, Codec } from "nats";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { ModuleConfigDb } from "./moduleControl.js";

interface BulkControlDeps {
  getNatsConn: () => Promise<NatsConnection>;
  sc: Codec<string>;
  disabledModules: Set<string>;
  db?: ModuleConfigDb;
}

interface BulkResult {
  succeeded: string[];
  failed: Array<{ name: string; reason: string }>;
}

export function postBulkEnable({ getNatsConn, sc, disabledModules, db }: BulkControlDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as { modules?: unknown };

    if (!body || !Array.isArray(body.modules)) {
      res.status(400).json({ error: "Request body must contain a \"modules\" array" });
      return;
    }

    const modules = body.modules as unknown[];
    if (modules.length === 0) {
      res.json({ succeeded: [], failed: [] } satisfies BulkResult);
      return;
    }

    const result: BulkResult = { succeeded: [], failed: [] };

    for (const item of modules) {
      const name = typeof item === "string" ? item : String(item);

      if (!KNOWN_MODULES.has(name)) {
        result.failed.push({ name, reason: "not found" });
        continue;
      }

      if (!disabledModules.has(name)) {
        result.succeeded.push(name);
        continue;
      }

      try {
        const nc = await getNatsConn();
        const payload = {
          module: name,
          action: "enable",
          timestamp: new Date().toISOString(),
          requestedBy: req.headers.authorization ? "api-key-user" : "anonymous",
        };
        nc.publish(`feedeater.control.enable.${name}`, sc.encode(JSON.stringify(payload)));
        disabledModules.delete(name);
        db?.setDisabled(name, false);
        result.succeeded.push(name);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : "NATS publish failed";
        result.failed.push({ name, reason });
      }
    }

    res.json(result);
  };
}

export function postBulkDisable({ getNatsConn, sc, disabledModules, db }: BulkControlDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as { modules?: unknown };

    if (!body || !Array.isArray(body.modules)) {
      res.status(400).json({ error: "Request body must contain a \"modules\" array" });
      return;
    }

    const modules = body.modules as unknown[];
    if (modules.length === 0) {
      res.json({ succeeded: [], failed: [] } satisfies BulkResult);
      return;
    }

    const result: BulkResult = { succeeded: [], failed: [] };

    for (const item of modules) {
      const name = typeof item === "string" ? item : String(item);

      if (!KNOWN_MODULES.has(name)) {
        result.failed.push({ name, reason: "not found" });
        continue;
      }

      if (disabledModules.has(name)) {
        result.succeeded.push(name);
        continue;
      }

      try {
        const nc = await getNatsConn();
        const payload = {
          module: name,
          action: "disable",
          timestamp: new Date().toISOString(),
          requestedBy: req.headers.authorization ? "api-key-user" : "anonymous",
        };
        nc.publish(`feedeater.control.disable.${name}`, sc.encode(JSON.stringify(payload)));
        disabledModules.add(name);
        db?.setDisabled(name, true);
        result.succeeded.push(name);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : "NATS publish failed";
        result.failed.push({ name, reason });
      }
    }

    res.json(result);
  };
}
