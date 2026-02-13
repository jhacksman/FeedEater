import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, Subscription, Codec } from "nats";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

const UUID_NAMESPACE = "c3d5e7f9-1a2b-4c6d-8e0f-2a4b6c8d0e1f";

export type MarketMakerSimSettings = {
  enabled: boolean;
  mode: "backtest" | "paper";
  spreadBps: number;
  positionLimitUsd: number;
  inventorySkewFactor: number;
  includeKalshi: boolean;
  includePolymarket: boolean;
  backtestStartTime: string;
  backtestEndTime: string;
  backtestSpeedMultiplier: number;
  initialCapitalUsd: number;
  riskFreeRate: number;
};

export function parseMarketMakerSimSettings(raw: Record<string, unknown>): MarketMakerSimSettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const mode = String(raw.mode ?? "paper") === "backtest" ? "backtest" : "paper";
  const spreadBps = raw.spreadBps ? Number(raw.spreadBps) : 100;
  const positionLimitUsd = raw.positionLimitUsd ? Number(raw.positionLimitUsd) : 10000;
  const inventorySkewFactor = raw.inventorySkewFactor ? Number(raw.inventorySkewFactor) : 0.5;
  const includeKalshi = String(raw.includeKalshi ?? "true") !== "false";
  const includePolymarket = String(raw.includePolymarket ?? "true") !== "false";
  const backtestStartTime = String(raw.backtestStartTime ?? "");
  const backtestEndTime = String(raw.backtestEndTime ?? "");
  const backtestSpeedMultiplier = raw.backtestSpeedMultiplier ? Number(raw.backtestSpeedMultiplier) : 100;
  const initialCapitalUsd = raw.initialCapitalUsd ? Number(raw.initialCapitalUsd) : 100000;
  const riskFreeRate = raw.riskFreeRate ? Number(raw.riskFreeRate) : 0.05;

  if (!Number.isFinite(spreadBps) || spreadBps <= 0) {
    throw new Error('MarketMakerSim setting "spreadBps" must be a positive number');
  }
  if (!Number.isFinite(positionLimitUsd) || positionLimitUsd <= 0) {
    throw new Error('MarketMakerSim setting "positionLimitUsd" must be a positive number');
  }

  return {
    enabled,
    mode,
    spreadBps,
    positionLimitUsd,
    inventorySkewFactor: Math.max(0, Math.min(1, inventorySkewFactor)),
    includeKalshi,
    includePolymarket,
    backtestStartTime,
    backtestEndTime,
    backtestSpeedMultiplier: Math.max(1, backtestSpeedMultiplier),
    initialCapitalUsd,
    riskFreeRate: Math.max(0, Math.min(1, riskFreeRate)),
  };
}

export interface Quote {
  marketId: string;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  midPrice: number;
  spreadBps: number;
  timestamp: Date;
}

export interface Fill {
  id: string;
  marketId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  notionalUsd: number;
  pnlUsd: number;
  timestamp: Date;
  source: "kalshi" | "polymarket";
}

