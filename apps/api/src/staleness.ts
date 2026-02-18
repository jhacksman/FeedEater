import type { Request, Response } from "express";

const DEFAULT_THRESHOLD_SECONDS = 60;

function getThresholdMs(): number {
  const env = process.env.STALENESS_THRESHOLD_SECONDS;
  const seconds = env ? Number(env) : DEFAULT_THRESHOLD_SECONDS;
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_THRESHOLD_SECONDS) * 1000;
}

interface ModuleStaleness {
  module: string;
  lastSeenMs: number;
  ageSeconds: number;
  stale: boolean;
}

export class StalenessTracker {
  private lastSeen = new Map<string, number>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  updateModuleSeen(module: string): void {
    this.lastSeen.set(module, this.nowFn());
  }

  getStalenessSummary(): ModuleStaleness[] {
    const now = this.nowFn();
    const thresholdMs = getThresholdMs();
    const result: ModuleStaleness[] = [];
    for (const [module, lastSeenMs] of this.lastSeen) {
      const ageMs = now - lastSeenMs;
      result.push({
        module,
        lastSeenMs,
        ageSeconds: Math.floor(ageMs / 1000),
        stale: ageMs > thresholdMs,
      });
    }
    result.sort((a, b) => a.module.localeCompare(b.module));
    return result;
  }
}

interface StalenessDeps {
  tracker: StalenessTracker;
}

export function getStaleness({ tracker }: StalenessDeps) {
  return (_req: Request, res: Response): void => {
    res.json(tracker.getStalenessSummary());
  };
}
