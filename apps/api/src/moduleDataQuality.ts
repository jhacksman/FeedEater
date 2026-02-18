import type { Request, Response } from "express";
import { KNOWN_MODULES } from "./moduleRestart.js";

function gradeFromScore(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export class ModuleDataQualityStore {
  private messages = new Map<string, number[]>();
  private duplicates = new Map<string, number>();
  private malformed = new Map<string, number>();
  private totals = new Map<string, number>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  recordMessage(module: string): void {
    const now = this.nowFn();
    const times = this.messages.get(module) ?? [];
    times.push(now);
    if (times.length > 1000) times.shift();
    this.messages.set(module, times);
    this.totals.set(module, (this.totals.get(module) ?? 0) + 1);
  }

  recordDuplicate(module: string): void {
    this.duplicates.set(module, (this.duplicates.get(module) ?? 0) + 1);
  }

  recordMalformed(module: string): void {
    this.malformed.set(module, (this.malformed.get(module) ?? 0) + 1);
  }

  getMessageTimes(module: string): number[] {
    return this.messages.get(module) ?? [];
  }

  getDuplicateCount(module: string): number {
    return this.duplicates.get(module) ?? 0;
  }

  getMalformedCount(module: string): number {
    return this.malformed.get(module) ?? 0;
  }

  getTotalCount(module: string): number {
    return this.totals.get(module) ?? 0;
  }
}

interface ModuleDataQualityDeps {
  qualityStore: ModuleDataQualityStore;
  nowFn?: () => number;
}

export function getModuleDataQuality({ qualityStore, nowFn }: ModuleDataQualityDeps) {
  return (req: Request, res: Response): void => {
    const name = req.params.name;

    if (!name || !KNOWN_MODULES.has(name)) {
      res.status(404).json({ error: `Unknown module: ${name}` });
      return;
    }

    const now = nowFn?.() ?? Date.now();
    const windowMs = 60_000;
    const cutoff = now - windowMs;

    const allTimes = qualityStore.getMessageTimes(name);
    const recentTimes = allTimes.filter((t) => t >= cutoff);
    const messageRate = +(recentTimes.length / 60).toFixed(2);

    let gapSeconds: number | null = null;
    if (allTimes.length > 0) {
      const lastTime = allTimes[allTimes.length - 1];
      gapSeconds = +((now - lastTime) / 1000).toFixed(1);
    }

    const total = qualityStore.getTotalCount(name);
    const dupes = qualityStore.getDuplicateCount(name);
    const malformed = qualityStore.getMalformedCount(name);

    const duplicateRate = total > 0 ? +(dupes / total).toFixed(4) : 0;
    const malformedRate = total > 0 ? +(malformed / total).toFixed(4) : 0;

    let score = 100;

    if (gapSeconds !== null && gapSeconds > 60) {
      const penalty = Math.min(40, Math.round((gapSeconds - 60) / 10) * 5);
      score -= penalty;
    } else if (gapSeconds === null) {
      score -= 40;
    }

    score -= Math.min(30, Math.round(duplicateRate * 100) * 3);
    score -= Math.min(30, Math.round(malformedRate * 100) * 3);

    score = Math.max(0, Math.min(100, score));

    res.json({
      module: name,
      message_rate: messageRate,
      gap_seconds: gapSeconds,
      duplicate_rate: duplicateRate,
      malformed_rate: malformedRate,
      quality_score: score,
      grade: gradeFromScore(score),
      timestamp: new Date(now).toISOString(),
    });
  };
}