export interface Position {
  marketId: string;
  quantity: number;
  avgEntryPrice: number;
  notionalUsd: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface PerformanceMetrics {
  totalPnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  fillCount: number;
  fillRate: number;
  quoteCount: number;
  inventoryExposureUsd: number;
  maxDrawdownUsd: number;
  sharpeRatio: number;
  adverseSelectionCost: number;
  winRate: number;
  avgFillSize: number;
  totalVolumeUsd: number;
}

export interface SimulationResult {
  mode: "backtest" | "paper";
  startTime: Date;
  endTime: Date;
  durationMs: number;
  metrics: PerformanceMetrics;
  fills: Fill[];
  finalPositions: Position[];
  equityCurve: { timestamp: Date; equity: number }[];
}

interface TradeEvent {
  id: string;
  marketId: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  notionalUsd: number;
  timestamp: Date;
  source: "kalshi" | "polymarket";
}

export class MarketMakerSimulator {
  private positions: Map<string, Position> = new Map();
  private fills: Fill[] = [];
  private quotes: Quote[] = [];
  private equityCurve: { timestamp: Date; equity: number }[] = [];
  private capital: number;
  private peakEquity: number;
  private maxDrawdown: number = 0;
  private totalVolume: number = 0;
  private adverseSelectionTotal: number = 0;
  private subscription: Subscription | null = null;
  private isRunning: boolean = false;
  private lastPrices: Map<string, number> = new Map();
  private dailyReturns: number[] = [];
  private lastEquityDate: string = "";

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.market-maker-sim.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "market-maker-sim",
            source: "simulator",
            at: new Date().toISOString(),
            message,
            meta,
          })
        )
      );
    } catch {
      // ignore
    }
  }

  constructor(
    private readonly settings: MarketMakerSimSettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: Codec<string>
  ) {
    this.capital = settings.initialCapitalUsd;
    this.peakEquity = settings.initialCapitalUsd;
  }

  async ensureSchema(): Promise<void> {
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_market_maker_sim");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_market_maker_sim.sessions (
        id text PRIMARY KEY,
        mode text NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz,
        settings jsonb NOT NULL,
        metrics jsonb,
        status text DEFAULT 'running'
      )
    `);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_market_maker_sim.fills (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        market_id text NOT NULL,
        side text NOT NULL,
        price numeric NOT NULL,
        size numeric NOT NULL,
        notional_usd numeric NOT NULL,
        pnl_usd numeric NOT NULL,
        source text NOT NULL,
        filled_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS mmsim_fills_session_idx ON mod_market_maker_sim.fills (session_id, filled_at)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_market_maker_sim.positions (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        market_id text NOT NULL,
        quantity numeric NOT NULL,
        avg_entry_price numeric NOT NULL,
        notional_usd numeric NOT NULL,
        unrealized_pnl numeric NOT NULL,
        realized_pnl numeric NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS mmsim_positions_session_idx ON mod_market_maker_sim.positions (session_id)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_market_maker_sim.equity_curve (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        equity numeric NOT NULL,
        timestamp timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS mmsim_equity_session_idx ON mod_market_maker_sim.equity_curve (session_id, timestamp)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_market_maker_sim.metrics_snapshots (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        metrics jsonb NOT NULL,
        snapshot_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS mmsim_metrics_session_idx ON mod_market_maker_sim.metrics_snapshots (session_id, snapshot_at)`);
  }

  private generateQuote(marketId: string, midPrice: number): Quote {
    const position = this.positions.get(marketId);
    const inventory = position?.quantity ?? 0;

    const baseSpread = this.settings.spreadBps / 10000;
    const inventorySkew = inventory * this.settings.inventorySkewFactor * baseSpread;

    const bidPrice = midPrice * (1 - baseSpread / 2 - inventorySkew);
    const askPrice = midPrice * (1 + baseSpread / 2 - inventorySkew);

    const maxPositionValue = this.settings.positionLimitUsd;
    const currentPositionValue = Math.abs(inventory * midPrice);
    const remainingCapacity = Math.max(0, maxPositionValue - currentPositionValue);

    const bidSize = inventory >= 0 ? remainingCapacity / bidPrice : (remainingCapacity + currentPositionValue) / bidPrice;
    const askSize = inventory <= 0 ? remainingCapacity / askPrice : (remainingCapacity + currentPositionValue) / askPrice;

    return {
      marketId,
      bidPrice,
      askPrice,
      bidSize: Math.max(0, bidSize),
      askSize: Math.max(0, askSize),
      midPrice,
      spreadBps: ((askPrice - bidPrice) / midPrice) * 10000,
      timestamp: new Date(),
    };
  }

  private checkFill(trade: TradeEvent, quote: Quote): Fill | null {
    if (trade.side === "buy" && trade.price >= quote.askPrice && quote.askSize > 0) {
      const fillSize = Math.min(trade.size, quote.askSize);
      const fillPrice = quote.askPrice;
      const notionalUsd = fillSize * fillPrice;

      const position = this.positions.get(trade.marketId);
      let pnlUsd = 0;

      if (position && position.quantity < 0) {
        const closingQty = Math.min(fillSize, Math.abs(position.quantity));
        pnlUsd = closingQty * (position.avgEntryPrice - fillPrice);
      }

      return {
        id: uuidv5(`fill:${trade.id}:${Date.now()}`, UUID_NAMESPACE),
        marketId: trade.marketId,
        side: "sell",
        price: fillPrice,
        size: fillSize,
        notionalUsd,
        pnlUsd,
        timestamp: trade.timestamp,
        source: trade.source,
      };
    }

    if (trade.side === "sell" && trade.price <= quote.bidPrice && quote.bidSize > 0) {
      const fillSize = Math.min(trade.size, quote.bidSize);
      const fillPrice = quote.bidPrice;
      const notionalUsd = fillSize * fillPrice;

      const position = this.positions.get(trade.marketId);
      let pnlUsd = 0;

      if (position && position.quantity > 0) {
        const closingQty = Math.min(fillSize, position.quantity);
        pnlUsd = closingQty * (fillPrice - position.avgEntryPrice);
      }

      return {
        id: uuidv5(`fill:${trade.id}:${Date.now()}`, UUID_NAMESPACE),
        marketId: trade.marketId,
        side: "buy",
        price: fillPrice,
        size: fillSize,
        notionalUsd,
        pnlUsd,
        timestamp: trade.timestamp,
        source: trade.source,
      };
    }

    return null;
  }

  private updatePosition(fill: Fill): void {
    const existing = this.positions.get(fill.marketId);
    const fillQty = fill.side === "buy" ? fill.size : -fill.size;

    if (!existing) {
      this.positions.set(fill.marketId, {
        marketId: fill.marketId,
        quantity: fillQty,
        avgEntryPrice: fill.price,
        notionalUsd: Math.abs(fillQty * fill.price),
        unrealizedPnl: 0,
        realizedPnl: fill.pnlUsd,
      });
    } else {
      const newQty = existing.quantity + fillQty;

      if (Math.sign(existing.quantity) === Math.sign(fillQty) || existing.quantity === 0) {
        const totalCost = existing.quantity * existing.avgEntryPrice + fillQty * fill.price;
        existing.avgEntryPrice = newQty !== 0 ? totalCost / newQty : fill.price;
      }

      existing.quantity = newQty;
      existing.notionalUsd = Math.abs(newQty * fill.price);
      existing.realizedPnl += fill.pnlUsd;
    }

    this.totalVolume += fill.notionalUsd;
    this.fills.push(fill);

    const midPrice = this.lastPrices.get(fill.marketId) ?? fill.price;
    if (fill.side === "buy" && fill.price > midPrice) {
      this.adverseSelectionTotal += (fill.price - midPrice) * fill.size;
    } else if (fill.side === "sell" && fill.price < midPrice) {
      this.adverseSelectionTotal += (midPrice - fill.price) * fill.size;
    }
  }

  private updateEquity(timestamp: Date): void {
    let totalUnrealizedPnl = 0;
    for (const position of this.positions.values()) {
      const currentPrice = this.lastPrices.get(position.marketId) ?? position.avgEntryPrice;
      position.unrealizedPnl = position.quantity * (currentPrice - position.avgEntryPrice);
      totalUnrealizedPnl += position.unrealizedPnl;
    }

    const totalRealizedPnl = Array.from(this.positions.values()).reduce((sum, p) => sum + p.realizedPnl, 0);
    const equity = this.settings.initialCapitalUsd + totalRealizedPnl + totalUnrealizedPnl;

    this.equityCurve.push({ timestamp, equity });

    if (equity > this.peakEquity) {
      this.peakEquity = equity;
    }
    const drawdown = this.peakEquity - equity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }

    const dateStr = timestamp.toISOString().slice(0, 10);
    if (dateStr !== this.lastEquityDate && this.equityCurve.length > 1) {
      const prevEquity = this.equityCurve[this.equityCurve.length - 2]?.equity ?? this.settings.initialCapitalUsd;
      if (prevEquity > 0) {
        this.dailyReturns.push((equity - prevEquity) / prevEquity);
      }
      this.lastEquityDate = dateStr;
    }
  }

  private calculateSharpeRatio(): number {
    if (this.dailyReturns.length < 2) return 0;

    const avgReturn = this.dailyReturns.reduce((a, b) => a + b, 0) / this.dailyReturns.length;
    const variance = this.dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / this.dailyReturns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    const dailyRiskFreeRate = this.settings.riskFreeRate / 252;
    const excessReturn = avgReturn - dailyRiskFreeRate;

    return (excessReturn / stdDev) * Math.sqrt(252);
  }

  getMetrics(): PerformanceMetrics {
    const totalRealizedPnl = Array.from(this.positions.values()).reduce((sum, p) => sum + p.realizedPnl, 0);
    const totalUnrealizedPnl = Array.from(this.positions.values()).reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const inventoryExposure = Array.from(this.positions.values()).reduce((sum, p) => sum + p.notionalUsd, 0);

    const winningFills = this.fills.filter((f) => f.pnlUsd > 0).length;
    const avgFillSize = this.fills.length > 0 ? this.totalVolume / this.fills.length : 0;

    return {
      totalPnlUsd: totalRealizedPnl + totalUnrealizedPnl,
      realizedPnlUsd: totalRealizedPnl,
      unrealizedPnlUsd: totalUnrealizedPnl,
      fillCount: this.fills.length,
      fillRate: this.quotes.length > 0 ? this.fills.length / this.quotes.length : 0,
      quoteCount: this.quotes.length,
      inventoryExposureUsd: inventoryExposure,
      maxDrawdownUsd: this.maxDrawdown,
      sharpeRatio: this.calculateSharpeRatio(),
      adverseSelectionCost: this.adverseSelectionTotal,
      winRate: this.fills.length > 0 ? winningFills / this.fills.length : 0,
      avgFillSize,
      totalVolumeUsd: this.totalVolume,
    };
  }

  private async fetchKalshiTrades(startTime: Date, endTime: Date): Promise<TradeEvent[]> {
    try {
      const result = await this.db.query<{
        id: string;
        ticker: string;
        count: number;
        yes_price: number;
        taker_side: string;
        created_at: Date;
      }>(
        `SELECT id, ticker, count, yes_price, taker_side, created_at
         FROM mod_kalshi.trades
         WHERE created_at >= $1 AND created_at <= $2
         ORDER BY created_at ASC`,
        [startTime, endTime]
      );

      return result.rows.map((row) => ({
        id: row.id,
        marketId: `kalshi:${row.ticker}`,
        price: row.yes_price,
        size: row.count,
        side: row.taker_side === "yes" ? "buy" as const : "sell" as const,
        notionalUsd: row.count * row.yes_price,
        timestamp: new Date(row.created_at),
        source: "kalshi" as const,
      }));
    } catch (err) {
      this.log("warn", "failed to fetch kalshi trades (schema may not exist)", {
        err: err instanceof Error ? err.message : err,
      });
      return [];
    }
  }

  private async fetchPolymarketTrades(startTime: Date, endTime: Date): Promise<TradeEvent[]> {
    try {
      const result = await this.db.query<{
        id: string;
        market_id: string;
        side: string;
        size: number;
        price: number;
        notional_usd: number;
        timestamp_ms: bigint;
      }>(
        `SELECT id, market_id, side, size, price, notional_usd, timestamp_ms
         FROM mod_polymarket.trades
         WHERE created_at >= $1 AND created_at <= $2
         ORDER BY timestamp_ms ASC`,
        [startTime, endTime]
      );

      return result.rows.map((row) => ({
        id: row.id,
        marketId: `polymarket:${row.market_id}`,
        price: Number(row.price),
        size: Number(row.size),
        side: row.side === "buy" ? "buy" as const : "sell" as const,
        notionalUsd: Number(row.notional_usd),
        timestamp: new Date(Number(row.timestamp_ms)),
        source: "polymarket" as const,
      }));
    } catch (err) {
      this.log("warn", "failed to fetch polymarket trades (schema may not exist)", {
        err: err instanceof Error ? err.message : err,
      });
      return [];
    }
  }

  async runBacktest(): Promise<SimulationResult> {
    const startTime = this.settings.backtestStartTime
      ? new Date(this.settings.backtestStartTime)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const endTime = this.settings.backtestEndTime
      ? new Date(this.settings.backtestEndTime)
      : new Date();

    this.log("info", "starting backtest", {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      settings: this.settings,
    });

    const sessionId = uuidv5(`backtest:${Date.now()}`, UUID_NAMESPACE);
    await this.db.query(
      `INSERT INTO mod_market_maker_sim.sessions (id, mode, settings)
       VALUES ($1, $2, $3)`,
      [sessionId, "backtest", JSON.stringify(this.settings)]
    );

    const allTrades: TradeEvent[] = [];

    if (this.settings.includeKalshi) {
      const kalshiTrades = await this.fetchKalshiTrades(startTime, endTime);
      allTrades.push(...kalshiTrades);
      this.log("info", "loaded kalshi trades", { count: kalshiTrades.length });
    }

    if (this.settings.includePolymarket) {
      const polymarketTrades = await this.fetchPolymarketTrades(startTime, endTime);
      allTrades.push(...polymarketTrades);
      this.log("info", "loaded polymarket trades", { count: polymarketTrades.length });
    }

    allTrades.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    this.log("info", "total trades to replay", { count: allTrades.length });

    const backtestStart = Date.now();
    let prevTradeTime: number | null = null;

    for (const trade of allTrades) {
      this.lastPrices.set(trade.marketId, trade.price);

      const quote = this.generateQuote(trade.marketId, trade.price);
      this.quotes.push(quote);

      const fill = this.checkFill(trade, quote);
      if (fill) {
        this.updatePosition(fill);

        await this.db.query(
          `INSERT INTO mod_market_maker_sim.fills (id, session_id, market_id, side, price, size, notional_usd, pnl_usd, source, filled_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [fill.id, sessionId, fill.marketId, fill.side, fill.price, fill.size, fill.notionalUsd, fill.pnlUsd, fill.source, fill.timestamp]
        );
      }

      this.updateEquity(trade.timestamp);

      if (prevTradeTime !== null && this.settings.backtestSpeedMultiplier < 10000) {
        const realDeltaMs = trade.timestamp.getTime() - prevTradeTime;
        if (realDeltaMs > 0) {
          const waitMs = realDeltaMs / this.settings.backtestSpeedMultiplier;
          if (waitMs > 1 && waitMs < 100) {
            await this.sleep(waitMs);
          }
        }
      }
      prevTradeTime = trade.timestamp.getTime();
    }

    const metrics = this.getMetrics();
    const durationMs = Date.now() - backtestStart;

    await this.db.query(
      `UPDATE mod_market_maker_sim.sessions
       SET ended_at = now(), metrics = $1, status = 'completed'
       WHERE id = $2`,
      [JSON.stringify(metrics), sessionId]
    );

    for (const position of this.positions.values()) {
      const posId = uuidv5(`position:${sessionId}:${position.marketId}`, UUID_NAMESPACE);
      await this.db.query(
        `INSERT INTO mod_market_maker_sim.positions (id, session_id, market_id, quantity, avg_entry_price, notional_usd, unrealized_pnl, realized_pnl)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           avg_entry_price = EXCLUDED.avg_entry_price,
           notional_usd = EXCLUDED.notional_usd,
           unrealized_pnl = EXCLUDED.unrealized_pnl,
           realized_pnl = EXCLUDED.realized_pnl,
           updated_at = now()`,
        [posId, sessionId, position.marketId, position.quantity, position.avgEntryPrice, position.notionalUsd, position.unrealizedPnl, position.realizedPnl]
      );
    }

    this.publishMetrics(metrics);

    this.log("info", "backtest complete", { durationMs, metrics });

    return {
      mode: "backtest",
      startTime,
      endTime,
      durationMs,
      metrics,
      fills: this.fills,
      finalPositions: Array.from(this.positions.values()),
      equityCurve: this.equityCurve,
    };
  }

  async startPaperTrading(): Promise<{ sessionId: string; tradesProcessed: number; fillsGenerated: number }> {
    this.isRunning = true;
    const sessionId = uuidv5(`paper:${Date.now()}`, UUID_NAMESPACE);

    await this.db.query(
      `INSERT INTO mod_market_maker_sim.sessions (id, mode, settings)
       VALUES ($1, $2, $3)`,
      [sessionId, "paper", JSON.stringify(this.settings)]
    );

    this.log("info", "starting paper trading", { sessionId });

    let tradesProcessed = 0;
    let fillsGenerated = 0;

    const subjects: string[] = [];
    if (this.settings.includeKalshi) {
      subjects.push("feedeater.kalshi.messageCreated");
    }
    if (this.settings.includePolymarket) {
      subjects.push("feedeater.polymarket.messageCreated");
    }

    for (const subject of subjects) {
      try {
        const sub = this.nats.subscribe(subject);
        this.subscription = sub;

        const processMessages = async () => {
          for await (const msg of sub) {
            if (!this.isRunning) break;

            try {
              const data = JSON.parse(this.sc.decode(msg.data));
              const trade = this.parseTradeFromNatsMessage(data, subject);
              if (!trade) continue;

              tradesProcessed++;
              this.lastPrices.set(trade.marketId, trade.price);

              const quote = this.generateQuote(trade.marketId, trade.price);
              this.quotes.push(quote);

              const fill = this.checkFill(trade, quote);
              if (fill) {
                this.updatePosition(fill);
                fillsGenerated++;

                await this.db.query(
                  `INSERT INTO mod_market_maker_sim.fills (id, session_id, market_id, side, price, size, notional_usd, pnl_usd, source, filled_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                  [fill.id, sessionId, fill.marketId, fill.side, fill.price, fill.size, fill.notionalUsd, fill.pnlUsd, fill.source, fill.timestamp]
                );
              }

              this.updateEquity(new Date());
            } catch (err) {
              this.log("warn", "failed to process NATS message", {
                err: err instanceof Error ? err.message : err,
              });
            }
          }
        };

        processMessages().catch((err) => {
          this.log("error", "NATS subscription error", {
            err: err instanceof Error ? err.message : err,
          });
        });
      } catch (err) {
        this.log("error", "failed to subscribe to NATS", {
          subject,
          err: err instanceof Error ? err.message : err,
        });
      }
    }

    await this.sleep(55000);
    this.isRunning = false;

    if (this.subscription) {
      this.subscription.unsubscribe();
    }

    const metrics = this.getMetrics();
    await this.db.query(
      `UPDATE mod_market_maker_sim.sessions
       SET metrics = $1
       WHERE id = $2`,
      [JSON.stringify(metrics), sessionId]
    );

    this.publishMetrics(metrics);

    return { sessionId, tradesProcessed, fillsGenerated };
  }

  private parseTradeFromNatsMessage(data: unknown, subject: string): TradeEvent | null {
    try {
      const msg = data as { message?: { tags?: Record<string, unknown>; createdAt?: string } };
      const tags = msg.message?.tags;
      if (!tags) return null;

      const source = subject.includes("kalshi") ? "kalshi" : "polymarket";

      if (source === "kalshi") {
        const ticker = tags.ticker as string;
        const lastPrice = tags.lastPrice as number;
        if (!ticker || !lastPrice) return null;

        return {
          id: uuidv5(`nats:kalshi:${ticker}:${Date.now()}`, UUID_NAMESPACE),
          marketId: `kalshi:${ticker}`,
          price: lastPrice,
          size: 1,
          side: "buy",
          notionalUsd: lastPrice,
          timestamp: new Date(msg.message?.createdAt ?? Date.now()),
          source: "kalshi",
        };
      } else {
        const marketId = tags.marketId as string;
        const price = tags.price as number;
        const size = tags.size as number;
        const side = tags.side as string;
        if (!marketId || !price) return null;

        return {
          id: uuidv5(`nats:polymarket:${marketId}:${Date.now()}`, UUID_NAMESPACE),
          marketId: `polymarket:${marketId}`,
          price,
          size: size ?? 1,
          side: side === "buy" ? "buy" : "sell",
          notionalUsd: price * (size ?? 1),
          timestamp: new Date(msg.message?.createdAt ?? Date.now()),
          source: "polymarket",
        };
      }
    } catch {
      return null;
    }
  }

  async reportStats(): Promise<PerformanceMetrics> {
    const metrics = this.getMetrics();

    const snapshotId = uuidv5(`metrics:${Date.now()}`, UUID_NAMESPACE);
    await this.db.query(
      `INSERT INTO mod_market_maker_sim.metrics_snapshots (id, session_id, metrics)
       VALUES ($1, $2, $3)`,
      [snapshotId, "current", JSON.stringify(metrics)]
    );

    this.publishMetrics(metrics);

    return metrics;
  }

  private publishMetrics(metrics: PerformanceMetrics): void {
    const messageId = uuidv5(`mmsim:metrics:${Date.now()}`, UUID_NAMESPACE);

    try {
      const normalized = NormalizedMessageSchema.parse({
        id: messageId,
        createdAt: new Date().toISOString(),
        source: { module: "market-maker-sim", stream: "metrics" },
        contextRef: { ownerModule: "market-maker-sim", sourceKey: "metrics" },
        Message: `MM Sim: P&L $${metrics.totalPnlUsd.toFixed(2)} | Fills: ${metrics.fillCount} | Sharpe: ${metrics.sharpeRatio.toFixed(2)}`,
        From: "MarketMakerSim",
        isDirectMention: false,
        isDigest: false,
        isSystemMessage: false,
        likes: 0,
        tags: {
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
      });

      const msgEvent = MessageCreatedEventSchema.parse({
        type: "MessageCreated",
        message: normalized,
      });

      this.nats.publish(subjectFor("market-maker-sim", "messageCreated"), this.sc.encode(JSON.stringify(msgEvent)));
    } catch (err) {
      this.log("warn", "failed to publish metrics", {
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
