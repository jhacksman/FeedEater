import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface ReconnectEntry {
  count: number;
  lastReconnectMs: number;
}

const store = new Map<string, ReconnectEntry>();

export function recordReconnect(module: string): void {
  const existing = store.get(module);
  if (existing) {
    existing.count += 1;
    existing.lastReconnectMs = Date.now();
  } else {
    store.set(module, { count: 1, lastReconnectMs: Date.now() });
  }
}

export function getReconnectSummary(): Array<{ module: string; count: number; lastReconnectMs: number }> {
  const result: Array<{ module: string; count: number; lastReconnectMs: number }> = [];
  for (const [module, entry] of store) {
    result.push({ module, count: entry.count, lastReconnectMs: entry.lastReconnectMs });
  }
  return result;
}

export function getModuleReconnects(module: string): { module: string; count: number; lastReconnectMs: number } | null {
  const entry = store.get(module);
  if (!entry) return null;
  return { module, count: entry.count, lastReconnectMs: entry.lastReconnectMs };
}

export function resetStore(): void {
  store.clear();
}

export function getModuleReconnectsHandler() {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const entry = getModuleReconnects(name);
    res.json(entry ?? { module: name, count: 0, lastReconnectMs: 0 });
  };
}

export function getReconnectSummaryHandler() {
  return (_req: Request, res: Response): void => {
    res.json(getReconnectSummary());
  };
}
