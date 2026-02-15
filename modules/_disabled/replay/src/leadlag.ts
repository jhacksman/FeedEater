import type { DbLike } from "@feedeater/module-sdk";

import {
  loadKalshiSnapshots,
  loadPolymarketSnapshots,
  loadEventMappings,
  type ModuleMarketSnapshot,
  type EventMappingRow,
} from "./loader.js";

export type LeadLagPair = {
  mappingId: string;
  venueA: string;
  tickerA: string;
  titleA: string;
  venueB: string;
  tickerB: string;
  titleB: string;
  underlyingAsset: string | null;
  eventType: string;
  deltas: number[];
};

export type LeadLagStats = {
  mappingId: string;
  venueA: string;
  tickerA: string;
  venueB: string;
  tickerB: string;
  underlyingAsset: string | null;
  eventType: string;
  n: number;
  medianDeltaMs: number;
  p25DeltaMs: number;
  p75DeltaMs: number;
  meanDeltaMs: number;
  stdDevMs: number;
  leader: string;
  leadMs: number;
  significant: boolean;
  tStatistic: number;
  pValue: number;
};

export type LeadLagReport = {
  generatedAt: string;
  startTime: string;
  endTime: string;
  totalMappings: number;
  totalPairsAnalyzed: number;
  significantPairs: number;
  kalshiSnapshotsLoaded: number;
  polymarketSnapshotsLoaded: number;
  summary: {
    overallLeader: string;
    medianLeadMs: number;
    pairsWhereKalshiLeads: number;
    pairsWherePolymarketLeads: number;
    pairsWhereCexLeads: number;
  };
  byEventType: Record<string, {
    leader: string;
    medianLeadMs: number;
    count: number;
  }>;
  pairs: LeadLagStats[];
};

export class LeadLagAnalyzer {
  constructor(private readonly db: DbLike) {}

  async analyze(params: {
    startTime: Date;
    endTime: Date;
  }): Promise<LeadLagReport> {
    const mappings = await loadEventMappings(this.db);

    const [kalshiSnapshots, polySnapshots] = await Promise.all([
      loadKalshiSnapshots(this.db, params),
      loadPolymarketSnapshots(this.db, params),
    ]);

    const kalshiByTicker = groupByTicker(kalshiSnapshots);
    const polyByTicker = groupByTicker(polySnapshots);

    const pairs: LeadLagPair[] = [];

    for (const mapping of mappings) {
      if (mapping.venue_a === mapping.venue_b) continue;

      const snapsA = getSnapshots(mapping.venue_a, mapping.ticker_a, kalshiByTicker, polyByTicker);
      const snapsB = getSnapshots(mapping.venue_b, mapping.ticker_b, kalshiByTicker, polyByTicker);

      if (snapsA.length < 2 || snapsB.length < 2) continue;

      const deltas = computePriceChangeDeltas(snapsA, snapsB);
      if (deltas.length === 0) continue;

      pairs.push({
        mappingId: mapping.id,
        venueA: mapping.venue_a,
        tickerA: mapping.ticker_a,
        titleA: mapping.title_a,
        venueB: mapping.venue_b,
        tickerB: mapping.ticker_b,
        titleB: mapping.title_b,
        underlyingAsset: mapping.underlying_asset,
        eventType: mapping.event_type,
        deltas,
      });
    }

    const stats = pairs.map(computeStats);

    const significantPairs = stats.filter((s) => s.significant);

    let kalshiLeads = 0;
    let polyLeads = 0;
    let cexLeads = 0;
    const allMedians: number[] = [];

    for (const s of significantPairs) {
      allMedians.push(s.medianDeltaMs);
      if (s.leader === "kalshi") kalshiLeads++;
      else if (s.leader === "polymarket") polyLeads++;
      else cexLeads++;
    }

    const byEventType: Record<string, { leader: string; medianLeadMs: number; count: number }> = {};
    for (const s of stats) {
      if (!byEventType[s.eventType]) {
        byEventType[s.eventType] = { leader: "", medianLeadMs: 0, count: 0 };
      }
      const entry = byEventType[s.eventType]!;
      entry.count++;
    }

    for (const [eventType, entry] of Object.entries(byEventType)) {
      const typeStats = stats.filter((s) => s.eventType === eventType && s.significant);
      if (typeStats.length === 0) continue;
      const typeMedians = typeStats.map((s) => s.medianDeltaMs);
      const median = percentile(typeMedians, 0.5);
      entry.medianLeadMs = median;
      const kLeads = typeStats.filter((s) => s.leader === "kalshi").length;
      const pLeads = typeStats.filter((s) => s.leader === "polymarket").length;
      if (kLeads > pLeads) entry.leader = "kalshi";
      else if (pLeads > kLeads) entry.leader = "polymarket";
      else entry.leader = "tied";
    }

    const overallMedian = allMedians.length > 0 ? percentile(allMedians, 0.5) : 0;
    const overallLeader = kalshiLeads > polyLeads
      ? "kalshi"
      : polyLeads > kalshiLeads
        ? "polymarket"
        : kalshiLeads === 0 && polyLeads === 0
          ? "insufficient_data"
          : "tied";

    return {
      generatedAt: new Date().toISOString(),
      startTime: params.startTime.toISOString(),
      endTime: params.endTime.toISOString(),
      totalMappings: mappings.length,
      totalPairsAnalyzed: pairs.length,
      significantPairs: significantPairs.length,
      kalshiSnapshotsLoaded: kalshiSnapshots.length,
      polymarketSnapshotsLoaded: polySnapshots.length,
      summary: {
        overallLeader,
        medianLeadMs: overallMedian,
        pairsWhereKalshiLeads: kalshiLeads,
        pairsWherePolymarketLeads: polyLeads,
        pairsWhereCexLeads: cexLeads,
      },
      byEventType,
      pairs: stats,
    };
  }
}

