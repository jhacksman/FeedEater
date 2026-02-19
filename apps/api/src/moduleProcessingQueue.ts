import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface QueueEntry {
  timestamp: number;
  count: number;
}

export class ProcessingQueueStore {
  private queues = new Map<string, QueueEntry[]>();
  private dropped = new Map<string, number>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  enqueue(module: string, count: number): void {
    let entries = this.queues.get(module);
    if (!entries) {
      entries = [];
      this.queues.set(module, entries);
    }
    entries.push({ timestamp: this.nowFn(), count });
    if (entries.length > 100_000) {
      entries.splice(0, entries.length - 100_000);
    }
  }

  dequeue(module: string, count: number): void {
    const entries = this.queues.get(module);
    if (!entries || entries.length === 0) return;
    let remaining = count;
    while (remaining > 0 && entries.length > 0) {
      const front = entries[0]!;
      if (front.count <= remaining) {
        remaining -= front.count;
        entries.shift();
      } else {
        front.count -= remaining;
        remaining = 0;
      }
    }
  }

  recordDropped(module: string, count: number): void {
    this.dropped.set(module, (this.dropped.get(module) ?? 0) + count);
  }

  getDepth(module: string): number {
    const entries = this.queues.get(module);
    if (!entries) return 0;
    let total = 0;
    for (const e of entries) total += e.count;
    return total;
  }

  getOldestTimestamp(module: string): number | null {
    const entries = this.queues.get(module);
    if (!entries || entries.length === 0) return null;
    return entries[0]!.timestamp;
  }

  getProcessingRate(module: string, windowMs: number): number {
    const entries = this.queues.get(module);
    if (!entries || entries.length === 0) return 0;
    const now = this.nowFn();
    const cutoff = now - windowMs;
    let count = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.timestamp >= cutoff) {
        count += entries[i]!.count;
      } else {
        break;
      }
    }
    const windowSec = windowMs / 1000;
    return windowSec > 0 ? Math.round((count / windowSec) * 100) / 100 : 0;
  }

  getDroppedCount(module: string): number {
    return this.dropped.get(module) ?? 0;
  }
}

interface ProcessingQueueDeps {
  queueStore: ProcessingQueueStore;
  nowFn?: () => number;
}

export function getModuleProcessingQueue({ queueStore, nowFn }: ProcessingQueueDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const now = nowFn?.() ?? Date.now();
    const depth = queueStore.getDepth(name);

    if (depth === 0) {
      res.json({
        module: name,
        queue_depth: 0,
        oldest_queued_at: null,
        lag_seconds: 0,
        processing_rate_per_sec: 0,
        dropped_messages_count: queueStore.getDroppedCount(name),
      });
      return;
    }

    const oldest = queueStore.getOldestTimestamp(name);
    const lagSeconds = oldest !== null ? Math.round((now - oldest) / 1000) : 0;

    res.json({
      module: name,
      queue_depth: depth,
      oldest_queued_at: oldest !== null ? new Date(oldest).toISOString() : null,
      lag_seconds: lagSeconds,
      processing_rate_per_sec: queueStore.getProcessingRate(name, 60_000),
      dropped_messages_count: queueStore.getDroppedCount(name),
    });
  };
}
