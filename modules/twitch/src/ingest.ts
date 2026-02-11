import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";

import {
  ContextUpdatedEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  subjectFor,
} from "@feedeater/core";

export type TwitchSettings = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  userAccessToken: string;
  refreshToken: string | undefined;
  userId: string;
  collectVods: boolean;
  collectClips: boolean;
  lookbackHours: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

// Twitch API response types
interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: string;
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  tag_ids: string[];
  tags: string[];
  is_mature: boolean;
}

interface TwitchVideo {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  description: string;
  created_at: string;
  published_at: string;
  url: string;
  thumbnail_url: string;
  viewable: string;
  view_count: number;
  language: string;
  type: string; // archive, highlight, upload
  duration: string;
  muted_segments: Array<{ duration: number; offset: number }> | null;
}

interface TwitchClip {
  id: string;
  url: string;
  embed_url: string;
  broadcaster_id: string;
  broadcaster_name: string;
  creator_id: string;
  creator_name: string;
  video_id: string;
  game_id: string;
  language: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  vod_offset: number | null;
}

interface TwitchTokenValidation {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
}

interface TwitchTokenRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}

const UUID_NAMESPACE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const TWITCH_API_BASE = "https://api.twitch.tv/helix";
const TWITCH_AUTH_BASE = "https://id.twitch.tv/oauth2";

export function parseTwitchSettingsFromInternal(
  raw: Record<string, unknown>
): TwitchSettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const clientId = String(raw.clientId ?? "");
  const clientSecret = String(raw.clientSecret ?? "");
  const userAccessToken = String(raw.userAccessToken ?? "");
  const refreshToken = raw.refreshToken ? String(raw.refreshToken) : undefined;
  const userId = String(raw.userId ?? "");
  const collectVods = String(raw.collectVods ?? "true") !== "false";
  const collectClips = String(raw.collectClips ?? "true") !== "false";
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 168;

  const defaultContextPrompt =
    "You are summarizing Twitch content. Summarize ONLY the provided stream/video/clip information. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided Twitch content in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";

  const contextPrompt =
    String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback =
    String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!clientId) throw new Error('Twitch setting "clientId" is required');
  if (!clientSecret)
    throw new Error('Twitch setting "clientSecret" is required');
  if (!userAccessToken)
    throw new Error('Twitch setting "userAccessToken" is required');
  if (!userId) throw new Error('Twitch setting "userId" is required');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Twitch setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    clientId,
    clientSecret,
    userAccessToken,
    refreshToken,
    userId,
    collectVods,
    collectClips,
    lookbackHours,
    contextPrompt,
    contextPromptFallback,
  };
}

export class TwitchIngestor {
  private accessToken: string;
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;

