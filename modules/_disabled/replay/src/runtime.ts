import type { ModuleRuntime } from "@feedeater/module-sdk";

import { ReplayEngine, parseReplaySettings } from "./engine.js";
import { LeadLagAnalyzer, formatReport } from "./leadlag.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "replay",
    handlers: {
      mod_replay: {
        async replay({ ctx, job }) {
          const raw = await ctx.fetchInternalSettings("replay");
          const settings = parseReplaySettings(raw);
          if (!settings.enabled) {
            return {
              metrics: { skipped: true, reason: "module disabled" },
            };
          }

          const data = job.data as Record<string, unknown> | undefined;
          const startTimeStr = String(data?.start_time ?? data?.startTime ?? "");
          const endTimeStr = String(data?.end_time ?? data?.endTime ?? "");

          if (!startTimeStr || !endTimeStr) {
            return {
              metrics: {
                error: true,
                reason: "start_time and end_time are required in job data",
              },
            };
          }

          const startTime = new Date(startTimeStr);
          const endTime = new Date(endTimeStr);

          if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
            return {
              metrics: {
                error: true,
                reason: "invalid start_time or end_time format",
              },
            };
          }

          const speedOverride = data?.speed_multiplier ?? data?.speedMultiplier;

          const engine = new ReplayEngine(ctx.db, ctx.nats, ctx.sc, settings);
          const replayParams: { startTime: Date; endTime: Date; speedMultiplier?: number } = {
            startTime,
            endTime,
          };
          if (speedOverride) {
            replayParams.speedMultiplier = Number(speedOverride);
          }
          const result = await engine.replay(replayParams);

          return {
            metrics: {
              total_messages: result.totalMessages,
              replayed: result.replayed,
              duration_ms: result.durationMs,
              wall_clock_span_ms: result.wallClockSpanMs,
              effective_speed: result.effectiveSpeed,
              module_breakdown: result.moduleBreakdown,
            },
          };
        },

        async leadLagReport({ ctx, job }) {
          const raw = await ctx.fetchInternalSettings("replay");
          const settings = parseReplaySettings(raw);
          if (!settings.enabled) {
            return {
              metrics: { skipped: true, reason: "module disabled" },
            };
          }

          const data = job.data as Record<string, unknown> | undefined;
          const startTimeStr = String(data?.start_time ?? data?.startTime ?? "");
          const endTimeStr = String(data?.end_time ?? data?.endTime ?? "");

          if (!startTimeStr || !endTimeStr) {
            return {
              metrics: {
                error: true,
                reason: "start_time and end_time are required in job data",
              },
            };
          }

          const startTime = new Date(startTimeStr);
          const endTime = new Date(endTimeStr);

          if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
            return {
              metrics: {
                error: true,
                reason: "invalid start_time or end_time format",
              },
            };
          }

          const analyzer = new LeadLagAnalyzer(ctx.db);
          const report = await analyzer.analyze({ startTime, endTime });
          const reportText = formatReport(report);

          try {
            ctx.nats.publish(
              "feedeater.replay.leadLagReport",
              ctx.sc.encode(JSON.stringify(report))
            );
          } catch { /* ignore */ }

          try {
            ctx.nats.publish(
              "feedeater.replay.leadLagReport.text",
              ctx.sc.encode(reportText)
            );
          } catch { /* ignore */ }

          return {
            metrics: {
              total_mappings: report.totalMappings,
              pairs_analyzed: report.totalPairsAnalyzed,
              significant_pairs: report.significantPairs,
              overall_leader: report.summary.overallLeader,
              median_lead_ms: report.summary.medianLeadMs,
              kalshi_leads: report.summary.pairsWhereKalshiLeads,
              polymarket_leads: report.summary.pairsWherePolymarketLeads,
              cex_leads: report.summary.pairsWhereCexLeads,
              kalshi_snapshots: report.kalshiSnapshotsLoaded,
              polymarket_snapshots: report.polymarketSnapshotsLoaded,
              report_length: reportText.length,
            },
          };
        },
      },
    },
  };
}
