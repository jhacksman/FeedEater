import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface CacheEntry {
  data: unknown;
  cached_at: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  last_cleared: string | null;
}

export class ModuleCacheStore {
  private caches = new Map<string, Map<string, CacheEntry>>();
  private stats = new Map<string, { hits: number; misses: number; last_cleared: number | null }>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  put(module: string, key: string, data: unknown): void {
    let cache = this.caches.get(module);
    if (!cache) {
      cache = new Map();
      this.caches.set(module, cache);
    }
    cache.set(key, { data, cached_at: this.nowFn() });
  }

  get(module: string, key: string): unknown | undefined {
    const stat = this.ensureStats(module);
    const cache = this.caches.get(module);
    if (!cache) {
      stat.misses++;
      return undefined;
    }
    const entry = cache.get(key);
    if (!entry) {
      stat.misses++;
      return undefined;
    }
    stat.hits++;
    return entry.data;
  }

  clear(module: string): void {
    this.caches.delete(module);
    const stat = this.ensureStats(module);
    stat.last_cleared = this.nowFn();
  }

  getStats(module: string): CacheStats {
    const stat = this.ensureStats(module);
    const cache = this.caches.get(module);
    return {
      hits: stat.hits,
      misses: stat.misses,
      size: cache ? cache.size : 0,
      last_cleared: stat.last_cleared ? new Date(stat.last_cleared).toISOString() : null,
    };
  }

  private ensureStats(module: string) {
    let stat = this.stats.get(module);
    if (!stat) {
      stat = { hits: 0, misses: 0, last_cleared: null };
      this.stats.set(module, stat);
    }
    return stat;
  }
}

interface CacheDeps {
  cacheStore: ModuleCacheStore;
  nowFn?: () => number;
}

export function deleteModuleCache({ cacheStore, nowFn }: CacheDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    cacheStore.clear(name);
    const now = nowFn?.() ?? Date.now();

    res.json({
      success: true,
      module: name,
      cleared_at: new Date(now).toISOString(),
    });
  };
}

export function getModuleCacheStats({ cacheStore }: CacheDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const stats = cacheStore.getStats(name);
    const total = stats.hits + stats.misses;
    const hit_ratio = total > 0 ? stats.hits / total : 0;

    res.json({
      module: name,
      hits: stats.hits,
      misses: stats.misses,
      hit_ratio: Math.round(hit_ratio * 10000) / 10000,
      size: stats.size,
      last_cleared: stats.last_cleared,
    });
  };
}
