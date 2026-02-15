import type { ModuleRuntime } from "@feedeater/module-sdk";

import { MarketMakerSimulator, parseMarketMakerSimSettings } from "./simulator.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "market-maker-sim",
    handlers: {
      mod_market_maker_sim: {
        async backtest({ ctx }) {
          const raw = await ctx.fetchInternalSettings("market-maker-sim");
          const settings = parseMarketMakerSimSettings(raw);
          if (!settings.enabled) {
            return {
              metrics: { skipped: true, reason: "module disabled" },
            };
          }

          const simulator = new MarketMakerSimulator(
            settings,
            ctx.db as any,
            ctx.nats as any,
            ctx.sc as any,
          );
          await simulator.ensureSchema();
          const result = await simulator.runBacktest();

          return {
            metrics: {
              mode: result.mode,
              duration_ms: result.durationMs,
              fill_count: result.fills.length,
              total_pnl_usd: result.metrics.totalPnlUsd,
              sharpe_ratio: result.metrics.sharpeRatio,
              fill_rate: result.metrics.fillRate,
              max_drawdown_usd: result.metrics.maxDrawdownUsd,
            },
          };
        },

        async paperTrade({ ctx }) {
          const raw = await ctx.fetchInternalSettings("market-maker-sim");
          const settings = parseMarketMakerSimSettings(raw);
          if (!settings.enabled) {
            return {
              metrics: { skipped: true, reason: "module disabled" },
            };
          }

          if (settings.mode !== "paper") {
            return {
              metrics: { skipped: true, reason: "mode is backtest" },
            };
          }

          const simulator = new MarketMakerSimulator(
            settings,
            ctx.db as any,
            ctx.nats as any,
            ctx.sc as any,
          );
          await simulator.ensureSchema();
          const result = await simulator.startPaperTrading();

          return {
            metrics: {
              session_id: result.sessionId,
              trades_processed: result.tradesProcessed,
              fills_generated: result.fillsGenerated,
            },
          };
        },

        async reportStats({ ctx }) {
          const raw = await ctx.fetchInternalSettings("market-maker-sim");
          const settings = parseMarketMakerSimSettings(raw);
          if (!settings.enabled) {
            return {
              metrics: { skipped: true, reason: "module disabled" },
            };
          }

          const simulator = new MarketMakerSimulator(
            settings,
            ctx.db as any,
            ctx.nats as any,
            ctx.sc as any,
          );
          await simulator.ensureSchema();
          const metrics = await simulator.reportStats();

          return {
            metrics: {
              total_pnl_usd: metrics.totalPnlUsd,
              realized_pnl_usd: metrics.realizedPnlUsd,
              unrealized_pnl_usd: metrics.unrealizedPnlUsd,
              fill_count: metrics.fillCount,
              fill_rate: metrics.fillRate,
              sharpe_ratio: metrics.sharpeRatio,
              max_drawdown_usd: metrics.maxDrawdownUsd,
              adverse_selection_cost: metrics.adverseSelectionCost,
              win_rate: metrics.winRate,
              total_volume_usd: metrics.totalVolumeUsd,
            },
          };
        },
      },
    },
  };
}
