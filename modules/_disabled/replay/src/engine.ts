import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";
import { MessageCreatedEventSchema, subjectFor } from "@feedeater/core";
import { v5 as uuidv5 } from "uuid";

import {
  loadBusMessages,
  countBusMessages,
  type ReplayMessage,
} from "./loader.js";

const UUID_NAMESPACE = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

export type ReplaySettings = {
  enabled: boolean;
  speedMultiplier: number;
  filterModules: string[];
  batchSize: number;
};

export function parseReplaySettings(raw: Record<string, unknown>): ReplaySettings {
  const enabled = String(raw.enabled ?? "false") === "true";
  const speedMultiplier = raw.speedMultiplier ? Number(raw.speedMultiplier) : 100;
  const batchSize = raw.batchSize ? Number(raw.batchSize) : 1000;
  let filterModules: string[] = [];
  try {
    const parsed = JSON.parse(String(raw.filterModules ?? "[]"));
    if (Array.isArray(parsed)) filterModules = parsed.map(String);
  } catch { /* use empty */ }

  return {
    enabled,
    speedMultiplier: Number.isFinite(speedMultiplier) && speedMultiplier >= 1 ? speedMultiplier : 100,
    filterModules,
    batchSize: Number.isFinite(batchSize) && batchSize >= 1 ? batchSize : 1000,
  };
}

export type ReplayResult = {
  totalMessages: number;
  replayed: number;
  durationMs: number;
  wallClockSpanMs: number;
  effectiveSpeed: number;
  moduleBreakdown: Record<string, number>;
};

export class ReplayEngine {
  constructor(
    private readonly db: DbLike,
    private readonly nats: NatsLike,
    private readonly sc: StringCodecLike,
    private readonly settings: ReplaySettings
  ) {}

  private log(level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.replay.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "replay",
            source: "engine",
            at: new Date().toISOString(),
            message: msg,
            meta,
          })
        )
      );
    } catch { /* ignore */ }
  }

  async replay(params: {
    startTime: Date;
    endTime: Date;
    speedMultiplier?: number;
  }): Promise<ReplayResult> {
    const speed = params.speedMultiplier ?? this.settings.speedMultiplier;
    const startWall = Date.now();

    this.log("info", "replay starting", {
      startTime: params.startTime.toISOString(),
      endTime: params.endTime.toISOString(),
      speed,
      filterModules: this.settings.filterModules,
    });

    const totalMessages = await countBusMessages(this.db, {
      startTime: params.startTime,
      endTime: params.endTime,
      filterModules: this.settings.filterModules,
    });

    this.log("info", "messages to replay", { totalMessages });

    let replayed = 0;
    let offset = 0;
    let prevMsgTime: number | null = null;
    const moduleBreakdown: Record<string, number> = {};

    while (offset < totalMessages) {
      const batch = await loadBusMessages(this.db, {
        startTime: params.startTime,
        endTime: params.endTime,
        filterModules: this.settings.filterModules,
        batchSize: this.settings.batchSize,
        offset,
      });

      if (batch.length === 0) break;

      for (const msg of batch) {
        const msgTime = msg.createdAt.getTime();

        if (prevMsgTime !== null && speed < 10000) {
          const realDeltaMs = msgTime - prevMsgTime;
          if (realDeltaMs > 0) {
            const waitMs = realDeltaMs / speed;
            if (waitMs > 1) {
              await this.sleep(Math.min(waitMs, 5000));
            }
          }
        }

        prevMsgTime = msgTime;
        await this.publishReplayMessage(msg);
        replayed++;

        moduleBreakdown[msg.sourceModule] = (moduleBreakdown[msg.sourceModule] ?? 0) + 1;

        if (replayed % 1000 === 0) {
          this.log("info", "replay progress", {
            replayed,
            totalMessages,
            pct: ((replayed / totalMessages) * 100).toFixed(1),
          });
        }
      }

      offset += batch.length;
    }

    const durationMs = Date.now() - startWall;
    const wallClockSpanMs = params.endTime.getTime() - params.startTime.getTime();
    const effectiveSpeed = durationMs > 0 ? wallClockSpanMs / durationMs : 0;

    const result: ReplayResult = {
      totalMessages,
      replayed,
      durationMs,
      wallClockSpanMs,
      effectiveSpeed,
      moduleBreakdown,
    };

    this.log("info", "replay complete", result);
    return result;
  }

  private async publishReplayMessage(msg: ReplayMessage): Promise<void> {
    const replayId = uuidv5(`replay:${msg.id}:${Date.now()}`, UUID_NAMESPACE);

    const replayTags: Record<string, unknown> = {
      ...(msg.tagsJson ?? {}),
      replay: true,
      replaySourceId: msg.id,
      replayOriginalTime: msg.createdAt.toISOString(),
    };

    try {
      const normalized = {
        id: replayId,
        createdAt: new Date().toISOString(),
        source: { module: msg.sourceModule, stream: msg.sourceStream ?? undefined },
        contextRef: undefined,
        Message: msg.message ?? "",
        From: msg.from ?? msg.sourceModule,
        isDirectMention: false,
        isDigest: false,
        isSystemMessage: false,
        likes: 0,
        tags: replayTags,
      };

      const msgEvent = MessageCreatedEventSchema.parse({
        type: "MessageCreated",
        message: normalized,
      });

      this.nats.publish(
        subjectFor(msg.sourceModule, "messageCreated"),
        this.sc.encode(JSON.stringify(msgEvent))
      );
    } catch (err) {
      try {
        const fallback = {
          type: "ReplayMessage",
          replay: true,
          originalId: msg.id,
          originalTime: msg.createdAt.toISOString(),
          sourceModule: msg.sourceModule,
          sourceStream: msg.sourceStream,
          message: msg.message,
          from: msg.from,
          tags: replayTags,
          rawJson: msg.rawJson,
          replayedAt: new Date().toISOString(),
        };

        this.nats.publish(
          `feedeater.replay.${msg.sourceModule}`,
          this.sc.encode(JSON.stringify(fallback))
        );
      } catch (fallbackErr) {
        this.log("warn", "failed to publish replay message", {
          id: msg.id,
          err: err instanceof Error ? err.message : err,
          fallbackErr: fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
        });
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
