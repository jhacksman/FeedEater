import { randomUUID, createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

export interface Webhook {
  id: string;
  url: string;
  module: string;
  secret: string;
  createdAt: string;
}

export interface WebhookDeps {
  webhooks: Webhook[];
}

export function postWebhook({ webhooks }: WebhookDeps) {
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

export function deleteWebhook({ webhooks }: WebhookDeps) {
  return (req: Request, res: Response): void => {
    const { id } = req.params;
    const idx = webhooks.findIndex((w) => w.id === id);

    if (idx === -1) {
      res.status(404).json({ error: `Webhook ${id} not found` });
      return;
    }

    webhooks.splice(idx, 1);
    res.json({ ok: true, message: `Webhook ${id} deleted` });
  };
}

export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function deliverWebhooks(
  webhooks: Webhook[],
  module: string,
  data: unknown,
): Promise<void> {
  const matching = webhooks.filter((w) => w.module === module);
  if (matching.length === 0) return;

  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({ module, data, timestamp });

  const promises = matching.map(async (w) => {
    const signature = signPayload(payload, w.secret);
    try {
      await fetch(w.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FeedEater-Signature": signature,
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // fire-and-forget: log but don't throw
    }
  });

  await Promise.allSettled(promises);
}
