import { Pool } from "pg";
import { connect, StringCodec } from "nats";
import { MarketMakerSimulator, parseMarketMakerSimSettings } from "./simulator.js";

interface JobContext {
  db: Pool;
  nats: { servers: string };
  settings: Record<string, unknown>;
  log: (level: string, message: string, meta?: unknown) => void;
}

const sc = StringCodec();

export async function backtest(ctx: JobContext): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const settings = parseMarketMakerSimSettings(ctx.settings);

  if (!settings.enabled) {
    ctx.log("info", "market-maker-sim is disabled, skipping backtest");
    return { ok: true, result: { skipped: true, reason: "disabled" } };
  }

  let nc;
  try {
    nc = await connect({ servers: ctx.nats.servers });
  } catch (err) {
    ctx.log("error", "failed to connect to NATS", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: `NATS connection failed: ${err instanceof Error ? err.message : err}` };
  }

  try {
    const simulator = new MarketMakerSimulator(settings, ctx.db, nc, sc);
    await simulator.ensureSchema();

    const result = await simulator.runBacktest();

    ctx.log("info", "backtest completed", {
      fills: result.fills.length,
      pnl: result.metrics.totalPnlUsd,
      sharpe: result.metrics.sharpeRatio,
    });

    return {
      ok: true,
      result: {
        mode: result.mode,
        durationMs: result.durationMs,
        fillCount: result.fills.length,
        totalPnlUsd: result.metrics.totalPnlUsd,
        sharpeRatio: result.metrics.sharpeRatio,
        fillRate: result.metrics.fillRate,
        maxDrawdownUsd: result.metrics.maxDrawdownUsd,
      },
    };
  } catch (err) {
    ctx.log("error", "backtest failed", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await nc.close();
  }
}

export async function paperTrade(ctx: JobContext): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const settings = parseMarketMakerSimSettings(ctx.settings);

  if (!settings.enabled) {
    ctx.log("info", "market-maker-sim is disabled, skipping paper trade");
    return { ok: true, result: { skipped: true, reason: "disabled" } };
  }

  if (settings.mode !== "paper") {
    ctx.log("info", "mode is not paper, skipping paper trade job");
    return { ok: true, result: { skipped: true, reason: "mode is backtest" } };
  }

  let nc;
  try {
    nc = await connect({ servers: ctx.nats.servers });
  } catch (err) {
    ctx.log("error", "failed to connect to NATS", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: `NATS connection failed: ${err instanceof Error ? err.message : err}` };
  }

  try {
    const simulator = new MarketMakerSimulator(settings, ctx.db, nc, sc);
    await simulator.ensureSchema();

    const result = await simulator.startPaperTrading();

    ctx.log("info", "paper trading cycle completed", {
      sessionId: result.sessionId,
      tradesProcessed: result.tradesProcessed,
      fillsGenerated: result.fillsGenerated,
    });

    return {
      ok: true,
      result: {
        sessionId: result.sessionId,
        tradesProcessed: result.tradesProcessed,
        fillsGenerated: result.fillsGenerated,
      },
    };
  } catch (err) {
    ctx.log("error", "paper trading failed", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await nc.close();
  }
}

export async function reportStats(ctx: JobContext): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const settings = parseMarketMakerSimSettings(ctx.settings);

  if (!settings.enabled) {
    ctx.log("info", "market-maker-sim is disabled, skipping stats report");
    return { ok: true, result: { skipped: true, reason: "disabled" } };
  }

  let nc;
  try {
    nc = await connect({ servers: ctx.nats.servers });
  } catch (err) {
    ctx.log("error", "failed to connect to NATS", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: `NATS connection failed: ${err instanceof Error ? err.message : err}` };
  }

  try {
    const simulator = new MarketMakerSimulator(settings, ctx.db, nc, sc);
    await simulator.ensureSchema();

    const metrics = await simulator.reportStats();

    ctx.log("info", "stats reported", {
      totalPnlUsd: metrics.totalPnlUsd,
      fillCount: metrics.fillCount,
      sharpeRatio: metrics.sharpeRatio,
    });

    return {
      ok: true,
      result: {
        totalPnlUsd: metrics.totalPnlUsd,
        realizedPnlUsd: metrics.realizedPnlUsd,
        unrealizedPnlUsd: metrics.unrealizedPnlUsd,
        fillCount: metrics.fillCount,
        fillRate: metrics.fillRate,
        sharpeRatio: metrics.sharpeRatio,
        maxDrawdownUsd: metrics.maxDrawdownUsd,
        adverseSelectionCost: metrics.adverseSelectionCost,
        winRate: metrics.winRate,
        totalVolumeUsd: metrics.totalVolumeUsd,
      },
    };
  } catch (err) {
    ctx.log("error", "stats report failed", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await nc.close();
  }
}
