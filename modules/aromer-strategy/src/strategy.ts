import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, Codec } from "nats";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

const UUID_NAMESPACE = "d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f90";

const VENUE_SUBJECTS: Record<string, string> = {
  kalshi: "feedeater.kalshi.messageCreated",
  polymarket: "feedeater.polymarket.messageCreated",
  coinbase: "feedeater.coinbase.messageCreated",
  kraken: "feedeater.kraken.messageCreated",
  binance: "feedeater.binance.messageCreated",
  uniswap: "feedeater.uniswap.messageCreated",
  "arbitrum-dex": "feedeater.arbitrum-dex.messageCreated",
};

const DEFAULT_VENUE_FEES_BPS: Record<string, number> = {
  kalshi: 7,
  polymarket: 2,
  coinbase: 60,
  kraken: 26,
  binance: 10,
  uniswap: 30,
  "arbitrum-dex": 30,
};

export type AromerStrategySettings = {
  enabled: boolean;
  minConfidence: number;
  venueWeights: Record<string, number>;
  positionSizeUsd: number;
  maxPositionSizeUsd: number;
  maxConcurrentPositions: number;
  maxDailyLossUsd: number;
  signalThresholdPct: number;
  signalDecayMs: number;
  slippageBps: number;
  feesBps: number;
  latencyMs: number;
  initialCapitalUsd: number;
  riskFreeRate: number;
};

