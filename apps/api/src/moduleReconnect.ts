import type { Request, Response } from "express";
import type { NatsConnection, Codec } from "nats";
import { KNOWN_MODULES } from "./moduleRestart.js";

type ConnectionState = "connected" | "disconnected" | "reconnecting" | "unknown";

export class ReconnectTracker {
  private states = new Map<string, ConnectionState>();
  private pending = new Set<string>();

  getState(module: string): ConnectionState {
    return this.states.get(module) ?? "unknown";
  }

  setState(module: string, state: ConnectionState): void {
    this.states.set(module, state);
    if (state !== "reconnecting") {
      this.pending.delete(module);
    }
  }

  isReconnecting(module: string): boolean {
    return this.pending.has(module);
  }

  markReconnecting(module: string): void {
    this.pending.add(module);
    this.states.set(module, "reconnecting");
  }

  clearReconnecting(module: string): void {
    this.pending.delete(module);
  }

  clear(): void {
    this.states.clear();
    this.pending.clear();
  }
}

interface ReconnectDeps {
  getNatsConn: () => Promise<NatsConnection>;
  sc: Codec<string>;
  tracker: ReconnectTracker;
  nowFn?: () => number;
}

export function postModuleReconnect({ getNatsConn, sc, tracker, nowFn }: ReconnectDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    if (tracker.isReconnecting(name)) {
      res.status(409).json({ error: `Module ${name} is already reconnecting` });
      return;
    }

    const previousState = tracker.getState(name);
    const now = nowFn?.() ?? Date.now();

    const payload = {
      module: name,
      action: "reconnect",
      timestamp: new Date(now).toISOString(),
      requestedBy: req.headers.authorization ? "api-key-user" : "anonymous",
    };

    try {
      const nc = await getNatsConn();
      nc.publish(
        `feedeater.control.reconnect.${name}`,
        sc.encode(JSON.stringify(payload)),
      );

      tracker.markReconnecting(name);

      res.json({
        module: name,
        reconnect_triggered: true,
        previous_state: previousState,
        triggered_at: new Date(now).toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "NATS publish failed";
      res.status(500).json({ error: message });
    }
  };
}
