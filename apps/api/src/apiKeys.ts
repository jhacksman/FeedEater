import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";

export class ApiKeyDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      )`,
    );
  }

  createKey(label: string): { id: string; key: string; label: string; createdAt: string } {
    const id = randomUUID();
    const key = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO api_keys (id, key, label, created_at, revoked) VALUES (?, ?, ?, ?, 0)",
    ).run(id, key, label, createdAt);
    return { id, key, label, createdAt };
  }

  listKeys(): Array<{ id: string; label: string; createdAt: string; lastUsedAt: string | null }> {
    const rows = this.db
      .prepare("SELECT id, label, created_at, last_used_at FROM api_keys WHERE revoked = 0")
      .all() as Array<{ id: string; label: string; created_at: string; last_used_at: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  revokeKey(id: string): boolean {
    const result = this.db
      .prepare("UPDATE api_keys SET revoked = 1 WHERE id = ? AND revoked = 0")
      .run(id);
    return result.changes > 0;
  }

  isValidKey(key: string): boolean {
    return this.validateAndGetId(key) !== null;
  }

  validateAndGetId(key: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM api_keys WHERE key = ? AND revoked = 0")
      .get(key) as { id: string } | undefined;
    if (row) {
      this.db
        .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
      return row.id;
    }
    return null;
  }

  close(): void {
    this.db.close();
  }
}

export function masterKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const masterKey = process.env.MASTER_API_KEY;
  if (!masterKey) {
    res.status(503).json({ error: "Master API key not configured" });
    return;
  }

  const provided = req.headers["x-master-key"];
  if (!provided || provided !== masterKey) {
    res.status(401).json({ error: "Invalid or missing master API key" });
    return;
  }

  next();
}

interface KeysDeps {
  db: ApiKeyDb;
}

export function postApiKey({ db }: KeysDeps) {
  return (req: Request, res: Response): void => {
    const { label } = req.body as { label?: string };

    if (!label || typeof label !== "string" || label.trim().length === 0) {
      res.status(400).json({ error: "label is required" });
      return;
    }

    const result = db.createKey(label.trim());
    res.status(201).json(result);
  };
}

export function listApiKeys({ db }: KeysDeps) {
  return (_req: Request, res: Response): void => {
    res.json(db.listKeys());
  };
}

export function deleteApiKey({ db }: KeysDeps) {
  return (req: Request, res: Response): void => {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const revoked = db.revokeKey(id);
    if (!revoked) {
      res.status(404).json({ error: `API key ${id} not found or already revoked` });
      return;
    }

    res.json({ revoked: true });
  };
}
