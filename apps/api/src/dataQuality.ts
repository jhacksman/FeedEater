import type { Request, Response } from "express";
import type { StalenessTracker } from "./staleness.js";
import { getReconnectSummary } from "./reconnects.js";
import { KNOWN_MODULES } from "./moduleRestart.js";

interface ModuleQuality {
  name: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  freshness_score: number;
  error_score: number;
  rate_score: number;
  details: {
    ageSeconds: number | null;
    stale: boolean;
    reconnects: number;
    expectedIntervalSeconds: number;
  };
}

const EXPECTED_INTERVAL_SECONDS = 60;
const EXPECTED_MSGS_PER_MIN = 10;

function gradeFromScore(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function computeFreshnessScore(ageSeconds: number | null, expectedInterval: number): number {
  if (ageSeconds === null) return 0;
  if (ageSeconds <= expectedInterval) return 100;
  const ratio = expectedInterval / ageSeconds;
  return Math.max(0, Math.round(ratio * 100));
}

function computeErrorScore(reconnects: number): number {
  if (reconnects === 0) return 100;
  if (reconnects <= 2) return 80;
  if (reconnects <= 5) return 60;
  if (reconnects <= 10) return 30;
  return 0;
}

function computeRateScore(ageSeconds: number | null, hasSeen: boolean): number {
  if (!hasSeen) return 0;
  if (ageSeconds === null) return 0;
  if (ageSeconds <= EXPECTED_INTERVAL_SECONDS) return 100;
  const ratio = EXPECTED_INTERVAL_SECONDS / ageSeconds;
  const score = Math.round(ratio * 100);
  return Math.max(0, Math.min(100, score));
}

interface DataQualityDeps {
  stalenessTracker: StalenessTracker;
  disabledModules: Set<string>;
  nowFn?: () => number;
}

export function getDataQuality(deps: DataQualityDeps) {
  return (_req: Request, res: Response): void => {
    const staleness = deps.stalenessTracker.getStalenessSummary();
    const stalenessMap = new Map(staleness.map((s) => [s.module, s]));

    const reconnects = getReconnectSummary();
    const reconnectMap = new Map(reconnects.map((r) => [r.module, r]));

    const modules: ModuleQuality[] = [];

    for (const name of KNOWN_MODULES) {
      if (deps.disabledModules.has(name)) {
        modules.push({
          name,
          score: 0,
          grade: "F",
          freshness_score: 0,
          error_score: 0,
          rate_score: 0,
          details: {
            ageSeconds: null,
            stale: false,
            reconnects: 0,
            expectedIntervalSeconds: EXPECTED_INTERVAL_SECONDS,
          },
        });
        continue;
      }

      const s = stalenessMap.get(name);
      const r = reconnectMap.get(name);
      const ageSeconds = s ? s.ageSeconds : null;
      const hasSeen = !!s;
      const reconnectCount = r?.count ?? 0;

      const freshness_score = computeFreshnessScore(ageSeconds, EXPECTED_INTERVAL_SECONDS);
      const error_score = computeErrorScore(reconnectCount);
      const rate_score = computeRateScore(ageSeconds, hasSeen);

      const score = Math.round(freshness_score * 0.4 + error_score * 0.3 + rate_score * 0.3);

      modules.push({
        name,
        score,
        grade: gradeFromScore(score),
        freshness_score,
        error_score,
        rate_score,
        details: {
          ageSeconds,
          stale: s?.stale ?? false,
          reconnects: reconnectCount,
          expectedIntervalSeconds: EXPECTED_INTERVAL_SECONDS,
        },
      });
    }

    modules.sort((a, b) => a.name.localeCompare(b.name));

    const total = modules.reduce((sum, m) => sum + m.score, 0);
    const systemScore = modules.length > 0 ? Math.round(total / modules.length) : 0;

    res.json({
      systemScore,
      systemGrade: gradeFromScore(systemScore),
      modules,
      generatedAt: new Date().toISOString(),
    });
  };
}
