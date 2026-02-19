import type { Request, Response } from "express";
import type { NatsConnection, Codec } from "nats";
import { KNOWN_MODULES } from "./moduleRestart.js";
import type { SnapshotStore } from "./moduleSnapshot.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface ReplayDeps {
  snapshotStore: SnapshotStore;
  getNatsConn: () => Promise<NatsConnection>;
  sc: Codec<string>;
  nowFn?: () => number;
}

export function postModuleReplay({ snapshotStore, getNatsConn, sc, nowFn }: ReplayDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    let limit = DEFAULT_LIMIT;
    if (req.body?.limit !== undefined) {
      const parsed = Number(req.body.limit);
      if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      if (parsed > MAX_LIMIT) {
        res.status(400).json({ error: `limit must not exceed ${MAX_LIMIT}` });
        return;
      }
      limit = parsed;
    }

    const dry_run = req.body?.dry_run !== false;

    const messages = snapshotStore.getMessages(name, limit);
    const subject = `feedeater.${name}.messageCreated`;
    const now = nowFn?.() ?? Date.now();

    if (!dry_run) {
      try {
        const nc = await getNatsConn();
        for (const msg of messages) {
          nc.publish(subject, sc.encode(JSON.stringify(msg.data)));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "NATS publish failed";
        res.status(500).json({ error: message });
        return;
      }
    }

    res.json({
      module: name,
      replayed: messages.length,
      dry_run,
      started_at: new Date(now).toISOString(),
    });
  };
}