  // Rate limiting state
  private rateLimitRemaining = 800;
  private rateLimitReset = 0;

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: unknown
  ) {
    try {
      this.nats.publish(
        "feedeater.twitch.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "twitch",
            source: "collector",
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
    private readonly settings: TwitchSettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodec,
    opts: {
      apiBaseUrl: string;
      internalToken: string;
      contextTopK: number;
      embedDim: number;
    }
  ) {
    this.accessToken = settings.userAccessToken;
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
  }

  private async twitchFetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    // Check rate limit before making request
    if (this.rateLimitRemaining <= 0) {
      const waitMs = this.rateLimitReset * 1000 - Date.now();
      if (waitMs > 0) {
        this.log("warn", "rate limit reached, waiting", {
          waitMs,
          resetAt: new Date(this.rateLimitReset * 1000).toISOString(),
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    const url = endpoint.startsWith("http")
      ? endpoint
      : `${TWITCH_API_BASE}${endpoint}`;

    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Client-Id": this.settings.clientId,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    // Update rate limit state from headers
    const limitRemaining = res.headers.get("Ratelimit-Remaining");
    const limitReset = res.headers.get("Ratelimit-Reset");
    if (limitRemaining) this.rateLimitRemaining = parseInt(limitRemaining, 10);
    if (limitReset) this.rateLimitReset = parseInt(limitReset, 10);

    if (res.status === 429) {
      // Rate limited - wait and retry
      const resetTime = this.rateLimitReset * 1000;
      const waitMs = Math.max(resetTime - Date.now(), 1000);
      this.log("warn", "429 rate limited, retrying after wait", { waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.twitchFetch<T>(endpoint, options);
    }

    if (res.status === 401) {
      // Token might be expired - try refresh
      this.log("warn", "401 unauthorized, attempting token refresh");
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.twitchFetch<T>(endpoint, options);
      }
      throw new Error("Twitch API returned 401 and token refresh failed");
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Twitch API error (${res.status}): ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async validateToken(): Promise<TwitchTokenValidation | null> {
    try {
      const res = await fetch(`${TWITCH_AUTH_BASE}/validate`, {
        headers: {
          Authorization: `OAuth ${this.accessToken}`,
        },
      });
      if (!res.ok) {
        this.log("warn", "token validation failed", { status: res.status });
        return null;
      }
      return res.json() as Promise<TwitchTokenValidation>;
    } catch (err) {
      this.log(
        "error",
        "token validation error",
        err instanceof Error ? { message: err.message } : { err }
      );
      return null;
    }
  }

  async refreshAccessToken(): Promise<boolean> {
    if (!this.settings.refreshToken) {
      this.log("warn", "no refresh token available");
      return false;
    }

    try {
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.settings.refreshToken,
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
      });

      const res = await fetch(`${TWITCH_AUTH_BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.log("error", "token refresh failed", { status: res.status, body });
        return false;
      }

      const data = (await res.json()) as TwitchTokenRefreshResponse;
      this.accessToken = data.access_token;
      // Note: In a real impl, we'd persist the new tokens back to settings
      this.log("info", "token refreshed successfully", {
        expiresIn: data.expires_in,
      });
      return true;
    } catch (err) {
      this.log(
        "error",
        "token refresh error",
        err instanceof Error ? { message: err.message } : { err }
      );
      return false;
    }
  }

  private async fetchFollowedStreams(): Promise<TwitchStream[]> {
    const streams: TwitchStream[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({
        user_id: this.settings.userId,
        first: "100",
      });
      if (cursor) params.set("after", cursor);

      const data = await this.twitchFetch<{
        data: TwitchStream[];
        pagination?: { cursor?: string };
      }>(`/streams/followed?${params.toString()}`);

      streams.push(...data.data);
      cursor = data.pagination?.cursor;
    } while (cursor);

    return streams;
  }

  private async fetchVideos(userId: string): Promise<TwitchVideo[]> {
    const videos: TwitchVideo[] = [];
    let cursor: string | undefined;
    const lookbackDate = new Date(
      Date.now() - this.settings.lookbackHours * 3600_000
    );

    do {
      const params = new URLSearchParams({
        user_id: userId,
        first: "100",
        type: "all", // archive, highlight, upload
      });
      if (cursor) params.set("after", cursor);

      const data = await this.twitchFetch<{
        data: TwitchVideo[];
        pagination?: { cursor?: string };
      }>(`/videos?${params.toString()}`);

      // Filter by lookback window
      const filtered = data.data.filter(
        (v) => new Date(v.created_at) >= lookbackDate
      );
      videos.push(...filtered);

      // Stop if we've gone past the lookback window
      if (
        data.data.length > 0 &&
        data.data.some((v) => new Date(v.created_at) < lookbackDate)
      ) {
        break;
      }

      cursor = data.pagination?.cursor;
    } while (cursor && videos.length < 500); // Safety limit

    return videos;
  }

  private async fetchClips(broadcasterId: string): Promise<TwitchClip[]> {
    const clips: TwitchClip[] = [];
    let cursor: string | undefined;
    const lookbackDate = new Date(
      Date.now() - this.settings.lookbackHours * 3600_000
    );

    do {
      const params = new URLSearchParams({
        broadcaster_id: broadcasterId,
        first: "100",
        started_at: lookbackDate.toISOString(),
        ended_at: new Date().toISOString(),
      });
      if (cursor) params.set("after", cursor);

      const data = await this.twitchFetch<{
        data: TwitchClip[];
        pagination?: { cursor?: string };
      }>(`/clips?${params.toString()}`);

      clips.push(...data.data);
      cursor = data.pagination?.cursor;
    } while (cursor && clips.length < 500); // Safety limit

    return clips;
  }

  private async aiGenerate(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
    tokenRate?: number;
    rawResponse?: string;
  }> {
    if (!this.apiBaseUrl || !this.internalToken) {
      throw new Error(
        "AI summary unavailable: missing API base URL or internal token"
      );
    }
    try {
      this.log("debug", "ai summary prompt", {
        promptLength: prompt.length,
      });
      const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/summary`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.internalToken}`,
        },
        body: JSON.stringify({
          prompt,
          system: this.settings.contextPrompt,
          format: "json",
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ai summary failed (${res.status}) ${body}`.trim());
      }
      const data = (await res.json()) as {
        response?: string;
        token_rate?: number | null;
      };
      const rawResponse = String(data.response ?? "").trim();
      if (!rawResponse) throw new Error("invalid summary payload");
      const parsed = this.parseSummaryJson(rawResponse);
      if (!parsed) return await this.aiGenerateFallback(prompt);
      const summaryShort = parsed.summaryShort.slice(0, 128);
      const summaryLong = parsed.summaryLong;
      if (!summaryShort || !summaryLong)
        throw new Error("invalid summary payload");
      return {
        summaryShort,
        summaryLong,
        ...(typeof data.token_rate === "number"
          ? { tokenRate: data.token_rate }
          : {}),
        rawResponse,
      };
    } catch (err) {
      this.log(
        "error",
        "ai summary failed",
        err instanceof Error ? { message: err.message } : { err }
      );
      throw err;
    }
  }

  private async aiGenerateFallback(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
    tokenRate?: number;
    rawResponse?: string;
  }> {
    const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/summary`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.internalToken}`,
      },
      body: JSON.stringify({
        prompt,
        system: this.settings.contextPromptFallback,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `ai summary fallback failed (${res.status}) ${body}`.trim()
      );
    }
    const data = (await res.json()) as {
      response?: string;
      token_rate?: number | null;
    };
    const rawResponse = String(data.response ?? "").trim();
    if (!rawResponse) throw new Error("invalid fallback summary payload");
    return {
      summaryShort: rawResponse.slice(0, 128),
      summaryLong: rawResponse,
      ...(typeof data.token_rate === "number"
        ? { tokenRate: data.token_rate }
        : {}),
      rawResponse,
    };
  }

  private parseSummaryJson(
    rawResponse: string
  ): { summaryShort: string; summaryLong: string } | null {
    const trimmed = rawResponse.trim();
    const candidate = trimmed.startsWith("```")
      ? trimmed
          .replace(/^```[a-zA-Z]*\n?/, "")
          .replace(/```$/, "")
          .trim()
      : trimmed;
    try {
      const parsed = JSON.parse(candidate) as {
        summary_short?: string;
        summary_long?: string;
      };
      const summaryShort = String(parsed.summary_short ?? "").trim();
      const summaryLong = String(parsed.summary_long ?? "").trim();
      if (!summaryShort && !summaryLong) return null;
      return {
        summaryShort: summaryShort || summaryLong.slice(0, 128),
        summaryLong: summaryLong || summaryShort,
      };
    } catch {
      return null;
    }
  }

  private async aiEmbed(text: string): Promise<number[]> {
    if (!this.apiBaseUrl || !this.internalToken) {
      throw new Error(
        "AI embedding unavailable: missing API base URL or internal token"
      );
    }
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/embedding`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.internalToken}`,
        },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`ai embeddings failed (${res.status})`);
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0)
        throw new Error("empty embedding");
      return data.embedding;
    } catch (err) {
      this.log(
        "error",
        "ai embeddings failed",
        err instanceof Error ? { message: err.message } : { err }
      );
      throw err;
    }
  }

  private async publishContextUpdate(params: {
    contextKey: string;
    messageId?: string;
    summaryShort: string;
    summaryLong: string;
    keyPoints?: string[];
    embedding?: number[];
  }) {
    const summaryShort = params.summaryShort.slice(0, 128);
    const contextEvent = ContextUpdatedEventSchema.parse({
      type: "ContextUpdated",
      createdAt: new Date().toISOString(),
      messageId: params.messageId,
      context: {
        ownerModule: "twitch",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(
      subjectFor("twitch", "contextUpdated"),
      this.sc.encode(JSON.stringify(contextEvent))
    );
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_twitch");

    // Live streams table
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_twitch.twitch_streams (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_login TEXT NOT NULL,
        user_name TEXT NOT NULL,
        game_id TEXT,
        game_name TEXT,
        title TEXT,
        viewer_count INTEGER,
        started_at TIMESTAMPTZ NOT NULL,
        thumbnail_url TEXT,
        is_live BOOLEAN NOT NULL DEFAULT true,
        payload JSONB NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS twitch_streams_user_idx ON mod_twitch.twitch_streams (user_id)`
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS twitch_streams_started_idx ON mod_twitch.twitch_streams (started_at)`
    );

    // VODs table
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_twitch.twitch_videos (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_login TEXT NOT NULL,
        user_name TEXT NOT NULL,
        title TEXT,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ,
        duration TEXT,
        view_count INTEGER,
        video_type TEXT,
        thumbnail_url TEXT,
        payload JSONB NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS twitch_videos_user_idx ON mod_twitch.twitch_videos (user_id)`
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS twitch_videos_created_idx ON mod_twitch.twitch_videos (created_at)`
    );

    // Clips table
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_twitch.twitch_clips (
        id TEXT PRIMARY KEY,
        broadcaster_id TEXT NOT NULL,
        broadcaster_name TEXT NOT NULL,
        creator_id TEXT,
        creator_name TEXT,
        video_id TEXT,
        game_id TEXT,
        title TEXT,
        view_count INTEGER,
        created_at TIMESTAMPTZ NOT NULL,
        thumbnail_url TEXT,
        duration REAL,
        vod_offset INTEGER,
        payload JSONB NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS twitch_clips_broadcaster_idx ON mod_twitch.twitch_clips (broadcaster_id)`
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS twitch_clips_created_idx ON mod_twitch.twitch_clips (created_at)`
    );

    // Embeddings table
    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_twitch.twitch_embeddings (
        id TEXT PRIMARY KEY,
        context_key TEXT NOT NULL,
        content_type TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_twitch.twitch_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS twitch_embeddings_context_idx ON mod_twitch.twitch_embeddings (context_key, ts)`
    );
    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS twitch_embeddings_vec_idx ON mod_twitch.twitch_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS mod_twitch.twitch_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", {
        embedDim,
      });
    }
  }

  async collectAndPersist(): Promise<{
    streamsCollected: number;
    videosCollected: number;
    clipsCollected: number;
    messagesPublished: number;
  }> {
    this.log("info", "twitch collect starting", {
      userId: this.settings.userId,
      lookbackHours: this.settings.lookbackHours,
    });

    // Validate token first
    const validation = await this.validateToken();
    if (!validation) {
      const refreshed = await this.refreshAccessToken();
      if (!refreshed) {
        throw new Error("Invalid token and refresh failed");
      }
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      let streamsCollected = 0;
      let videosCollected = 0;
      let clipsCollected = 0;
      let messagesPublished = 0;

      // Fetch followed streams
      const streams = await this.fetchFollowedStreams();
      this.log("info", "fetched followed streams", { count: streams.length });

      // Track unique user IDs for VOD/clip fetching
      const userIds = new Set<string>();

      for (const stream of streams) {
        userIds.add(stream.user_id);
        const sourceId = `twitch-stream-${stream.user_id}-${stream.started_at}`;

        const upsert = (await client.query(
          `
          INSERT INTO mod_twitch.twitch_streams (
            id, user_id, user_login, user_name, game_id, game_name,
            title, viewer_count, started_at, thumbnail_url, is_live, payload
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
          )
          ON CONFLICT (id) DO UPDATE SET
            viewer_count = EXCLUDED.viewer_count,
            title = EXCLUDED.title,
            game_id = EXCLUDED.game_id,
            game_name = EXCLUDED.game_name,
            is_live = EXCLUDED.is_live,
            payload = EXCLUDED.payload,
            collected_at = now()
          RETURNING (xmax = 0) AS inserted
          `,
          [
            sourceId,
            stream.user_id,
            stream.user_login,
            stream.user_name,
            stream.game_id,
            stream.game_name,
            stream.title,
            stream.viewer_count,
            stream.started_at,
            stream.thumbnail_url,
            true,
            stream,
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };
        streamsCollected++;

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const msgId = uuidv5(sourceId, UUID_NAMESPACE);
          const contextKey = `stream:${stream.user_id}`;
          const twitchLink = `https://twitch.tv/${stream.user_login}`;

          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: stream.started_at,
            source: { module: "twitch", stream: "streams" },
            realtime: false,
            Message: `${stream.user_name} is live: ${stream.title} (${stream.game_name}) - ${stream.viewer_count} viewers`,
            contextRef: { ownerModule: "twitch", sourceKey: contextKey },
            followMePanel: {
              module: "twitch",
              panelId: "stream",
              href: twitchLink,
              label: "Watch on Twitch",
            },
            From: stream.user_name,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "twitch",
              contentType: "stream",
              userId: stream.user_id,
              gameId: stream.game_id || "",
              gameName: stream.game_name || "",
              viewerCount: stream.viewer_count,
            },
          });
          const event = MessageCreatedEventSchema.parse({
            type: "MessageCreated",
            message: normalized,
          });
          this.nats.publish(
            subjectFor("twitch", "messageCreated"),
            this.sc.encode(JSON.stringify(event))
          );
          messagesPublished++;

          // Also emit stream online event
          this.nats.publish(
            subjectFor("twitch", "streamOnline"),
            this.sc.encode(JSON.stringify({ type: "StreamOnline", stream }))
          );
        }
      }

      // Fetch VODs for followed users
      if (this.settings.collectVods) {
        for (const userId of userIds) {
          const videos = await this.fetchVideos(userId);
          this.log("debug", "fetched videos for user", {
            userId,
            count: videos.length,
          });

          for (const video of videos) {
            const sourceId = `twitch-video-${video.id}`;

            const upsert = (await client.query(
              `
              INSERT INTO mod_twitch.twitch_videos (
                id, user_id, user_login, user_name, title, description,
                created_at, published_at, duration, view_count, video_type,
                thumbnail_url, payload
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
              )
              ON CONFLICT (id) DO UPDATE SET
                view_count = EXCLUDED.view_count,
                payload = EXCLUDED.payload,
                collected_at = now()
              RETURNING (xmax = 0) AS inserted
              `,
              [
                video.id,
                video.user_id,
                video.user_login,
                video.user_name,
                video.title,
                video.description,
                video.created_at,
                video.published_at,
                video.duration,
                video.view_count,
                video.type,
                video.thumbnail_url,
                video,
              ]
            )) as unknown as { rows: Array<{ inserted: boolean }> };
            videosCollected++;

            const inserted = Boolean(upsert.rows?.[0]?.inserted);
            if (inserted) {
              const msgId = uuidv5(sourceId, UUID_NAMESPACE);
              const contextKey = `vod:${video.id}`;

              const normalized = NormalizedMessageSchema.parse({
                id: msgId,
                createdAt: video.created_at,
                source: { module: "twitch", stream: "videos" },
                realtime: false,
                Message: `${video.user_name} uploaded: ${video.title} (${video.duration}) - ${video.view_count} views`,
                contextRef: { ownerModule: "twitch", sourceKey: contextKey },
                followMePanel: {
                  module: "twitch",
                  panelId: "video",
                  href: video.url,
                  label: "Watch VOD",
                },
                From: video.user_name,
                isDirectMention: false,
                isDigest: false,
                isSystemMessage: false,
                tags: {
                  source: "twitch",
                  contentType: "video",
                  userId: video.user_id,
                  videoType: video.type,
                  viewCount: video.view_count,
                },
              });
              const event = MessageCreatedEventSchema.parse({
                type: "MessageCreated",
                message: normalized,
              });
              this.nats.publish(
                subjectFor("twitch", "messageCreated"),
                this.sc.encode(JSON.stringify(event))
              );
              messagesPublished++;

              this.nats.publish(
                subjectFor("twitch", "videoCreated"),
                this.sc.encode(JSON.stringify({ type: "VideoCreated", video }))
              );
            }
          }
        }
      }

      // Fetch clips for followed users
      if (this.settings.collectClips) {
        for (const userId of userIds) {
          const clips = await this.fetchClips(userId);
          this.log("debug", "fetched clips for user", {
            userId,
            count: clips.length,
          });

          for (const clip of clips) {
            const sourceId = `twitch-clip-${clip.id}`;

            const upsert = (await client.query(
              `
              INSERT INTO mod_twitch.twitch_clips (
                id, broadcaster_id, broadcaster_name, creator_id, creator_name,
                video_id, game_id, title, view_count, created_at, thumbnail_url,
                duration, vod_offset, payload
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
              )
              ON CONFLICT (id) DO UPDATE SET
                view_count = EXCLUDED.view_count,
                payload = EXCLUDED.payload,
                collected_at = now()
              RETURNING (xmax = 0) AS inserted
              `,
              [
                clip.id,
                clip.broadcaster_id,
                clip.broadcaster_name,
                clip.creator_id,
                clip.creator_name,
                clip.video_id,
                clip.game_id,
                clip.title,
                clip.view_count,
                clip.created_at,
                clip.thumbnail_url,
                clip.duration,
                clip.vod_offset,
                clip,
              ]
            )) as unknown as { rows: Array<{ inserted: boolean }> };
            clipsCollected++;

            const inserted = Boolean(upsert.rows?.[0]?.inserted);
            if (inserted) {
              const msgId = uuidv5(sourceId, UUID_NAMESPACE);
              const contextKey = `clip:${clip.id}`;

              const normalized = NormalizedMessageSchema.parse({
                id: msgId,
                createdAt: clip.created_at,
                source: { module: "twitch", stream: "clips" },
                realtime: false,
                Message: `Clip from ${clip.broadcaster_name}: ${clip.title} (${clip.duration}s) - ${clip.view_count} views`,
                contextRef: { ownerModule: "twitch", sourceKey: contextKey },
                followMePanel: {
                  module: "twitch",
                  panelId: "clip",
                  href: clip.url,
                  label: "Watch Clip",
                },
                From: clip.creator_name || clip.broadcaster_name,
                isDirectMention: false,
                isDigest: false,
                isSystemMessage: false,
                tags: {
                  source: "twitch",
                  contentType: "clip",
                  broadcasterId: clip.broadcaster_id,
                  gameId: clip.game_id || "",
                  viewCount: clip.view_count,
                },
              });
              const event = MessageCreatedEventSchema.parse({
                type: "MessageCreated",
                message: normalized,
              });
              this.nats.publish(
                subjectFor("twitch", "messageCreated"),
                this.sc.encode(JSON.stringify(event))
              );
              messagesPublished++;

              this.nats.publish(
                subjectFor("twitch", "clipCreated"),
                this.sc.encode(JSON.stringify({ type: "ClipCreated", clip }))
              );
            }
          }
        }
      }

      await client.query("COMMIT");
      this.log("info", "twitch collect finished", {
        streamsCollected,
        videosCollected,
        clipsCollected,
        messagesPublished,
      });

      return {
        streamsCollected,
        videosCollected,
        clipsCollected,
        messagesPublished,
      };
    } catch (e) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "twitch collect failed",
        e instanceof Error
          ? { name: e.name, message: e.message, stack: e.stack }
          : e
      );
      throw e;
    } finally {
      client.release();
    }
  }

  async refreshContexts(params: { lookbackHours: number }): Promise<{
    updated: number;
    aiSummaries: number;
    fallbackSummaries: number;
    embeddingsInserted: number;
    avgTokenRate?: number;
  }> {
    const cutoff = new Date(Date.now() - params.lookbackHours * 3600_000);
    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    // Update stream contexts
    const streams = await this.db.query(
      `
      SELECT DISTINCT ON (user_id)
        id, user_id, user_name, game_name, title, viewer_count, started_at
      FROM mod_twitch.twitch_streams
      WHERE started_at >= $1 AND is_live = true
      ORDER BY user_id, collected_at DESC
      `,
      [cutoff]
    );

    for (const row of streams.rows as Array<{
      id: string;
      user_id: string;
      user_name: string;
      game_name: string | null;
      title: string | null;
      viewer_count: number | null;
      started_at: Date;
    }>) {
      const contextKey = `stream:${row.user_id}`;
      const msgId = uuidv5(row.id, UUID_NAMESPACE);

      const prompt = [
        `Twitch Stream Summary`,
        `Streamer: ${row.user_name}`,
        `Game: ${row.game_name || "Unknown"}`,
        `Title: ${row.title || "No title"}`,
        `Viewers: ${row.viewer_count ?? 0}`,
        `Started: ${row.started_at}`,
      ].join("\n");

      try {
        const aiSummary = await this.aiGenerate(prompt);
        const contextEmbedding = await this.aiEmbed(aiSummary.summaryLong);

        if (contextEmbedding.length) {
          embeddingsInserted++;
          await this.db.query(
            `
            INSERT INTO mod_twitch.twitch_embeddings (id, context_key, content_type, ts, embedding)
            VALUES ($1, $2, $3, $4, $5::vector)
            ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding
            `,
            [
              `${contextKey}:${Date.now()}`,
              contextKey,
              "stream",
              new Date(),
              `[${contextEmbedding.join(",")}]`,
            ]
          );
        }

        if (typeof aiSummary.tokenRate === "number") {
          tokenRateSum += aiSummary.tokenRate;
          tokenRateCount += 1;
        }

        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort: aiSummary.summaryShort,
          summaryLong: aiSummary.summaryLong,
          keyPoints: [],
          ...(contextEmbedding.length ? { embedding: contextEmbedding } : {}),
        });
        aiSummaries++;
        updated++;
      } catch {
        const summaryShort = `${row.user_name} streaming ${row.game_name || "Unknown"}`.slice(
          0,
          128
        );
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: `${row.user_name} is streaming ${row.game_name || "Unknown game"}: ${row.title || "No title"}`,
          keyPoints: [],
        });
        fallbackSummaries++;
        updated++;
      }
    }

    // Update VOD contexts
    if (this.settings.collectVods) {
      const videos = await this.db.query(
        `
        SELECT id, user_name, title, description, duration, view_count, video_type, created_at
        FROM mod_twitch.twitch_videos
        WHERE created_at >= $1
        ORDER BY created_at DESC
        LIMIT 100
        `,
        [cutoff]
      );

      for (const row of videos.rows as Array<{
        id: string;
        user_name: string;
        title: string | null;
        description: string | null;
        duration: string | null;
        view_count: number | null;
        video_type: string | null;
        created_at: Date;
      }>) {
        const contextKey = `vod:${row.id}`;
        const msgId = uuidv5(`twitch-video-${row.id}`, UUID_NAMESPACE);

        const prompt = [
          `Twitch VOD Summary`,
          `Creator: ${row.user_name}`,
          `Title: ${row.title || "No title"}`,
          `Type: ${row.video_type || "Unknown"}`,
          `Duration: ${row.duration || "Unknown"}`,
          `Views: ${row.view_count ?? 0}`,
          row.description ? `Description: ${row.description.slice(0, 500)}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        try {
          const aiSummary = await this.aiGenerate(prompt);
          const contextEmbedding = await this.aiEmbed(aiSummary.summaryLong);

          if (contextEmbedding.length) {
            embeddingsInserted++;
            await this.db.query(
              `
              INSERT INTO mod_twitch.twitch_embeddings (id, context_key, content_type, ts, embedding)
              VALUES ($1, $2, $3, $4, $5::vector)
              ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding
              `,
              [
                contextKey,
                contextKey,
                "video",
                row.created_at,
                `[${contextEmbedding.join(",")}]`,
              ]
            );
          }

          if (typeof aiSummary.tokenRate === "number") {
            tokenRateSum += aiSummary.tokenRate;
            tokenRateCount += 1;
          }

          await this.publishContextUpdate({
            contextKey,
            messageId: msgId,
            summaryShort: aiSummary.summaryShort,
            summaryLong: aiSummary.summaryLong,
            keyPoints: [],
            ...(contextEmbedding.length ? { embedding: contextEmbedding } : {}),
          });
          aiSummaries++;
          updated++;
        } catch {
          const summaryShort = `${row.user_name}: ${row.title || "VOD"}`.slice(
            0,
            128
          );
          await this.publishContextUpdate({
            contextKey,
            messageId: msgId,
            summaryShort,
            summaryLong: `VOD from ${row.user_name}: ${row.title || "No title"} (${row.duration || "Unknown duration"})`,
            keyPoints: [],
          });
          fallbackSummaries++;
          updated++;
        }
      }
    }

    return {
      updated,
      aiSummaries,
      fallbackSummaries,
      embeddingsInserted,
      ...(tokenRateCount ? { avgTokenRate: tokenRateSum / tokenRateCount } : {}),
    };
  }
}
