import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";
import { signPayload } from "./webhooks.js";
import type { Webhook } from "./webhooks.js";

interface TestAlertDeps {
  webhooks: Webhook[];
  fetchFn?: typeof fetch;
}

interface DeliveryResult {
  webhook_id: string;
  status: "delivered" | "failed";
  httpStatus?: number;
  error?: string;
}

export function postTestAlert({ webhooks, fetchFn = fetch }: TestAlertDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({
        error: `Unknown module: ${name}. Valid modules: ${[...KNOWN_MODULES].join(", ")}`,
      });
      return;
    }

    const matching = webhooks.filter((w) => w.module === name);

    if (matching.length === 0) {
      res.json({ delivered: 0, failed: 0, webhook_ids: [] });
      return;
    }

    const timestamp = new Date().toISOString();
    const testPayload = {
      module: name,
      data: {
        type: "test-alert",
        message: `Test alert for module ${name}`,
        triggered_at: timestamp,
      },
      timestamp,
    };
    const body = JSON.stringify(testPayload);

    const results: DeliveryResult[] = [];

    const promises = matching.map(async (w) => {
      const signature = signPayload(body, w.secret);
      try {
        const resp = await fetchFn(w.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-FeedEater-Signature": signature,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (resp.ok) {
          results.push({ webhook_id: w.id, status: "delivered", httpStatus: resp.status });
        } else {
          results.push({ webhook_id: w.id, status: "failed", httpStatus: resp.status, error: `HTTP ${resp.status}` });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "fetch failed";
        results.push({ webhook_id: w.id, status: "failed", error: message });
      }
    });

    await Promise.allSettled(promises);

    const delivered = results.filter((r) => r.status === "delivered").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const webhook_ids = results.map((r) => r.webhook_id);

    res.json({ delivered, failed, webhook_ids, results });
  };
}