function groupByTicker(
  snapshots: ModuleMarketSnapshot[]
): Map<string, ModuleMarketSnapshot[]> {
  const map = new Map<string, ModuleMarketSnapshot[]>();
  for (const s of snapshots) {
    const key = `${s.sourceModule}:${s.ticker}`;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(s);
  }
  return map;
}

function getSnapshots(
  venue: string,
  ticker: string,
  kalshiByTicker: Map<string, ModuleMarketSnapshot[]>,
  polyByTicker: Map<string, ModuleMarketSnapshot[]>
): ModuleMarketSnapshot[] {
  const key = `${venue}:${ticker}`;
  return kalshiByTicker.get(key) ?? polyByTicker.get(key) ?? [];
}

type PriceChange = {
  ts: number;
  priceBefore: number;
  priceAfter: number;
  changePct: number;
};

function detectPriceChanges(snapshots: ModuleMarketSnapshot[], thresholdPct: number = 0.5): PriceChange[] {
  const changes: PriceChange[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const curr = snapshots[i]!;
    if (prev.price === 0) continue;
    const changePct = Math.abs((curr.price - prev.price) / prev.price) * 100;
    if (changePct >= thresholdPct) {
      changes.push({
        ts: curr.ts.getTime(),
        priceBefore: prev.price,
        priceAfter: curr.price,
        changePct,
      });
    }
  }
  return changes;
}

function computePriceChangeDeltas(
  snapsA: ModuleMarketSnapshot[],
  snapsB: ModuleMarketSnapshot[]
): number[] {
  const changesA = detectPriceChanges(snapsA);
  const changesB = detectPriceChanges(snapsB);

  if (changesA.length === 0 || changesB.length === 0) return [];

  const deltas: number[] = [];
  const maxWindowMs = 3600_000;

  for (const cA of changesA) {
    let bestMatch: PriceChange | null = null;
    let bestDist = Infinity;

    for (const cB of changesB) {
      const dist = Math.abs(cA.ts - cB.ts);
      if (dist > maxWindowMs) continue;

      const sameDirection =
        (cA.priceAfter > cA.priceBefore && cB.priceAfter > cB.priceBefore) ||
        (cA.priceAfter < cA.priceBefore && cB.priceAfter < cB.priceBefore);

      if (sameDirection && dist < bestDist) {
        bestDist = dist;
        bestMatch = cB;
      }
    }

    if (bestMatch) {
      deltas.push(cA.ts - bestMatch.ts);
    }
  }

  return deltas;
}

