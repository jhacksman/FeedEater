import type { Request, Response } from "express";

type ModuleHealthEntry = {
  lastMessage: string;
  messageCount: number;
};

type ModuleStatus = "healthy" | "stale" | "offline";

const STALE_THRESHOLD_MS = 5 * 60 * 1000;
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000;

export class ModuleHealthStore {
  private entries = new Map<string, ModuleHealthEntry>();

  recordMessage(moduleName: string): void {
    const existing = this.entries.get(moduleName);
    this.entries.set(moduleName, {
      lastMessage: new Date().toISOString(),
      messageCount: (existing?.messageCount ?? 0) + 1,
    });
  }

  getStatus(moduleName: string): ModuleStatus {
    const entry = this.entries.get(moduleName);
    if (!entry) return "offline";

    const elapsed = Date.now() - new Date(entry.lastMessage).getTime();
    if (elapsed > OFFLINE_THRESHOLD_MS) return "offline";
    if (elapsed > STALE_THRESHOLD_MS) return "stale";
    return "healthy";
  }

  getAll(): Array<{ module: string; lastMessage: string | null; messageCount: number; status: ModuleStatus }> {
    const result: Array<{ module: string; lastMessage: string | null; messageCount: number; status: ModuleStatus }> = [];
    for (const [moduleName, entry] of this.entries) {
      result.push({
        module: moduleName,
        lastMessage: entry.lastMessage,
        messageCount: entry.messageCount,
        status: this.getStatus(moduleName),
      });
    }
    result.sort((a, b) => a.module.localeCompare(b.module));
    return result;
  }
}

export function getModuleHealth(store: ModuleHealthStore) {
  return async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, modules: store.getAll() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}
