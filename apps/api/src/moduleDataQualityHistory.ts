import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface HourBucket {
  messageCount: number;
  errorCount: number;
  timestamps: number[];
}

export class DataQualityHistoryStore {
  private buckets = new Map<string, Map<number, HourBucket>>();
  private nowFn: () => number;
  private gapThresholdMs: number;

  constructor(nowFn?: () => number, gapThresholdMs?: number) {
    this.nowFn = nowFn ?? (() => Date.now());
    this.gapThresholdMs = gapThresholdMs ?? 5 * 60 * 1000;
  }

  private hourKey(ts: number): number {
    return Math.floor(ts / 3_600_000) * 3_600_000;
  }

  private getBucket(module: string, hour: number): HourBucket {
    let moduleBuckets = this.buckets.get(module);
    if (!moduleBuckets) {
      moduleBuckets = new Map();
      this.buckets.set(module, moduleBuckets);
    }
    let bucket = moduleBuckets.get(hour);
    if (!bucket) {
      bucket = { messageCount: 0, errorCount: 0, timestamps: [] };
      moduleBuckets.set(hour, bucket);
    }
    return bucket;
  }

  recordMessage(module: string): void {
    const now = this.nowFn();
    const hour = this.hourKey(now);
    const bucket = this.getBucket(module, hour);
    bucket.messageCount += 1;
    bucket.timestamps.push(now);
    if (bucket.timestamps.length > 10000) bucket.timestamps.shift();
  }

  recordError(module: string): void {
    const now = this.nowFn();
    const hour = this.hourKey(now);
    const bucket = this.getBucket(module, hour);
    bucket.errorCount += 1;
  }

  getHistory(module: string, now: number): { hour: number; bucket: HourBucket }[] {
    const cutoff = now - 24 * 3_600_000;
    const moduleBuckets = this.buckets.get(module);
    if (!moduleBuckets) return [];
    const results: { hour: number; bucket: HourBucket }[] = [];
    for (const [hour, bucket] of moduleBuckets) {
      if (hour >= cutoff) results.push({ hour, bucket });
    }
    results.sort((a, b) => a.hour - b.hour);
    return results;
  }

  getGapThresholdMs(): number {
    return this.gapThresholdMs;
  }
}

function hasGap(timestamps: number[], gapMs: number): boolean {
  if (timestamps.length < 2) return false;
  const sorted = [...timestamps].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gapMs) return true;
  }
  return false;
}

function computeScore(messageCount: number, errorCount: number, gapDetected: boolean): number {
  let score = 100;
  if (messageCount === 0) {
    score -= 50;
  }
  if (errorCount > 0) {
    const penalty = Math.min(30, errorCount * 5);
    score -= penalty;
  }
  if (gapDetected) {
    score -= 20;
  }
  return Math.max(0, Math.min(100, score));
}

interface DataQualityHistoryDeps {
  historyStore: DataQualityHistoryStore;
  nowFn?: () => number;
}

export function getModuleDataQualityHistory({ historyStore, nowFn }: DataQualityHistoryDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const now = nowFn?.() ?? Date.now();
    const gapMs = historyStore.getGapThresholdMs();
    const entries = historyStore.getHistory(name, now);

    const history = entries.map(({ hour, bucket }) => {
      const gapDetected = hasGap(bucket.timestamps, gapMs);
      const qualityScore = computeScore(bucket.messageCount, bucket.errorCount, gapDetected);
      return {
        timestamp: new Date(hour).toISOString(),
        quality_score: qualityScore,
        message_count: bucket.messageCount,
        error_count: bucket.errorCount,
        gap_detected: gapDetected,
      };
    });

    const scores = history.map((h) => h.quality_score);
    const avgScore = scores.length > 0 ? +((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : 0;
    const minScore = scores.length > 0 ? Math.min(...scores) : 0;

    res.json({
      module: name,
      history,
      avg_score_24h: avgScore,
      min_score_24h: minScore,
    });
  };
}