function computeStats(pair: LeadLagPair): LeadLagStats {
  const sorted = [...pair.deltas].sort((a, b) => a - b);
  const n = sorted.length;

  const med = percentile(sorted, 0.5);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  const mean = sorted.reduce((a, b) => a + b, 0) / n;

  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1 || 1);
  const stdDev = Math.sqrt(variance);

  const se = stdDev / Math.sqrt(n);
  const tStat = se > 0 ? mean / se : 0;
  const pVal = tStatToPValue(tStat, n - 1);

  const significant = n >= 5 && pVal < 0.05;
  const leader = med > 0 ? pair.venueA : med < 0 ? pair.venueB : "tied";
  const leadMs = Math.abs(med);

  return {
    mappingId: pair.mappingId,
    venueA: pair.venueA,
    tickerA: pair.tickerA,
    venueB: pair.venueB,
    tickerB: pair.tickerB,
    underlyingAsset: pair.underlyingAsset,
    eventType: pair.eventType,
    n,
    medianDeltaMs: med,
    p25DeltaMs: p25,
    p75DeltaMs: p75,
    meanDeltaMs: mean,
    stdDevMs: stdDev,
    leader,
    leadMs,
    significant,
    tStatistic: tStat,
    pValue: pVal,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  return loVal + frac * (hiVal - loVal);
}

function tStatToPValue(t: number, df: number): number {
  if (df <= 0) return 1;
  const absT = Math.abs(t);
  const x = df / (df + absT * absT);
  const beta = incompleteBeta(x, df / 2, 0.5);
  return beta;
}

function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);

  let sum = 0;
  let term = 1;
  for (let n = 0; n < 200; n++) {
    sum += term;
    term *= (x * (a + b + n) * (a + 1 + n)) / ((a + 1 + 2 * n) * (a + 2 + 2 * n));
    if (Math.abs(term) < 1e-15) break;
  }

  const result = (front / a) * sum;
  return Math.max(0, Math.min(1, result));
}

function lnGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = c[0]!;
  for (let i = 1; i < g + 2; i++) {
    x += (c[i] ?? 0) / (z + i);
  }

  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function formatReport(report: LeadLagReport): string {
  const lines: string[] = [];
  lines.push("# Cross-Venue Lead-Lag Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Period: ${report.startTime} to ${report.endTime}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total event mappings: ${report.totalMappings}`);
  lines.push(`- Pairs analyzed: ${report.totalPairsAnalyzed}`);
  lines.push(`- Statistically significant pairs: ${report.significantPairs}`);
  lines.push(`- Kalshi snapshots: ${report.kalshiSnapshotsLoaded}`);
  lines.push(`- Polymarket snapshots: ${report.polymarketSnapshotsLoaded}`);
  lines.push("");
  lines.push(`**Overall leader: ${report.summary.overallLeader}** (median lead: ${formatMs(report.summary.medianLeadMs)})`);
  lines.push(`- Kalshi leads: ${report.summary.pairsWhereKalshiLeads} pairs`);
  lines.push(`- Polymarket leads: ${report.summary.pairsWherePolymarketLeads} pairs`);
  lines.push(`- CEX/DEX leads: ${report.summary.pairsWhereCexLeads} pairs`);
  lines.push("");

  if (Object.keys(report.byEventType).length > 0) {
    lines.push("## By Event Type");
    lines.push("");
    lines.push("| Event Type | Leader | Median Lead | Count |");
    lines.push("|---|---|---|---|");
    for (const [eventType, entry] of Object.entries(report.byEventType)) {
      lines.push(`| ${eventType} | ${entry.leader || "n/a"} | ${formatMs(entry.medianLeadMs)} | ${entry.count} |`);
    }
    lines.push("");
  }

  if (report.pairs.length > 0) {
    lines.push("## Pair Details");
    lines.push("");
    lines.push("| Venue A | Ticker A | Venue B | Ticker B | Asset | N | Median | p25 | p75 | Leader | Sig? | p-value |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const p of report.pairs) {
      lines.push(
        `| ${p.venueA} | ${p.tickerA.slice(0, 20)} | ${p.venueB} | ${p.tickerB.slice(0, 20)} ` +
        `| ${p.underlyingAsset ?? "-"} | ${p.n} | ${formatMs(p.medianDeltaMs)} | ${formatMs(p.p25DeltaMs)} ` +
        `| ${formatMs(p.p75DeltaMs)} | ${p.leader} | ${p.significant ? "YES" : "no"} | ${p.pValue.toFixed(4)} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatMs(ms: number): string {
  const absMs = Math.abs(ms);
  if (absMs < 1000) return `${ms.toFixed(0)}ms`;
  if (absMs < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}
