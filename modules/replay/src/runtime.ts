import type { ModuleRuntime } from "@feedeater/module-sdk";

import { ReplayEngine, parseReplaySettingsFromInternal } from "./replay.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "replay",
    handlers: {
      mod_replay: {
        async startReplay({ ctx }) {
          const raw = await ctx.fetchInternalSettings("replay");
          const settings = parseReplaySettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const engine = new ReplayEngine(settings, ctx.db, ctx.nats, ctx.sc);
          await engine.ensureSchema();
          const stats = await engine.startReplay();

          return {
            metrics: {
              total_events: stats.totalEvents,
              events_by_source: stats.eventsBySource,
              replay_duration_ms: stats.replayDurationMs,
              real_time_duration_ms: stats.realTimeDurationMs,
              speed_multiplier: stats.speedMultiplier,
              lead_lag_count: stats.leadLagResults.length,
              latency_p50: stats.latencyDistribution.p50,
              latency_p90: stats.latencyDistribution.p90,
              latency_p99: stats.latencyDistribution.p99,
              latency_mean: stats.latencyDistribution.mean,
            },
          };
        },

        async analyzeLeadLag({ ctx }) {
          const raw = await ctx.fetchInternalSettings("replay");
          const settings = parseReplaySettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const engine = new ReplayEngine(settings, ctx.db, ctx.nats, ctx.sc);
          await engine.ensureSchema();
          const results = await engine.analyzeLeadLag();
          const overallStats = await engine.getReplayStats();

          return {
            metrics: {
              lead_lag_pairs: results.length,
              results: results.map((r) => ({
                venues: `${r.venue1}_vs_${r.venue2}`,
                lag_ms: r.lagMs,
                correlation: r.correlation,
                samples: r.sampleCount,
              })),
              total_sessions: overallStats.totalSessions,
              completed_sessions: overallStats.completedSessions,
              total_events_replayed: overallStats.totalEventsReplayed,
              avg_lead_lag: overallStats.avgLeadLag,
            },
          };
        },
      },
    },
  };
}
