import type { Request, Response } from "express";
import type { NatsConnection, Codec } from "nats";
import Database from "better-sqlite3";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface ControlDeps {
  getNatsConn: () => Promise<NatsConnection>;
  sc: Codec<string>;
  disabledModules: Set<string>;
  db?: ModuleConfigDb;
}

export function postModuleDisable({ getNatsConn, sc, disabledModules, db }: ControlDeps) {
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
      db?.setDisabled(name, true);
      res.json({ ok: true, module: name, message: `Module ${name} disabled` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "NATS publish failed";
      res.status(500).json({ error: message });
    }
  };
}

export function postModuleEnable({ getNatsConn, sc, disabledModules, db }: ControlDeps) {
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
      db?.setDisabled(name, false);
      res.json({ ok: true, module: name, message: `Module ${name} enabled` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "NATS publish failed";
      res.status(500).json({ error: message });
    }
  };
}

export class ModuleConfigDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS module_config (
        module TEXT PRIMARY KEY,
        disabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
    );
  }

  loadDisabled(): string[] {
    const rows = this.db.prepare("SELECT module FROM module_config WHERE disabled = 1").all() as Array<{ module: string }>;
    return rows.map((r) => r.module);
  }

  setDisabled(module: string, disabled: boolean): void {
    this.db.prepare(
      "INSERT INTO module_config (module, disabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(module) DO UPDATE SET disabled = excluded.disabled, updated_at = excluded.updated_at",
    ).run(module, disabled ? 1 : 0, new Date().toISOString());
  }

  getConfig(module: string): { module: string; disabled: boolean; updatedAt: string } | null {
    const row = this.db.prepare("SELECT module, disabled, updated_at FROM module_config WHERE module = ?").get(module) as { module: string; disabled: number; updated_at: string } | undefined;
    if (!row) return null;
    return { module: row.module, disabled: row.disabled === 1, updatedAt: row.updated_at };
  }

  close(): void {
    this.db.close();
  }
}

interface ConfigDeps {
  disabledModules: Set<string>;
  db?: ModuleConfigDb;
}

export function getModuleConfig({ disabledModules, db }: ConfigDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const persisted = db?.getConfig(name);
    res.json({
      module: name,
      disabled: disabledModules.has(name),
      updatedAt: persisted?.updatedAt ?? null,
    });
  };
}
