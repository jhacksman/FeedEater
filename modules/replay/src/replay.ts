import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection } from "nats";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

type StringCodecLike = {
  encode(s: string): Uint8Array;
  decode(b: Uint8Array): string;
};

export type ReplaySettings = {
  enabled: boolean;
  replaySpeed: number;
  startTime: string;
  endTime: string;
  includeKalshi: boolean;
  includePolymarket: boolean;
  replayChannelPrefix: string;
};

const UUID_NAMESPACE = "d4e6f8a0-3c5d-7e9f-1a2b-4c6d8e0f2a3b";

export function parseReplaySettingsFromInternal(raw: Record<string, unknown>): ReplaySettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const replaySpeed = raw.replaySpeed ? Number(raw.replaySpeed) : 10;
  const startTime = String(raw.startTime ?? "");
  const endTime = String(raw.endTime ?? "");
  const includeKalshi = String(raw.includeKalshi ?? "true") !== "false";
  const includePolymarket = String(raw.includePolymarket ?? "true") !== "false";
  const replayChannelPrefix = String(raw.replayChannelPrefix ?? "replay");

  if (!Number.isFinite(replaySpeed) || replaySpeed <= 0) {
    throw new Error('Replay setting "replaySpeed" must be a positive number');
  }

  return {
    enabled,
    replaySpeed,
    startTime,
    endTime,
    includeKalshi,
    includePolymarket,
    replayChannelPrefix,
  };
}

export interface ReplayEvent {
  timestamp: Date;
  source: "kalshi" | "polymarket";
  eventType: "trade" | "market_update";
  data: Record<string, unknown>;
}

export interface LeadLagResult {
  venue1: string;
  venue2: string;
  lagMs: number;
  correlation: number;
  sampleCount: number;
}

export interface ReplayStats {
  totalEvents: number;
  eventsBySource: Record<string, number>;
  replayDurationMs: number;
  realTimeDurationMs: number;
  speedMultiplier: number;
  leadLagResults: LeadLagResult[];
  latencyDistribution: {
    p50: number;
    p90: number;
    p99: number;
    mean: number;
  };
}

