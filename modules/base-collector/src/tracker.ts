import type { DroppedPool } from "./types.js";

export type TrackedPool = { poolId: string; hooks: string; suite: string | null; initBlock: number; lastBlock: number };

const RECENT_DROPPED = 50;
const EVICTED_MEMORY = 100_000;

/**
 * Pools whose Swaps are published: Initialize with an o1 hook (or a configured extra hook), plus
 * configured pool ids. Bounded by `maxTracked` (least recently active evicted first) and optional
 * idle eviction. Every eviction is counted and exposed; coverage is complete only if none happened.
 */
export class PoolTracker {
  private readonly pools = new Map<string, TrackedPool>();
  private readonly evicted = new Set<string>();
  private readonly recent: DroppedPool[] = [];
  droppedTotal = 0;
  swapsForDropped = 0;

  constructor(
    private readonly hookSuites: ReadonlyMap<string, string | null>,
    private readonly extraPoolIds: ReadonlySet<string>,
    private readonly maxTracked: number,
    private readonly idleBlocks: number,
  ) {
    if (maxTracked < 1) throw new Error("maxTrackedPools must be >= 1");
  }

  get size(): number {
    return this.pools.size;
  }

  get recentDropped(): DroppedPool[] {
    return [...this.recent];
  }

  wants(hooks: string, poolId: string): boolean {
    return this.hookSuites.has(hooks) || this.extraPoolIds.has(poolId);
  }

  has(poolId: string): boolean {
    return this.pools.has(poolId) || this.extraPoolIds.has(poolId);
  }

  suiteOf(poolId: string): string | null {
    return this.pools.get(poolId)?.suite ?? null;
  }

  /** Track a pool from its Initialize. Returns false if the pool does not match the filter. */
  add(poolId: string, hooks: string, blockNumber: number): boolean {
    if (!this.wants(hooks, poolId)) return false;
    const existing = this.pools.get(poolId);
    if (existing !== undefined) return true;
    while (this.pools.size >= this.maxTracked) {
      const lru = this.pools.keys().next();
      if (lru.done) break;
      this.drop(lru.value, "max_tracked", blockNumber);
    }
    this.pools.set(poolId, { poolId, hooks, suite: this.hookSuites.get(hooks) ?? null, initBlock: blockNumber, lastBlock: blockNumber });
    this.evicted.delete(poolId);
    return true;
  }

  touch(poolId: string, blockNumber: number): void {
    const p = this.pools.get(poolId);
    if (p === undefined) return;
    if (blockNumber > p.lastBlock) p.lastBlock = blockNumber;
    this.pools.delete(poolId);
    this.pools.set(poolId, p);
  }

  /** Called for a Swap of an untracked pool; counts it if the pool was evicted. */
  noteUntracked(poolId: string): boolean {
    if (!this.evicted.has(poolId)) return false;
    this.swapsForDropped += 1;
    return true;
  }

  evictIdle(headBlock: number): void {
    if (this.idleBlocks <= 0) return;
    const threshold = headBlock - this.idleBlocks;
    for (const p of [...this.pools.values()]) {
      if (p.lastBlock < threshold) this.drop(p.poolId, "idle", headBlock);
    }
  }

  snapshot(): TrackedPool[] {
    return [...this.pools.values()].map((p) => ({ ...p }));
  }

  restore(pools: readonly TrackedPool[]): void {
    const sorted = [...pools].sort((a, b) => a.lastBlock - b.lastBlock);
    for (const p of sorted) {
      if (!this.wants(p.hooks, p.poolId)) continue;
      this.add(p.poolId, p.hooks, p.initBlock);
      this.touch(p.poolId, p.lastBlock);
    }
  }

  private drop(poolId: string, reason: DroppedPool["reason"], atBlock: number): void {
    this.pools.delete(poolId);
    this.droppedTotal += 1;
    if (this.evicted.size >= EVICTED_MEMORY) {
      const first = this.evicted.values().next();
      if (!first.done) this.evicted.delete(first.value);
    }
    this.evicted.add(poolId);
    this.recent.push({ poolId, reason, atBlock });
    if (this.recent.length > RECENT_DROPPED) this.recent.shift();
  }
}