export function parseAromerSettings(raw: Record<string, unknown>): AromerStrategySettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const minConfidence = raw.minConfidence ? Number(raw.minConfidence) : 0.6;
  const positionSizeUsd = raw.positionSizeUsd ? Number(raw.positionSizeUsd) : 1000;
  const maxPositionSizeUsd = raw.maxPositionSizeUsd ? Number(raw.maxPositionSizeUsd) : 5000;
  const maxConcurrentPositions = raw.maxConcurrentPositions ? Number(raw.maxConcurrentPositions) : 10;
  const maxDailyLossUsd = raw.maxDailyLossUsd ? Number(raw.maxDailyLossUsd) : 5000;
  const signalThresholdPct = raw.signalThresholdPct ? Number(raw.signalThresholdPct) : 0.5;
  const signalDecayMs = raw.signalDecayMs ? Number(raw.signalDecayMs) : 60000;
  const slippageBps = raw.slippageBps ? Number(raw.slippageBps) : 10;
  const feesBps = raw.feesBps ? Number(raw.feesBps) : 25;
  const latencyMs = raw.latencyMs ? Number(raw.latencyMs) : 200;
  const initialCapitalUsd = raw.initialCapitalUsd ? Number(raw.initialCapitalUsd) : 100000;
  const riskFreeRate = raw.riskFreeRate ? Number(raw.riskFreeRate) : 0.05;

  let venueWeights: Record<string, number> = {};
  try {
    const parsed = JSON.parse(String(raw.venueWeights ?? "{}"));
    if (typeof parsed === "object" && parsed !== null) {
      for (const [k, v] of Object.entries(parsed)) {
        venueWeights[k] = Number(v);
      }
    }
  } catch { /* use empty */ }

  return {
    enabled,
    minConfidence: clamp(minConfidence, 0, 1),
    venueWeights,
    positionSizeUsd: Math.max(0, positionSizeUsd),
    maxPositionSizeUsd: Math.max(0, maxPositionSizeUsd),
    maxConcurrentPositions: Math.max(1, maxConcurrentPositions),
    maxDailyLossUsd: Math.max(0, maxDailyLossUsd),
    signalThresholdPct: Math.max(0, signalThresholdPct),
    signalDecayMs: Math.max(0, signalDecayMs),
    slippageBps: Math.max(0, slippageBps),
    feesBps: Math.max(0, feesBps),
    latencyMs: Math.max(0, latencyMs),
    initialCapitalUsd: Math.max(0, initialCapitalUsd),
    riskFreeRate: clamp(riskFreeRate, 0, 1),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

type EventMapping = {
  id: string;
  venue_a: string;
  ticker_a: string;
  title_a: string;
  venue_b: string;
  ticker_b: string;
  title_b: string;
  underlying_asset: string | null;
  confidence: number;
  method: string;
  event_type: string;
};

export type Signal = {
  id: string;
  createdAt: Date;
  leaderVenue: string;
  leaderTicker: string;
  laggerVenue: string;
  laggerTicker: string;
  mappingId: string;
  confidence: number;
  direction: "up" | "down";
  movePct: number;
  weight: number;
  expired: boolean;
};

export type PaperOrder = {
  id: string;
  signalId: string;
  venue: string;
  ticker: string;
  side: "buy" | "sell";
  sizeUsd: number;
  entryPrice: number;
  fillPrice: number;
  feesUsd: number;
  slippageUsd: number;
  latencyMs: number;
  filledAt: Date;
};

export type Position = {
  id: string;
  venue: string;
  ticker: string;
  side: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  sizeUsd: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: Date;
  closedAt: Date | null;
};

export type PerformanceMetrics = {
  totalPnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  sharpeRatio: number;
  winRate: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  totalTrades: number;
  openPositions: number;
  signalsGenerated: number;
  signalsActedOn: number;
  totalVolumeUsd: number;
  dailyPnlUsd: number;
  killSwitchTriggered: boolean;
  killSwitchReason: string | null;
  perVenueEdge: Record<string, VenueEdge>;
};

export type VenueEdge = {
  venue: string;
  trades: number;
  pnlUsd: number;
  winRate: number;
  avgReturnPct: number;
  signalCount: number;
};

export class AromerStrategy {
  private signals: Signal[] = [];
  private orders: PaperOrder[] = [];
  private positions: Map<string, Position> = new Map();
  private closedPositions: Position[] = [];
  private lastPrices: Map<string, number> = new Map();
  private mappings: EventMapping[] = [];
  private mappingsByVenueTicker: Map<string, EventMapping[]> = new Map();

  private capital: number;
  private peakEquity: number;
  private maxDrawdown: number = 0;
  private dailyReturns: number[] = [];
  private lastEquityDate: string = "";
  private dailyPnlStart: number;
  private killSwitchActive: boolean = false;
  private killSwitchReason: string | null = null;
  private isRunning: boolean = false;

  private venueSignalCounts: Record<string, number> = {};
  private venueTradesWon: Record<string, number> = {};
  private venueTradesTotal: Record<string, number> = {};
  private venuePnl: Record<string, number> = {};
  private venueReturns: Record<string, number[]> = {};

  constructor(
    private readonly settings: AromerStrategySettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: Codec<string>
  ) {
    this.capital = settings.initialCapitalUsd;
    this.peakEquity = settings.initialCapitalUsd;
    this.dailyPnlStart = settings.initialCapitalUsd;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.aromer-strategy.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "aromer-strategy",
            source: "strategy",
            at: new Date().toISOString(),
            message,
            meta,
          })
        )
      );
    } catch { /* ignore */ }
  }

  async ensureSchema(): Promise<void> {
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_aromer_strategy");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_aromer_strategy.sessions (
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
      CREATE TABLE IF NOT EXISTS mod_aromer_strategy.signals (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        leader_venue text NOT NULL,
        leader_ticker text NOT NULL,
        lagger_venue text NOT NULL,
        lagger_ticker text NOT NULL,
        mapping_id text NOT NULL,
        confidence numeric NOT NULL,
        direction text NOT NULL,
        move_pct numeric NOT NULL,
        weight numeric NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS aromer_signals_session_idx ON mod_aromer_strategy.signals (session_id, created_at)`
    );

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_aromer_strategy.orders (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        signal_id text NOT NULL,
        venue text NOT NULL,
        ticker text NOT NULL,
        side text NOT NULL,
        size_usd numeric NOT NULL,
        entry_price numeric NOT NULL,
        fill_price numeric NOT NULL,
        fees_usd numeric NOT NULL,
        slippage_usd numeric NOT NULL,
        latency_ms numeric NOT NULL,
        filled_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS aromer_orders_session_idx ON mod_aromer_strategy.orders (session_id, filled_at)`
    );

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_aromer_strategy.positions (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        venue text NOT NULL,
        ticker text NOT NULL,
        side text NOT NULL,
        entry_price numeric NOT NULL,
        current_price numeric NOT NULL,
        size_usd numeric NOT NULL,
        unrealized_pnl numeric NOT NULL,
        realized_pnl numeric NOT NULL,
        opened_at timestamptz NOT NULL,
        closed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS aromer_positions_session_idx ON mod_aromer_strategy.positions (session_id)`
    );

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_aromer_strategy.metrics_snapshots (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        metrics jsonb NOT NULL,
        snapshot_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS aromer_metrics_session_idx ON mod_aromer_strategy.metrics_snapshots (session_id, snapshot_at)`
    );
  }

  async loadMappings(): Promise<number> {
    try {
      const result = await this.db.query<EventMapping>(
        `SELECT id, venue_a, ticker_a, title_a, venue_b, ticker_b, title_b,
                underlying_asset, confidence, method, event_type
         FROM mod_event_resolver.event_mappings
         WHERE confidence >= $1
         ORDER BY confidence DESC`,
        [this.settings.minConfidence]
      );
      this.mappings = result.rows;

      this.mappingsByVenueTicker.clear();
      for (const m of this.mappings) {
        const keyA = `${m.venue_a}:${m.ticker_a}`;
        const keyB = `${m.venue_b}:${m.ticker_b}`;
        if (!this.mappingsByVenueTicker.has(keyA)) this.mappingsByVenueTicker.set(keyA, []);
        if (!this.mappingsByVenueTicker.has(keyB)) this.mappingsByVenueTicker.set(keyB, []);
        this.mappingsByVenueTicker.get(keyA)!.push(m);
        this.mappingsByVenueTicker.get(keyB)!.push(m);
      }

      this.log("info", "loaded event-resolver mappings", {
        count: this.mappings.length,
        minConfidence: this.settings.minConfidence,
      });
      return this.mappings.length;
    } catch (err) {
      this.log("warn", "failed to load event-resolver mappings (schema may not exist)", {
        err: err instanceof Error ? err.message : err,
      });
      return 0;
    }
  }

  async startPaperTrading(): Promise<{
    sessionId: string;
    tradesProcessed: number;
    signalsGenerated: number;
    ordersPlaced: number;
  }> {
    this.isRunning = true;
    const sessionId = uuidv5(`aromer:paper:${Date.now()}`, UUID_NAMESPACE);

    await this.db.query(
      `INSERT INTO mod_aromer_strategy.sessions (id, mode, settings) VALUES ($1, $2, $3)`,
      [sessionId, "paper", JSON.stringify(this.settings)]
    );

    this.log("info", "starting AROMER paper trading", { sessionId });

    await this.loadMappings();

    let tradesProcessed = 0;
    let signalsGenerated = 0;
    let ordersPlaced = 0;

    const subjects = Object.values(VENUE_SUBJECTS);
    const subscriptions: AsyncIterable<{ data: Uint8Array }>[] = [];

    for (const subject of subjects) {
      try {
        const sub = this.nats.subscribe(subject);
        subscriptions.push(sub);
      } catch (err) {
        this.log("debug", `could not subscribe to ${subject}`, {
          err: err instanceof Error ? err.message : err,
        });
      }
    }

    const processSubscription = async (sub: AsyncIterable<{ data: Uint8Array }>) => {
      for await (const msg of sub) {
        if (!this.isRunning) break;
        try {
          const data = JSON.parse(this.sc.decode(msg.data)) as Record<string, unknown>;
          const priceUpdate = this.parsePriceUpdate(data);
          if (!priceUpdate) continue;

          tradesProcessed++;

          const prevPrice = this.lastPrices.get(`${priceUpdate.venue}:${priceUpdate.ticker}`);
          this.lastPrices.set(`${priceUpdate.venue}:${priceUpdate.ticker}`, priceUpdate.price);

          this.updateOpenPositionPrices(priceUpdate.venue, priceUpdate.ticker, priceUpdate.price);

          if (prevPrice === undefined || prevPrice === 0) continue;

          const movePct = ((priceUpdate.price - prevPrice) / prevPrice) * 100;
          if (Math.abs(movePct) < this.settings.signalThresholdPct) continue;

          const newSignals = this.generateSignals(
            priceUpdate.venue,
            priceUpdate.ticker,
            priceUpdate.price,
            movePct
          );

          for (const signal of newSignals) {
            signalsGenerated++;
            this.signals.push(signal);

            if (this.killSwitchActive) continue;
            this.checkKillSwitch();
            if (this.killSwitchActive) continue;

            const order = this.executeSignal(signal, sessionId);
            if (order) {
              ordersPlaced++;
              this.orders.push(order);
              await this.persistOrder(sessionId, order);
              await this.persistSignal(sessionId, signal);
            }
          }
        } catch (err) {
          this.log("debug", "failed to process NATS message", {
            err: err instanceof Error ? err.message : err,
          });
        }
      }
    };

    for (const sub of subscriptions) {
      processSubscription(sub).catch((err) => {
        this.log("error", "subscription processing error", {
          err: err instanceof Error ? err.message : err,
        });
      });
    }

    await this.sleep(55000);
    this.isRunning = false;

    this.expireOldSignals();
    const metrics = this.getMetrics();

    await this.db.query(
      `UPDATE mod_aromer_strategy.sessions SET metrics = $1, ended_at = now(), status = 'completed' WHERE id = $2`,
      [JSON.stringify(metrics), sessionId]
    );

    this.publishMetrics(metrics);

    return { sessionId, tradesProcessed, signalsGenerated, ordersPlaced };
  }

  async runBacktest(params: {
    startTime: Date;
    endTime: Date;
  }): Promise<{
    sessionId: string;
    metrics: PerformanceMetrics;
    tradesProcessed: number;
    signalsGenerated: number;
    ordersPlaced: number;
    durationMs: number;
  }> {
    const sessionId = uuidv5(`aromer:backtest:${Date.now()}`, UUID_NAMESPACE);
    const backtestStart = Date.now();

    await this.db.query(
      `INSERT INTO mod_aromer_strategy.sessions (id, mode, settings) VALUES ($1, $2, $3)`,
      [sessionId, "backtest", JSON.stringify(this.settings)]
    );

    this.log("info", "starting AROMER backtest", {
      sessionId,
      startTime: params.startTime.toISOString(),
      endTime: params.endTime.toISOString(),
    });

    await this.loadMappings();

    const allTrades = await this.fetchHistoricalTrades(params.startTime, params.endTime);
    allTrades.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    this.log("info", "loaded historical trades for backtest", { count: allTrades.length });

    let tradesProcessed = 0;
    let signalsGenerated = 0;
    let ordersPlaced = 0;

    for (const trade of allTrades) {
      const key = `${trade.venue}:${trade.ticker}`;
      const prevPrice = this.lastPrices.get(key);
      this.lastPrices.set(key, trade.price);
      this.updateOpenPositionPrices(trade.venue, trade.ticker, trade.price);

      tradesProcessed++;

      if (prevPrice === undefined || prevPrice === 0) continue;

      const movePct = ((trade.price - prevPrice) / prevPrice) * 100;
      if (Math.abs(movePct) < this.settings.signalThresholdPct) continue;

      const newSignals = this.generateSignals(trade.venue, trade.ticker, trade.price, movePct);
      for (const signal of newSignals) {
        signalsGenerated++;
        this.signals.push(signal);

        if (this.killSwitchActive) continue;
        this.checkKillSwitch();
        if (this.killSwitchActive) continue;

        const order = this.executeSignal(signal, sessionId);
        if (order) {
          ordersPlaced++;
          this.orders.push(order);
        }
      }

      this.updateEquity(trade.timestamp);
    }

    const durationMs = Date.now() - backtestStart;
    const metrics = this.getMetrics();

    await this.db.query(
      `UPDATE mod_aromer_strategy.sessions SET metrics = $1, ended_at = now(), status = 'completed' WHERE id = $2`,
      [JSON.stringify(metrics), sessionId]
    );

    this.publishMetrics(metrics);
    this.log("info", "backtest complete", { durationMs, metrics });

    return { sessionId, metrics, tradesProcessed, signalsGenerated, ordersPlaced, durationMs };
  }

  private generateSignals(
    venue: string,
    ticker: string,
    price: number,
    movePct: number
  ): Signal[] {
    const key = `${venue}:${ticker}`;
    const mappings = this.mappingsByVenueTicker.get(key);
    if (!mappings || mappings.length === 0) return [];

    const direction: "up" | "down" = movePct > 0 ? "up" : "down";
    const signals: Signal[] = [];
    const venueWeight = this.settings.venueWeights[venue] ?? 1.0;

    this.venueSignalCounts[venue] = (this.venueSignalCounts[venue] ?? 0) + 1;

    for (const mapping of mappings) {
      const isVenueA = mapping.venue_a === venue && mapping.ticker_a === ticker;
      const laggerVenue = isVenueA ? mapping.venue_b : mapping.venue_a;
      const laggerTicker = isVenueA ? mapping.ticker_b : mapping.ticker_a;

      const laggerKey = `${laggerVenue}:${laggerTicker}`;
      const laggerPrice = this.lastPrices.get(laggerKey);

      if (laggerPrice !== undefined) {
        const laggerMovePct = price !== 0 ? ((laggerPrice - price) / price) * 100 : 0;
        if (Math.abs(laggerMovePct) >= this.settings.signalThresholdPct) continue;
      }

      const weight = mapping.confidence * venueWeight * (Math.abs(movePct) / this.settings.signalThresholdPct);

      signals.push({
        id: uuidv5(`signal:${key}:${laggerKey}:${Date.now()}`, UUID_NAMESPACE),
        createdAt: new Date(),
        leaderVenue: venue,
        leaderTicker: ticker,
        laggerVenue,
        laggerTicker,
        mappingId: mapping.id,
        confidence: mapping.confidence,
        direction,
        movePct: Math.abs(movePct),
        weight: Math.min(weight, 10),
        expired: false,
      });
    }

    return signals;
  }

  private executeSignal(signal: Signal, _sessionId: string): PaperOrder | null {
    if (this.positions.size >= this.settings.maxConcurrentPositions) return null;

    const posKey = `${signal.laggerVenue}:${signal.laggerTicker}:${signal.direction}`;
    if (this.positions.has(posKey)) return null;

    const basePrice = this.lastPrices.get(`${signal.laggerVenue}:${signal.laggerTicker}`);
    if (basePrice === undefined || basePrice <= 0) return null;

    const side: "buy" | "sell" = signal.direction === "up" ? "buy" : "sell";

    const slippagePct = this.settings.slippageBps / 10000;
    const fillPrice = side === "buy"
      ? basePrice * (1 + slippagePct)
      : basePrice * (1 - slippagePct);

    const venueFeesBps = DEFAULT_VENUE_FEES_BPS[signal.laggerVenue] ?? this.settings.feesBps;
    const feesPct = venueFeesBps / 10000;

    const sizeUsd = Math.min(this.settings.positionSizeUsd, this.settings.maxPositionSizeUsd);
    const feesUsd = sizeUsd * feesPct;
    const slippageUsd = sizeUsd * slippagePct;

    const order: PaperOrder = {
      id: uuidv5(`order:${signal.id}:${Date.now()}`, UUID_NAMESPACE),
      signalId: signal.id,
      venue: signal.laggerVenue,
      ticker: signal.laggerTicker,
      side,
      sizeUsd,
      entryPrice: basePrice,
      fillPrice,
      feesUsd,
      slippageUsd,
      latencyMs: this.settings.latencyMs,
      filledAt: new Date(),
    };

    const position: Position = {
      id: uuidv5(`pos:${posKey}:${Date.now()}`, UUID_NAMESPACE),
      venue: signal.laggerVenue,
      ticker: signal.laggerTicker,
      side: side === "buy" ? "long" : "short",
      entryPrice: fillPrice,
      currentPrice: fillPrice,
      sizeUsd,
      unrealizedPnl: -feesUsd - slippageUsd,
      realizedPnl: 0,
      openedAt: new Date(),
      closedAt: null,
    };

    this.positions.set(posKey, position);
    this.capital -= feesUsd;

    return order;
  }

  private updateOpenPositionPrices(venue: string, ticker: string, currentPrice: number): void {
    for (const [key, pos] of this.positions.entries()) {
      if (pos.venue !== venue || pos.ticker !== ticker) continue;

      pos.currentPrice = currentPrice;
      const priceChange = currentPrice - pos.entryPrice;
      const pnlMultiplier = pos.side === "long" ? 1 : -1;
      const quantity = pos.sizeUsd / pos.entryPrice;
      pos.unrealizedPnl = quantity * priceChange * pnlMultiplier;

      const targetReturnPct = pos.side === "long"
        ? (currentPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - currentPrice) / pos.entryPrice;

      if (targetReturnPct > 0.02 || targetReturnPct < -0.01) {
        const venueFeesBps = DEFAULT_VENUE_FEES_BPS[pos.venue] ?? this.settings.feesBps;
        const exitFeesUsd = pos.sizeUsd * (venueFeesBps / 10000);
        const realizedPnl = pos.unrealizedPnl - exitFeesUsd;

        pos.realizedPnl = realizedPnl;
        pos.closedAt = new Date();
        this.closedPositions.push(pos);
        this.capital += realizedPnl;
        this.positions.delete(key);

        this.venueTradesTotal[pos.venue] = (this.venueTradesTotal[pos.venue] ?? 0) + 1;
        this.venuePnl[pos.venue] = (this.venuePnl[pos.venue] ?? 0) + realizedPnl;
        if (realizedPnl > 0) {
          this.venueTradesWon[pos.venue] = (this.venueTradesWon[pos.venue] ?? 0) + 1;
        }
        if (!this.venueReturns[pos.venue]) this.venueReturns[pos.venue] = [];
        this.venueReturns[pos.venue]!.push(targetReturnPct * 100);
      }
    }
  }

  private checkKillSwitch(): void {
    const equity = this.getCurrentEquity();
    const dailyLoss = this.dailyPnlStart - equity;

    if (dailyLoss >= this.settings.maxDailyLossUsd) {
      this.killSwitchActive = true;
      this.killSwitchReason = `max daily loss exceeded: $${dailyLoss.toFixed(2)} >= $${this.settings.maxDailyLossUsd}`;
      this.log("warn", "KILL SWITCH: max daily loss", { dailyLoss, limit: this.settings.maxDailyLossUsd });
      return;
    }

    for (const pos of this.positions.values()) {
      if (pos.sizeUsd > this.settings.maxPositionSizeUsd) {
        this.killSwitchActive = true;
        this.killSwitchReason = `position size exceeded: $${pos.sizeUsd.toFixed(2)} on ${pos.venue}:${pos.ticker}`;
        this.log("warn", "KILL SWITCH: max position size", { positionSize: pos.sizeUsd, limit: this.settings.maxPositionSizeUsd });
        return;
      }
    }

    if (this.positions.size > this.settings.maxConcurrentPositions) {
      this.killSwitchActive = true;
      this.killSwitchReason = `max concurrent positions exceeded: ${this.positions.size} > ${this.settings.maxConcurrentPositions}`;
      this.log("warn", "KILL SWITCH: max concurrent positions", {
        openPositions: this.positions.size,
        limit: this.settings.maxConcurrentPositions,
      });
    }
  }

  private getCurrentEquity(): number {
    const totalUnrealized = Array.from(this.positions.values()).reduce((sum, p) => sum + p.unrealizedPnl, 0);
    return this.capital + totalUnrealized;
  }

  private updateEquity(timestamp: Date): void {
    const equity = this.getCurrentEquity();

    if (equity > this.peakEquity) {
      this.peakEquity = equity;
    }
    const drawdown = this.peakEquity - equity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }

    const dateStr = timestamp.toISOString().slice(0, 10);
    if (dateStr !== this.lastEquityDate) {
      if (this.lastEquityDate !== "") {
        const prevEquity = this.dailyPnlStart;
        if (prevEquity > 0) {
          this.dailyReturns.push((equity - prevEquity) / prevEquity);
        }
      }
      this.lastEquityDate = dateStr;
      this.dailyPnlStart = equity;
    }
  }

  private calculateSharpeRatio(): number {
    if (this.dailyReturns.length < 2) return 0;

    const avgReturn = this.dailyReturns.reduce((a, b) => a + b, 0) / this.dailyReturns.length;
    const variance = this.dailyReturns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / this.dailyReturns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    const dailyRiskFreeRate = this.settings.riskFreeRate / 252;
    return ((avgReturn - dailyRiskFreeRate) / stdDev) * Math.sqrt(252);
  }

  getMetrics(): PerformanceMetrics {
    const totalRealized = this.closedPositions.reduce((s, p) => s + p.realizedPnl, 0);
    const totalUnrealized = Array.from(this.positions.values()).reduce((s, p) => s + p.unrealizedPnl, 0);
    const equity = this.getCurrentEquity();
    const dailyPnl = equity - this.dailyPnlStart;

    const winCount = this.closedPositions.filter((p) => p.realizedPnl > 0).length;
    const totalClosed = this.closedPositions.length;
    const totalVolume = this.orders.reduce((s, o) => s + o.sizeUsd, 0);

    const maxDrawdownPct = this.peakEquity > 0 ? (this.maxDrawdown / this.peakEquity) * 100 : 0;

    const perVenueEdge: Record<string, VenueEdge> = {};
    const allVenues = new Set([
      ...Object.keys(this.venueSignalCounts),
      ...Object.keys(this.venueTradesTotal),
    ]);

    for (const venue of allVenues) {
      const trades = this.venueTradesTotal[venue] ?? 0;
      const won = this.venueTradesWon[venue] ?? 0;
      const pnl = this.venuePnl[venue] ?? 0;
      const returns = this.venueReturns[venue] ?? [];
      const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

      perVenueEdge[venue] = {
        venue,
        trades,
        pnlUsd: pnl,
        winRate: trades > 0 ? won / trades : 0,
        avgReturnPct: avgReturn,
        signalCount: this.venueSignalCounts[venue] ?? 0,
      };
    }

    return {
      totalPnlUsd: totalRealized + totalUnrealized,
      realizedPnlUsd: totalRealized,
      unrealizedPnlUsd: totalUnrealized,
      sharpeRatio: this.calculateSharpeRatio(),
      winRate: totalClosed > 0 ? winCount / totalClosed : 0,
      maxDrawdownUsd: this.maxDrawdown,
      maxDrawdownPct,
      totalTrades: totalClosed,
      openPositions: this.positions.size,
      signalsGenerated: this.signals.length,
      signalsActedOn: this.orders.length,
      totalVolumeUsd: totalVolume,
      dailyPnlUsd: dailyPnl,
      killSwitchTriggered: this.killSwitchActive,
      killSwitchReason: this.killSwitchReason,
      perVenueEdge,
    };
  }

  async reportMetrics(): Promise<PerformanceMetrics> {
    const metrics = this.getMetrics();

    const snapshotId = uuidv5(`aromer:metrics:${Date.now()}`, UUID_NAMESPACE);
    await this.db.query(
      `INSERT INTO mod_aromer_strategy.metrics_snapshots (id, session_id, metrics) VALUES ($1, $2, $3)`,
      [snapshotId, "current", JSON.stringify(metrics)]
    );

    this.publishMetrics(metrics);
    return metrics;
  }

  private publishMetrics(metrics: PerformanceMetrics): void {
    const messageId = uuidv5(`aromer:msg:${Date.now()}`, UUID_NAMESPACE);

    try {
      const venueEdgeSummary = Object.entries(metrics.perVenueEdge)
        .map(([v, e]) => `${v}: $${e.pnlUsd.toFixed(2)} (${(e.winRate * 100).toFixed(0)}% WR)`)
        .join(" | ");

      const normalized = NormalizedMessageSchema.parse({
        id: messageId,
        createdAt: new Date().toISOString(),
        source: { module: "aromer-strategy", stream: "metrics" },
        contextRef: { ownerModule: "aromer-strategy", sourceKey: "metrics" },
        Message: `AROMER: P&L $${metrics.totalPnlUsd.toFixed(2)} | Sharpe: ${metrics.sharpeRatio.toFixed(2)} | WR: ${(metrics.winRate * 100).toFixed(0)}% | DD: $${metrics.maxDrawdownUsd.toFixed(2)} | ${venueEdgeSummary}`,
        From: "AromerStrategy",
        isDirectMention: false,
        isDigest: false,
        isSystemMessage: false,
        likes: 0,
        tags: {
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
      });

      const msgEvent = MessageCreatedEventSchema.parse({
        type: "MessageCreated",
        message: normalized,
      });

      this.nats.publish(
        subjectFor("aromer-strategy", "messageCreated"),
        this.sc.encode(JSON.stringify(msgEvent))
      );
    } catch (err) {
      this.log("warn", "failed to publish metrics", {
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  private parsePriceUpdate(data: unknown): { venue: string; ticker: string; price: number } | null {
    try {
      const msg = data as { message?: { tags?: Record<string, unknown>; source?: { module?: string } } };
      const tags = msg.message?.tags;
      const source = msg.message?.source?.module;
      if (!tags || !source) return null;

      if (source === "kalshi") {
        const ticker = tags.ticker as string;
        const price = tags.lastPrice as number;
        if (!ticker || !price) return null;
        return { venue: "kalshi", ticker, price };
      }

      if (source === "polymarket") {
        const marketId = tags.marketId as string;
        const price = tags.price as number;
        if (!marketId || !price) return null;
        return { venue: "polymarket", ticker: marketId, price };
      }

      if (source === "coinbase") {
        const pair = tags.pair as string ?? tags.product_id as string;
        const price = tags.price as number ?? tags.lastPrice as number;
        if (!pair || !price) return null;
        return { venue: "coinbase", ticker: pair, price };
      }

      if (source === "kraken") {
        const pair = tags.pair as string;
        const price = tags.price as number;
        if (!pair || !price) return null;
        return { venue: "kraken", ticker: pair, price };
      }

      if (source === "binance") {
        const symbol = tags.symbol as string;
        const price = tags.price as number;
        if (!symbol || !price) return null;
        return { venue: "binance", ticker: symbol, price };
      }

      if (source === "uniswap") {
        const pool = tags.pool as string ?? tags.pair as string;
        const price = tags.price as number;
        if (!pool || !price) return null;
        return { venue: "uniswap", ticker: pool, price };
      }

      if (source === "arbitrum-dex") {
        const pool = tags.pool as string ?? tags.pair as string;
        const price = tags.price as number;
        if (!pool || !price) return null;
        return { venue: "arbitrum-dex", ticker: pool, price };
      }

      return null;
    } catch {
      return null;
    }
  }

  private async fetchHistoricalTrades(
    startTime: Date,
    endTime: Date
  ): Promise<{ venue: string; ticker: string; price: number; timestamp: Date }[]> {
    const trades: { venue: string; ticker: string; price: number; timestamp: Date }[] = [];

    try {
      const kalshiResult = await this.db.query<{
        ticker: string;
        yes_price: number;
        created_at: Date;
      }>(
        `SELECT ticker, yes_price, created_at
         FROM mod_kalshi.trades
         WHERE created_at >= $1 AND created_at <= $2
         ORDER BY created_at ASC`,
        [startTime, endTime]
      );
      for (const row of kalshiResult.rows) {
        trades.push({ venue: "kalshi", ticker: row.ticker, price: row.yes_price, timestamp: row.created_at });
      }
    } catch { /* schema may not exist */ }

    try {
      const polyResult = await this.db.query<{
        market_id: string;
        price: number;
        timestamp_ms: bigint;
      }>(
        `SELECT market_id, price, timestamp_ms
         FROM mod_polymarket.trades
         WHERE created_at >= $1 AND created_at <= $2
         ORDER BY timestamp_ms ASC`,
        [startTime, endTime]
      );
      for (const row of polyResult.rows) {
        trades.push({
          venue: "polymarket",
          ticker: row.market_id,
          price: Number(row.price),
          timestamp: new Date(Number(row.timestamp_ms)),
        });
      }
    } catch { /* schema may not exist */ }

    try {
      const result = await this.db.query<{
        id: string;
        "sourceModule": string;
        "createdAt": Date;
        "tagsJson": Record<string, unknown> | null;
      }>(
        `SELECT id, "sourceModule", "createdAt", "tagsJson"
         FROM bus_messages
         WHERE "createdAt" >= $1 AND "createdAt" <= $2
           AND "sourceModule" IN ('coinbase', 'kraken', 'binance', 'uniswap', 'arbitrum-dex')
         ORDER BY "createdAt" ASC`,
        [startTime, endTime]
      );
      for (const row of result.rows) {
        const tags = row.tagsJson;
        if (!tags) continue;
        const venue = row.sourceModule;
        const ticker = (tags.pair ?? tags.symbol ?? tags.pool ?? tags.product_id) as string;
        const price = (tags.price ?? tags.lastPrice) as number;
        if (!ticker || !price) continue;
        trades.push({ venue, ticker, price, timestamp: row.createdAt });
      }
    } catch { /* bus_messages may be empty */ }

    return trades;
  }

  private expireOldSignals(): void {
    const now = Date.now();
    for (const signal of this.signals) {
      if (!signal.expired && now - signal.createdAt.getTime() > this.settings.signalDecayMs) {
        signal.expired = true;
      }
    }
  }

  private async persistSignal(sessionId: string, signal: Signal): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO mod_aromer_strategy.signals
         (id, session_id, leader_venue, leader_ticker, lagger_venue, lagger_ticker, mapping_id, confidence, direction, move_pct, weight)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          signal.id, sessionId, signal.leaderVenue, signal.leaderTicker,
          signal.laggerVenue, signal.laggerTicker, signal.mappingId,
          signal.confidence, signal.direction, signal.movePct, signal.weight,
        ]
      );
    } catch (err) {
      this.log("debug", "failed to persist signal", { err: err instanceof Error ? err.message : err });
    }
  }

  private async persistOrder(sessionId: string, order: PaperOrder): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO mod_aromer_strategy.orders
         (id, session_id, signal_id, venue, ticker, side, size_usd, entry_price, fill_price, fees_usd, slippage_usd, latency_ms, filled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          order.id, sessionId, order.signalId, order.venue, order.ticker,
          order.side, order.sizeUsd, order.entryPrice, order.fillPrice,
          order.feesUsd, order.slippageUsd, order.latencyMs, order.filledAt,
        ]
      );
    } catch (err) {
      this.log("debug", "failed to persist order", { err: err instanceof Error ? err.message : err });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