export class ReplayEngine {
  private requestTimeoutMs: number;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.replay.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "replay",
            source: "engine",
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
    private readonly settings: ReplaySettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodecLike
  ) {
    this.requestTimeoutMs = 30_000;
  }

  async ensureSchema(): Promise<void> {
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_replay");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_replay.sessions (
        id text PRIMARY KEY,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz,
        replay_start timestamptz NOT NULL,
        replay_end timestamptz NOT NULL,
        speed_multiplier numeric NOT NULL,
        total_events int DEFAULT 0,
        status text DEFAULT 'running',
        stats jsonb
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_replay.lead_lag_analysis (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        venue1 text NOT NULL,
        venue2 text NOT NULL,
        lag_ms numeric NOT NULL,
        correlation numeric,
        sample_count int NOT NULL,
        analyzed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS replay_sessions_status_idx ON mod_replay.sessions (status)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS replay_leadlag_session_idx ON mod_replay.lead_lag_analysis (session_id)`);
  }

  private async fetchKalshiTrades(startTime: Date, endTime: Date): Promise<ReplayEvent[]> {
    const result = await this.db.query<{
      id: string;
      ticker: string;
      count: number;
      yes_price: number;
      taker_side: string;
      created_at: Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, ticker, count, yes_price, taker_side, created_at, payload
       FROM mod_kalshi.trades
       WHERE created_at >= $1 AND created_at <= $2
       ORDER BY created_at ASC`,
      [startTime, endTime]
    );

    return result.rows.map((row) => ({
      timestamp: new Date(row.created_at),
      source: "kalshi" as const,
      eventType: "trade" as const,
      data: {
        id: row.id,
        ticker: row.ticker,
        count: row.count,
        yesPrice: row.yes_price,
        takerSide: row.taker_side,
        ...row.payload,
      },
    }));
  }

  private async fetchKalshiMarkets(startTime: Date, endTime: Date): Promise<ReplayEvent[]> {
    const result = await this.db.query<{
      ticker: string;
      title: string;
      last_price: number;
      yes_bid: number;
      yes_ask: number;
      volume_24h: number;
      collected_at: Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT ticker, title, last_price, yes_bid, yes_ask, volume_24h, collected_at, payload
       FROM mod_kalshi.markets
       WHERE collected_at >= $1 AND collected_at <= $2
       ORDER BY collected_at ASC`,
      [startTime, endTime]
    );

    return result.rows.map((row) => ({
      timestamp: new Date(row.collected_at),
      source: "kalshi" as const,
      eventType: "market_update" as const,
      data: {
        ticker: row.ticker,
        title: row.title,
        lastPrice: row.last_price,
        yesBid: row.yes_bid,
        yesAsk: row.yes_ask,
        volume24h: row.volume_24h,
        ...row.payload,
      },
    }));
  }

  private async fetchPolymarketMarkets(startTime: Date, endTime: Date): Promise<ReplayEvent[]> {
    const result = await this.db.query<{
      id: string;
      event_id: string;
      question: string;
      outcome_prices: number[] | null;
      volume_24h: number;
      collected_at: Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, event_id, question, outcome_prices, volume_24h, collected_at, payload
       FROM mod_polymarket.markets
       WHERE collected_at >= $1 AND collected_at <= $2
       ORDER BY collected_at ASC`,
      [startTime, endTime]
    );

    return result.rows.map((row) => ({
      timestamp: new Date(row.collected_at),
      source: "polymarket" as const,
      eventType: "market_update" as const,
      data: {
        id: row.id,
        eventId: row.event_id,
        question: row.question,
        outcomePrices: row.outcome_prices,
        volume24h: row.volume_24h,
        ...row.payload,
      },
    }));
  }

  private async fetchAllEvents(startTime: Date, endTime: Date): Promise<ReplayEvent[]> {
    const events: ReplayEvent[] = [];

    if (this.settings.includeKalshi) {
      try {
        const kalshiTrades = await this.fetchKalshiTrades(startTime, endTime);
        const kalshiMarkets = await this.fetchKalshiMarkets(startTime, endTime);
        events.push(...kalshiTrades, ...kalshiMarkets);
        this.log("info", "fetched kalshi events", {
          trades: kalshiTrades.length,
          markets: kalshiMarkets.length,
        });
      } catch (err) {
        this.log("warn", "failed to fetch kalshi events (schema may not exist)", {
          err: err instanceof Error ? err.message : err,
        });
      }
    }

    if (this.settings.includePolymarket) {
      try {
        const polymarketMarkets = await this.fetchPolymarketMarkets(startTime, endTime);
        events.push(...polymarketMarkets);
        this.log("info", "fetched polymarket events", { markets: polymarketMarkets.length });
      } catch (err) {
        this.log("warn", "failed to fetch polymarket events (schema may not exist)", {
          err: err instanceof Error ? err.message : err,
        });
      }
    }

    events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return events;
  }

  private publishReplayEvent(event: ReplayEvent): void {
    const channelPrefix = this.settings.replayChannelPrefix;
    const subject = `feedeater.${channelPrefix}.${event.source}.${event.eventType}`;

    const messageId = uuidv5(`replay:${event.source}:${event.timestamp.toISOString()}:${Math.random()}`, UUID_NAMESPACE);

    const normalized = NormalizedMessageSchema.parse({
      id: messageId,
      createdAt: event.timestamp.toISOString(),
      source: { module: "replay", stream: `${event.source}:${event.eventType}` },
      contextRef: { ownerModule: "replay", sourceKey: `${event.source}:${event.eventType}` },
      Message: JSON.stringify(event.data),
      From: `Replay:${event.source}`,
      isDirectMention: false,
      isDigest: false,
      isSystemMessage: false,
      realtime: false,
      tags: {
        replaySource: event.source,
        replayEventType: event.eventType,
        originalTimestamp: event.timestamp.toISOString(),
      },
    });

    const msgEvent = MessageCreatedEventSchema.parse({
      type: "MessageCreated",
      message: normalized,
    });

    this.nats.publish(subject, this.sc.encode(JSON.stringify(msgEvent)));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async startReplay(): Promise<ReplayStats> {
    const now = new Date();
    const startTime = this.settings.startTime
      ? new Date(this.settings.startTime)
      : new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const endTime = this.settings.endTime ? new Date(this.settings.endTime) : now;

    this.log("info", "starting replay", {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      speed: this.settings.replaySpeed,
    });

    const sessionId = uuidv5(`replay:session:${Date.now()}`, UUID_NAMESPACE);
    await this.db.query(
      `INSERT INTO mod_replay.sessions (id, replay_start, replay_end, speed_multiplier, status)
       VALUES ($1, $2, $3, $4, 'running')`,
      [sessionId, startTime, endTime, this.settings.replaySpeed]
    );

    const events = await this.fetchAllEvents(startTime, endTime);
    const replayStartTime = Date.now();

    const eventsBySource: Record<string, number> = {};
    const interEventDelays: number[] = [];

    let prevTimestamp: Date | null = null;
    for (const event of events) {
      eventsBySource[event.source] = (eventsBySource[event.source] || 0) + 1;

      if (prevTimestamp) {
        const realDelayMs = event.timestamp.getTime() - prevTimestamp.getTime();
        const scaledDelayMs = Math.max(0, realDelayMs / this.settings.replaySpeed);

        if (scaledDelayMs > 0 && scaledDelayMs < 60000) {
          interEventDelays.push(realDelayMs);
          await this.sleep(scaledDelayMs);
        }
      }

      this.publishReplayEvent(event);
      prevTimestamp = event.timestamp;
    }

    const replayEndTime = Date.now();
    const realTimeDurationMs = endTime.getTime() - startTime.getTime();
    const replayDurationMs = replayEndTime - replayStartTime;

    const leadLagResults = await this.analyzeLeadLag(events);

    interEventDelays.sort((a, b) => a - b);
    const latencyDistribution = {
      p50: interEventDelays[Math.floor(interEventDelays.length * 0.5)] || 0,
      p90: interEventDelays[Math.floor(interEventDelays.length * 0.9)] || 0,
      p99: interEventDelays[Math.floor(interEventDelays.length * 0.99)] || 0,
      mean: interEventDelays.length > 0 ? interEventDelays.reduce((a, b) => a + b, 0) / interEventDelays.length : 0,
    };

    const stats: ReplayStats = {
      totalEvents: events.length,
      eventsBySource,
      replayDurationMs,
      realTimeDurationMs,
      speedMultiplier: this.settings.replaySpeed,
      leadLagResults,
      latencyDistribution,
    };

    await this.db.query(
      `UPDATE mod_replay.sessions
       SET ended_at = now(), total_events = $2, status = 'completed', stats = $3
       WHERE id = $1`,
      [sessionId, events.length, JSON.stringify(stats)]
    );

    for (const result of leadLagResults) {
      const analysisId = uuidv5(`leadlag:${sessionId}:${result.venue1}:${result.venue2}`, UUID_NAMESPACE);
      await this.db.query(
        `INSERT INTO mod_replay.lead_lag_analysis (id, session_id, venue1, venue2, lag_ms, correlation, sample_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET lag_ms = $5, correlation = $6, sample_count = $7, analyzed_at = now()`,
        [analysisId, sessionId, result.venue1, result.venue2, result.lagMs, result.correlation, result.sampleCount]
      );
    }

    this.log("info", "replay completed", stats);
    return stats;
  }

  async analyzeLeadLag(events?: ReplayEvent[]): Promise<LeadLagResult[]> {
    if (!events) {
      const now = new Date();
      const startTime = this.settings.startTime
        ? new Date(this.settings.startTime)
        : new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const endTime = this.settings.endTime ? new Date(this.settings.endTime) : now;
      events = await this.fetchAllEvents(startTime, endTime);
    }

    const results: LeadLagResult[] = [];

    const kalshiEvents = events.filter((e) => e.source === "kalshi");
    const polymarketEvents = events.filter((e) => e.source === "polymarket");

    if (kalshiEvents.length > 0 && polymarketEvents.length > 0) {
      const kalshiTimestamps = kalshiEvents.map((e) => e.timestamp.getTime());
      const polymarketTimestamps = polymarketEvents.map((e) => e.timestamp.getTime());

      const lagSamples: number[] = [];
      for (const kt of kalshiTimestamps) {
        let closestPoly = polymarketTimestamps[0]!;
        let minDiff = Math.abs(kt - closestPoly);
        for (const pt of polymarketTimestamps) {
          const diff = Math.abs(kt - pt);
          if (diff < minDiff) {
            minDiff = diff;
            closestPoly = pt;
          }
        }
        lagSamples.push(kt - closestPoly);
      }

      const meanLag = lagSamples.reduce((a, b) => a + b, 0) / lagSamples.length;

      const kalshiMean = kalshiTimestamps.reduce((a, b) => a + b, 0) / kalshiTimestamps.length;
      const polyMean = polymarketTimestamps.reduce((a, b) => a + b, 0) / polymarketTimestamps.length;

      let numerator = 0;
      let kalshiVar = 0;
      let polyVar = 0;

      const minLen = Math.min(kalshiTimestamps.length, polymarketTimestamps.length);
      for (let i = 0; i < minLen; i++) {
        const kDiff = kalshiTimestamps[i]! - kalshiMean;
        const pDiff = polymarketTimestamps[i]! - polyMean;
        numerator += kDiff * pDiff;
        kalshiVar += kDiff * kDiff;
        polyVar += pDiff * pDiff;
      }

      const correlation = kalshiVar > 0 && polyVar > 0 ? numerator / Math.sqrt(kalshiVar * polyVar) : 0;

      results.push({
        venue1: "kalshi",
        venue2: "polymarket",
        lagMs: meanLag,
        correlation,
        sampleCount: lagSamples.length,
      });

      if (meanLag > 0) {
        this.log("info", "lead-lag analysis: kalshi leads polymarket", { lagMs: meanLag, correlation });
      } else {
        this.log("info", "lead-lag analysis: polymarket leads kalshi", { lagMs: -meanLag, correlation });
      }
    }

    return results;
  }

  async getReplayStats(): Promise<{
    totalSessions: number;
    completedSessions: number;
    totalEventsReplayed: number;
    avgLeadLag: Record<string, number>;
  }> {
    const sessionsResult = await this.db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count FROM mod_replay.sessions GROUP BY status`
    );

    let totalSessions = 0;
    let completedSessions = 0;
    for (const row of sessionsResult.rows) {
      const count = parseInt(row.count, 10);
      totalSessions += count;
      if (row.status === "completed") completedSessions = count;
    }

    const eventsResult = await this.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(total_events), 0) as total FROM mod_replay.sessions WHERE status = 'completed'`
    );
    const totalEventsReplayed = parseInt(eventsResult.rows[0]?.total || "0", 10);

    const leadLagResult = await this.db.query<{ venue1: string; venue2: string; avg_lag: string }>(
      `SELECT venue1, venue2, AVG(lag_ms) as avg_lag
       FROM mod_replay.lead_lag_analysis
       GROUP BY venue1, venue2`
    );

    const avgLeadLag: Record<string, number> = {};
    for (const row of leadLagResult.rows) {
      avgLeadLag[`${row.venue1}_vs_${row.venue2}`] = parseFloat(row.avg_lag);
    }

    return {
      totalSessions,
      completedSessions,
      totalEventsReplayed,
      avgLeadLag,
    };
  }
}
