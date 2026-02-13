import { Pool } from "pg";
import { connect, StringCodec } from "nats";
import { AromerStrategy, parseAromerSettings } from "./strategy.js";

interface JobContext {
  db: Pool;
  nats: { servers: string };
  settings: Record<string, unknown>;
  log: (level: string, message: string, meta?: unknown) => void;
}

const sc = StringCodec();

export async function paperTrade(ctx: JobContext): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const settings = parseAromerSettings(ctx.settings);

  if (!settings.enabled) {
    ctx.log("info", "aromer-strategy is disabled, skipping paper trade");
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
    const strategy = new AromerStrategy(settings, ctx.db, nc, sc);
    await strategy.ensureSchema();

    const result = await strategy.startPaperTrading();

    ctx.log("info", "paper trading cycle completed", {
      sessionId: result.sessionId,
      tradesProcessed: result.tradesProcessed,
      signalsGenerated: result.signalsGenerated,
      ordersPlaced: result.ordersPlaced,
    });

    return {
      ok: true,
      result: {
        sessionId: result.sessionId,
        tradesProcessed: result.tradesProcessed,
        signalsGenerated: result.signalsGenerated,
        ordersPlaced: result.ordersPlaced,
      },
    };
  } catch (err) {
    ctx.log("error", "paper trading failed", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await nc.close();
  }
}

export async function reportMetrics(ctx: JobContext): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const settings = parseAromerSettings(ctx.settings);

  if (!settings.enabled) {
    ctx.log("info", "aromer-strategy is disabled, skipping metrics report");
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
    const strategy = new AromerStrategy(settings, ctx.db, nc, sc);
    await strategy.ensureSchema();

    const metrics = await strategy.reportMetrics();

    ctx.log("info", "metrics reported", {
      totalPnlUsd: metrics.totalPnlUsd,
      sharpeRatio: metrics.sharpeRatio,
      winRate: metrics.winRate,
    });

    return {
      ok: true,
      result: {
        totalPnlUsd: metrics.totalPnlUsd,
        realizedPnlUsd: metrics.realizedPnlUsd,
        unrealizedPnlUsd: metrics.unrealizedPnlUsd,
        sharpeRatio: metrics.sharpeRatio,
        winRate: metrics.winRate,
        maxDrawdownUsd: metrics.maxDrawdownUsd,
        maxDrawdownPct: metrics.maxDrawdownPct,
        totalTrades: metrics.totalTrades,
        openPositions: metrics.openPositions,
        signalsGenerated: metrics.signalsGenerated,
        signalsActedOn: metrics.signalsActedOn,
        dailyPnlUsd: metrics.dailyPnlUsd,
        killSwitchTriggered: metrics.killSwitchTriggered,
        killSwitchReason: metrics.killSwitchReason,
        perVenueEdge: metrics.perVenueEdge,
      },
    };
  } catch (err) {
    ctx.log("error", "metrics report failed", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await nc.close();
  }
}

export async function backtest(ctx: JobContext): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const settings = parseAromerSettings(ctx.settings);

  if (!settings.enabled) {
    ctx.log("info", "aromer-strategy is disabled, skipping backtest");
    return { ok: true, result: { skipped: true, reason: "disabled" } };
  }

  const data = ctx.settings as Record<string, unknown>;
  const startTimeStr = String(data.start_time ?? data.startTime ?? "");
  const endTimeStr = String(data.end_time ?? data.endTime ?? "");

  if (!startTimeStr || !endTimeStr) {
    return { ok: false, error: "start_time and end_time are required in job data" };
  }

  const startTime = new Date(startTimeStr);
  const endTime = new Date(endTimeStr);

  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
    return { ok: false, error: "invalid start_time or end_time format" };
  }

  let nc;
  try {
    nc = await connect({ servers: ctx.nats.servers });
  } catch (err) {
    ctx.log("error", "failed to connect to NATS", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: `NATS connection failed: ${err instanceof Error ? err.message : err}` };
  }

  try {
    const strategy = new AromerStrategy(settings, ctx.db, nc, sc);
    await strategy.ensureSchema();

    const result = await strategy.runBacktest({ startTime, endTime });

    ctx.log("info", "backtest completed", {
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      tradesProcessed: result.tradesProcessed,
      signalsGenerated: result.signalsGenerated,
      ordersPlaced: result.ordersPlaced,
      pnl: result.metrics.totalPnlUsd,
      sharpe: result.metrics.sharpeRatio,
    });

    return {
      ok: true,
      result: {
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        tradesProcessed: result.tradesProcessed,
        signalsGenerated: result.signalsGenerated,
        ordersPlaced: result.ordersPlaced,
        totalPnlUsd: result.metrics.totalPnlUsd,
        sharpeRatio: result.metrics.sharpeRatio,
        winRate: result.metrics.winRate,
        maxDrawdownUsd: result.metrics.maxDrawdownUsd,
        perVenueEdge: result.metrics.perVenueEdge,
      },
    };
  } catch (err) {
    ctx.log("error", "backtest failed", { err: err instanceof Error ? err.message : err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await nc.close();
  }
}
