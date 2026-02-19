import type { Request, Response } from "express";
import type { NatsConnection, Codec } from "nats";
import { KNOWN_MODULES } from "./moduleRestart.js";

const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 120;

export type DrainExecutor = (module: string, timeoutMs: number) => Promise<{ messages_flushed: number }>;

interface DrainDeps {
  getNatsConn: () => Promise<NatsConnection>;
  sc: Codec<string>;
  drainFn?: DrainExecutor;
  nowFn?: () => number;
}

export function postModuleDrain({ getNatsConn, sc, drainFn, nowFn }: DrainDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    let timeoutSeconds = DEFAULT_TIMEOUT;
    const body = req.body as Record<string, unknown> | undefined;
    if (body && body.timeout_seconds !== undefined) {
      const parsed = Number(body.timeout_seconds);
      if (!Number.isFinite(parsed) || parsed < 1) {
        res.status(400).json({ error: "timeout_seconds must be a positive number" });
        return;
      }
      timeoutSeconds = Math.min(Math.floor(parsed), MAX_TIMEOUT);
    }

    const now = nowFn ?? (() => Date.now());
    const start = now();

    try {
      let result: { messages_flushed: number };
      if (drainFn) {
        result = await drainFn(name, timeoutSeconds * 1000);
      } else {
        const nc = await getNatsConn();
        const subject = `feedeater.control.drain.${name}`;
        const payload = { module: name, timeout_ms: timeoutSeconds * 1000, timestamp: new Date(start).toISOString() };
        nc.publish(subject, sc.encode(JSON.stringify(payload)));
        result = { messages_flushed: 0 };
      }

      const end = now();

      res.json({
        module: name,
        drained: true,
        messages_flushed: result.messages_flushed,
        duration_ms: end - start,
        drained_at: new Date(end).toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Drain failed";
      res.status(500).json({ error: message });
    }
  };
}
