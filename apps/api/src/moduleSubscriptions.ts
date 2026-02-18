import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface SubEntry {
  subject: string;
  messagesReceived: number;
  lastMessageAt: number | null;
}

export class SubscriptionStore {
  private subs = new Map<string, Map<string, SubEntry>>();
  private nowFn: () => number;
  private stalenessMs: number;

  constructor(nowFn?: () => number, stalenessMs?: number) {
    this.nowFn = nowFn ?? (() => Date.now());
    this.stalenessMs = stalenessMs ?? 5 * 60 * 1000;
  }

  recordMessage(module: string, subject: string): void {
    const now = this.nowFn();
    let moduleSubs = this.subs.get(module);
    if (!moduleSubs) {
      moduleSubs = new Map();
      this.subs.set(module, moduleSubs);
    }
    let entry = moduleSubs.get(subject);
    if (!entry) {
      entry = { subject, messagesReceived: 0, lastMessageAt: null };
      moduleSubs.set(subject, entry);
    }
    entry.messagesReceived += 1;
    entry.lastMessageAt = now;
  }

  addSubscription(module: string, subject: string): void {
    let moduleSubs = this.subs.get(module);
    if (!moduleSubs) {
      moduleSubs = new Map();
      this.subs.set(module, moduleSubs);
    }
    if (!moduleSubs.has(subject)) {
      moduleSubs.set(subject, { subject, messagesReceived: 0, lastMessageAt: null });
    }
  }

  getSubscriptions(module: string): SubEntry[] {
    const moduleSubs = this.subs.get(module);
    if (!moduleSubs) return [];
    return [...moduleSubs.values()];
  }

  getStalenessMs(): number {
    return this.stalenessMs;
  }
}

interface SubscriptionsDeps {
  subscriptionStore: SubscriptionStore;
  nowFn?: () => number;
}

export function getModuleSubscriptions({ subscriptionStore, nowFn }: SubscriptionsDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const now = nowFn?.() ?? Date.now();
    const stalenessMs = subscriptionStore.getStalenessMs();
    const entries = subscriptionStore.getSubscriptions(name);

    const subscriptions = entries.map((entry) => {
      let status: "active" | "stale";
      if (!entry.lastMessageAt) {
        status = "stale";
      } else {
        status = (now - entry.lastMessageAt) > stalenessMs ? "stale" : "active";
      }

      return {
        subject: entry.subject,
        status,
        messages_received: entry.messagesReceived,
        last_message_at: entry.lastMessageAt ? new Date(entry.lastMessageAt).toISOString() : null,
      };
    });

    subscriptions.sort((a, b) => a.subject.localeCompare(b.subject));

    res.json({
      module: name,
      subscriptions,
      total: subscriptions.length,
    });
  };
}
