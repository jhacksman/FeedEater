import { randomUUID, createHmac } from "node:crypto";
import type { Request, Response } from "express";
import Database from "better-sqlite3";
import { KNOWN_MODULES } from "./moduleRestart.js";

export interface Webhook {
  id: string;
  url: string;
  module: string;
  secret: string;
  createdAt: string;
}

export interface DeliveryEntry {
  timestamp: string;
  status: "success" | "failure";
  httpStatus?: number;
  error?: string;
}

export interface WebhookDeps {
  webhooks: Webhook[];
  db?: WebhookDb;
  deliveryLog?: DeliveryLog;
}

export function postWebhook({ webhooks, db }: WebhookDeps) {
  return (req: Request, res: Response): void => {
    const { url, module, secret } = req.body as {
      url?: string;
      module?: string;
      secret?: string;
    };

    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "url is required" });
      return;
    }

    if (!module || typeof module !== "string") {
      res.status(400).json({ error: "module is required" });
      return;
    }

    if (!secret || typeof secret !== "string") {
      res.status(400).json({ error: "secret is required" });
      return;
    }

    if (!KNOWN_MODULES.has(module)) {
      res.status(400).json({
        error: `Unknown module: ${module}. Valid modules: ${[...KNOWN_MODULES].join(", ")}`,
      });
      return;
    }

    const webhook: Webhook = {
      id: randomUUID(),
      url,
      module,
      secret,
      createdAt: new Date().toISOString(),
    };

    webhooks.push(webhook);
    db?.insert(webhook);

    res.status(201).json({
      id: webhook.id,
      url: webhook.url,
      module: webhook.module,
      createdAt: webhook.createdAt,
    });
  };
}

export function listWebhooks({ webhooks }: WebhookDeps) {
  return (_req: Request, res: Response): void => {
    const safe = webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      module: w.module,
      createdAt: w.createdAt,
    }));
    res.json(safe);
  };
}

export function deleteWebhook({ webhooks, db }: WebhookDeps) {
  return (req: Request, res: Response): void => {
    const { id } = req.params;
    const idx = webhooks.findIndex((w) => w.id === id);

    if (idx === -1) {
      res.status(404).json({ error: `Webhook ${id} not found` });
      return;
    }

    webhooks.splice(idx, 1);
    db?.remove(id);
    res.json({ ok: true, message: `Webhook ${id} deleted` });
  };
}

export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

export async function deliverWebhooks(
  webhooks: Webhook[],
  module: string,
  data: unknown,
  deliveryLog?: DeliveryLog,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const matching = webhooks.filter((w) => w.module === module);
  if (matching.length === 0) return;

  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({ module, data, timestamp });

  const promises = matching.map(async (w) => {
    const signature = signPayload(payload, w.secret);
    let lastError: string | undefined;
    let lastHttpStatus: number | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(w.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-FeedEater-Signature": signature,
          },
          body: payload,
          signal: AbortSignal.timeout(10_000),
        });

        if (resp.ok) {
          deliveryLog?.record(w.id, { timestamp: new Date().toISOString(), status: "success", httpStatus: resp.status });
          return;
        }

        lastHttpStatus = resp.status;
        lastError = `HTTP ${resp.status}`;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : "fetch failed";
        lastHttpStatus = undefined;
      }

      if (attempt < MAX_RETRIES - 1) {
        await sleepFn(BACKOFF_MS[attempt]);
      }
    }

    deliveryLog?.record(w.id, {
      timestamp: new Date().toISOString(),
      status: "failure",
      httpStatus: lastHttpStatus,
      error: lastError,
    });
    console.error(`[webhooks] delivery failed after ${MAX_RETRIES} attempts: webhook=${w.id} module=${module} error=${lastError}`);
  });

  await Promise.allSettled(promises);
}

export class DeliveryLog {
  private entries = new Map<string, DeliveryEntry[]>();

  record(webhookId: string, entry: DeliveryEntry): void {
    let list = this.entries.get(webhookId);
    if (!list) {
      list = [];
      this.entries.set(webhookId, list);
    }
    list.push(entry);
    if (list.length > 20) list.shift();
  }

  get(webhookId: string): DeliveryEntry[] {
    return this.entries.get(webhookId) ?? [];
  }
}

export function getDeliveries({ webhooks, deliveryLog }: WebhookDeps) {
  return (req: Request, res: Response): void => {
    const { id } = req.params;
    const exists = webhooks.some((w) => w.id === id);
    if (!exists) {
      res.status(404).json({ error: `Webhook ${id} not found` });
      return;
    }
    res.json(deliveryLog?.get(id) ?? []);
  };
}

export class WebhookDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        module TEXT NOT NULL,
        secret TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
  }

  loadAll(): Webhook[] {
    const rows = this.db.prepare("SELECT id, url, module, secret, created_at FROM webhooks").all() as Array<{
      id: string;
      url: string;
      module: string;
      secret: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      module: r.module,
      secret: r.secret,
      createdAt: r.created_at,
    }));
  }

  insert(w: Webhook): void {
    this.db.prepare("INSERT INTO webhooks (id, url, module, secret, created_at) VALUES (?, ?, ?, ?, ?)").run(
      w.id, w.url, w.module, w.secret, w.createdAt,
    );
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
