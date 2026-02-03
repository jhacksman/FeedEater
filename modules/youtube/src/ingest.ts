import { XMLParser } from "fast-xml-parser";
import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";

import {
  ContextUpdatedEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  subjectFor,
} from "@feedeater/core";

export type CollectionStrategy = "rss" | "api" | "hybrid";

export type YouTubeSettings = {
  enabled: boolean;
  collectionStrategy: CollectionStrategy;
  channelIds: string[];
  syncSubscriptions: boolean;
  maxVideosPerChannel: number;
  lookbackDays: number;
  fetchVideoDetails: boolean;
  includeShorts: boolean;
  excludeLiveStreams: boolean;
  checkIntervalMinutes: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

type RSSVideo = {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  link: string;
};

const UUID_NAMESPACE = "e1f2a3b4-5678-9abc-def0-1234567890ab";

export function parseYouTubeSettingsFromInternal(
  raw: Record<string, unknown>
): YouTubeSettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const collectionStrategy = (String(raw.collectionStrategy ?? "rss") as CollectionStrategy) || "rss";
  const channelIds = String(raw.channelIds ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const syncSubscriptions = String(raw.syncSubscriptions ?? "false") === "true";
  const maxVideosPerChannel = raw.maxVideosPerChannel ? Number(raw.maxVideosPerChannel) : 15;
  const lookbackDays = raw.lookbackDays ? Number(raw.lookbackDays) : 7;
  const fetchVideoDetails = String(raw.fetchVideoDetails ?? "false") === "true";
  const includeShorts = String(raw.includeShorts ?? "true") !== "false";
  const excludeLiveStreams = String(raw.excludeLiveStreams ?? "false") === "true";
  const checkIntervalMinutes = raw.checkIntervalMinutes ? Number(raw.checkIntervalMinutes) : 60;

  const defaultContextPrompt =
    "You are summarizing recent YouTube videos from a channel. Summarize ONLY the videos provided. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs describing the channel's recent content themes.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided video titles in plain text. 1-3 short sentences. Do not return JSON.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (channelIds.length === 0 && !syncSubscriptions) {
    throw new Error('YouTube setting "channelIds" is required when syncSubscriptions is disabled');
  }
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    throw new Error('YouTube setting "lookbackDays" must be a positive number');
  }

  return {
    enabled,
    collectionStrategy,
    channelIds,
    syncSubscriptions,
    maxVideosPerChannel,
    lookbackDays,
    fetchVideoDetails,
    includeShorts,
    excludeLiveStreams,
    checkIntervalMinutes,
    contextPrompt,
    contextPromptFallback,
  };
}

export class YouTubeIngestor {
  private xmlParser: XMLParser;
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: unknown
  ) {
    try {
      this.nats.publish(
        "feedeater.youtube.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "youtube",
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
    private readonly settings: YouTubeSettings,
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
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
    });
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
  }

  private async fetchRSSFeed(channelId: string): Promise<RSSVideo[]> {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
    this.log("debug", "fetching RSS feed", { channelId, rssUrl });

    try {
      const response = await fetch(rssUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const xml = await response.text();
      const parsed = this.xmlParser.parse(xml) as {
        feed?: {
          entry?: Array<{
            "yt:videoId"?: string;
            "yt:channelId"?: string;
            title?: string;
            link?: { "@_href"?: string } | Array<{ "@_href"?: string }>;
            author?: { name?: string };
            published?: string;
            "media:group"?: {
              "media:title"?: string;
              "media:description"?: string;
              "media:thumbnail"?: { "@_url"?: string };
            };
          }>;
          title?: string;
        };
      };

      if (!parsed.feed?.entry) {
        this.log("warn", "no entries in RSS feed", { channelId });
        return [];
      }

      const entries = Array.isArray(parsed.feed.entry)
        ? parsed.feed.entry
        : [parsed.feed.entry];

      const videos: RSSVideo[] = [];
      for (const entry of entries) {
        const videoId = String(entry["yt:videoId"] ?? "");
        if (!videoId) continue;

        const mediaGroup = entry["media:group"];
        const linkObj = Array.isArray(entry.link) ? entry.link[0] : entry.link;

        videos.push({
          videoId,
          channelId: String(entry["yt:channelId"] ?? channelId),
          channelTitle: String(entry.author?.name ?? parsed.feed.title ?? "Unknown"),
          title: String(mediaGroup?.["media:title"] ?? entry.title ?? ""),
          description: String(mediaGroup?.["media:description"] ?? ""),
          publishedAt: String(entry.published ?? new Date().toISOString()),
          thumbnailUrl:
            String(mediaGroup?.["media:thumbnail"]?.["@_url"] ?? "") ||
            `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          link: String(linkObj?.["@_href"] ?? `https://www.youtube.com/watch?v=${videoId}`),
        });
      }

      this.log("info", "fetched RSS feed", { channelId, videoCount: videos.length });
      return videos.slice(0, this.settings.maxVideosPerChannel);
    } catch (err) {
      this.log(
        "error",
        "failed to fetch RSS feed",
        err instanceof Error
          ? { channelId, name: err.name, message: err.message }
          : { channelId, err }
      );
      return [];
    }
  }

  private async aiGenerate(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
    tokenRate?: number;
    rawResponse?: string;
  }> {
    if (!this.apiBaseUrl || !this.internalToken) {
      throw new Error("AI summary unavailable: missing API base URL or internal token");
    }
    try {
      this.log("debug", "ai summary prompt", { promptLength: prompt.length });
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
      if (!summaryShort || !summaryLong) throw new Error("invalid summary payload");
      return {
        summaryShort,
        summaryLong,
        ...(typeof data.token_rate === "number" ? { tokenRate: data.token_rate } : {}),
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
      throw new Error(`ai summary fallback failed (${res.status}) ${body}`.trim());
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
      ...(typeof data.token_rate === "number" ? { tokenRate: data.token_rate } : {}),
      rawResponse,
    };
  }

  private parseSummaryJson(
    rawResponse: string
  ): { summaryShort: string; summaryLong: string } | null {
    const trimmed = rawResponse.trim();
    const candidate = trimmed.startsWith("```")
      ? trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim()
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
      throw new Error("AI embedding unavailable: missing API base URL or internal token");
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
        ownerModule: "youtube",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(
      subjectFor("youtube", "contextUpdated"),
      this.sc.encode(JSON.stringify(contextEvent))
    );
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_youtube");

    // Channels table
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_youtube.youtube_channels (
        channel_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        thumbnail_url TEXT,
        custom_url TEXT,
        subscriber_count BIGINT,
        video_count BIGINT,
        uploads_playlist_id TEXT,
        last_fetched_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Videos table (without FK for now to handle upsert order)
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_youtube.youtube_videos (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        thumbnail_url TEXT,
        published_at TIMESTAMPTZ NOT NULL,
        duration_seconds INTEGER,
        view_count BIGINT,
        like_count BIGINT,
        comment_count BIGINT,
        is_short BOOLEAN DEFAULT FALSE,
        is_live BOOLEAN DEFAULT FALSE,
        source TEXT NOT NULL DEFAULT 'rss',
        raw_payload JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.db.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_videos_channel_id 
      ON mod_youtube.youtube_videos(channel_id)
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_videos_published_at 
      ON mod_youtube.youtube_videos(published_at DESC)
    `);

    // Embeddings table
    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_youtube.youtube_video_embeddings (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        embedding vector(${embedDim}),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_youtube.youtube_video_embeddings 
         ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }

    this.log("info", "schema ensured", { embedDim });
  }

  private async ensureChannel(
    channelId: string,
    title: string
  ): Promise<void> {
    await this.db.query(
      `
      INSERT INTO mod_youtube.youtube_channels (channel_id, title, last_fetched_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (channel_id) DO UPDATE SET
        title = COALESCE(NULLIF(EXCLUDED.title, ''), mod_youtube.youtube_channels.title),
        last_fetched_at = NOW()
      `,
      [channelId, title]
    );
  }

  async collectAndPersist(): Promise<{
    insertedOrUpdated: number;
    publishedNew: number;
  }> {
    this.log("info", "youtube collect starting", {
      channelIds: this.settings.channelIds,
      strategy: this.settings.collectionStrategy,
    });

    const allVideos: RSSVideo[] = [];

    // Fetch RSS for each channel
    for (const channelId of this.settings.channelIds) {
      const videos = await this.fetchRSSFeed(channelId);
      allVideos.push(...videos);
    }

    if (allVideos.length === 0) {
      this.log("info", "no videos found");
      return { insertedOrUpdated: 0, publishedNew: 0 };
    }

    // Filter by lookback period
    const cutoffDate = new Date(
      Date.now() - this.settings.lookbackDays * 24 * 3600 * 1000
    );
    const filteredVideos = allVideos.filter(
      (v) => new Date(v.publishedAt) >= cutoffDate
    );

    this.log("info", "videos after filter", {
      total: allVideos.length,
      afterFilter: filteredVideos.length,
      cutoffDate: cutoffDate.toISOString(),
    });

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      let count = 0;
      let published = 0;

      for (const video of filteredVideos) {
        // Ensure channel exists
        await this.ensureChannel(video.channelId, video.channelTitle);

        const sourceId = `youtube-${video.videoId}`;

        // Upsert video
        const upsert = (await client.query(
          `
          INSERT INTO mod_youtube.youtube_videos (
            video_id, channel_id, title, description, thumbnail_url,
            published_at, source, raw_payload, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()
          )
          ON CONFLICT (video_id) DO UPDATE SET
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            thumbnail_url = EXCLUDED.thumbnail_url,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
          RETURNING (xmax = 0) AS inserted
          `,
          [
            video.videoId,
            video.channelId,
            video.title,
            video.description,
            video.thumbnailUrl,
            video.publishedAt,
            "rss",
            video as unknown,
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };
        count++;

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const msgId = uuidv5(sourceId, UUID_NAMESPACE);
          const contextKey = `channel:${video.channelId}`;
          const youtubeLink = video.link;

          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: new Date(video.publishedAt).toISOString(),
            source: { module: "youtube", stream: video.channelId },
            realtime: false,
            Message: `${video.title}\n\n${video.description}`.trim(),
            contextRef: { ownerModule: "youtube", sourceKey: contextKey },
            followMePanel: {
              module: "youtube",
              panelId: "video",
              href: youtubeLink,
              label: "Watch on YouTube",
            },
            From: video.channelTitle,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "youtube",
              channelId: video.channelId,
              videoId: video.videoId,
              author: video.channelTitle,
            },
          });

          const event = MessageCreatedEventSchema.parse({
            type: "MessageCreated",
            message: normalized,
          });
          this.nats.publish(
            subjectFor("youtube", "messageCreated"),
            this.sc.encode(JSON.stringify(event))
          );

          // Generate embedding for new video
          const embedText = `${video.title} ${video.description}`.slice(0, 2000);
          const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
          try {
            const embedding = embedText ? await this.aiEmbed(embedText) : [];
            if (
              embedding.length &&
              (!Number.isFinite(embedDim) || embedding.length === embedDim)
            ) {
              await client.query(
                `
                INSERT INTO mod_youtube.youtube_video_embeddings (
                  video_id, channel_id, embedding, created_at
                ) VALUES ($1, $2, $3::vector, NOW())
                ON CONFLICT (video_id) DO NOTHING
                `,
                [video.videoId, video.channelId, `[${embedding.join(",")}]`]
              );
            } else if (embedding.length) {
              this.log("warn", "embedding dimension mismatch", {
                expected: embedDim,
                got: embedding.length,
              });
            }
          } catch (embErr) {
            // Log but don't fail the whole job
            this.log(
              "warn",
              "failed to generate embedding",
              embErr instanceof Error
                ? { videoId: video.videoId, message: embErr.message }
                : { videoId: video.videoId, err: embErr }
            );
          }

          published++;
        }
      }

      await client.query("COMMIT");
      this.log("info", "youtube collect finished", {
        insertedOrUpdated: count,
        publishedNew: published,
      });
      return { insertedOrUpdated: count, publishedNew: published };
    } catch (e) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "youtube collect failed (job will fail)",
        e instanceof Error
          ? { name: e.name, message: e.message, stack: e.stack }
          : e
      );
      throw e;
    } finally {
      client.release();
    }
  }

  async refreshContexts(params: { lookbackDays: number }): Promise<{
    updated: number;
    aiSummaries: number;
    fallbackSummaries: number;
    embeddingsInserted: number;
    avgTokenRate?: number;
  }> {
    const cutoff = new Date(Date.now() - params.lookbackDays * 24 * 3600_000);

    // Get distinct channels with recent videos
    const channelsRes = await this.db.query(
      `
      SELECT DISTINCT channel_id, 
        (SELECT title FROM mod_youtube.youtube_channels c WHERE c.channel_id = v.channel_id LIMIT 1) as channel_title
      FROM mod_youtube.youtube_videos v
      WHERE published_at >= $1
      `,
      [cutoff]
    );

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of channelsRes.rows as Array<{
      channel_id: string;
      channel_title: string | null;
    }>) {
      const contextKey = `channel:${row.channel_id}`;
      const channelTitle = row.channel_title ?? row.channel_id;

      // Get recent videos for this channel
      const videosRes = await this.db.query(
        `
        SELECT video_id, title, description, published_at
        FROM mod_youtube.youtube_videos
        WHERE channel_id = $1 AND published_at >= $2
        ORDER BY published_at DESC
        LIMIT $3
        `,
        [row.channel_id, cutoff, this.contextTopK]
      );

      const videos = videosRes.rows as Array<{
        video_id: string;
        title: string;
        description: string | null;
        published_at: Date;
      }>;

      if (videos.length === 0) {
        this.log("warn", "no videos found for channel context", {
          channelId: row.channel_id,
        });
        continue;
      }

      // Build prompt for AI summary
      const videoList = videos
        .map(
          (v, i) =>
            `(${i + 1}) "${v.title}" - ${v.description?.slice(0, 200) ?? "(no description)"}`
        )
        .join("\n");

      const prompt = [
        `Channel: ${channelTitle}`,
        `Recent uploads (${videos.length} videos):`,
        videoList,
        "",
        "Summarize the themes and topics covered in these recent videos.",
      ].join("\n");

      const maxPromptChars = 8000;
      const promptText =
        prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;

      try {
        const aiSummary = await this.aiGenerate(promptText);

        // Generate embedding for context
        let contextEmbedding: number[] = [];
        try {
          contextEmbedding = await this.aiEmbed(aiSummary.summaryLong);
          if (contextEmbedding.length) embeddingsInserted++;
        } catch {
          // Log but continue
          this.log("warn", "failed to generate context embedding", {
            channelId: row.channel_id,
          });
        }

        if (typeof aiSummary.tokenRate === "number") {
          tokenRateSum += aiSummary.tokenRate;
          tokenRateCount += 1;
        }

        await this.publishContextUpdate({
          contextKey,
          summaryShort: aiSummary.summaryShort,
          summaryLong: aiSummary.summaryLong,
          keyPoints: videos.map((v) => v.title).slice(0, 5),
          ...(contextEmbedding.length ? { embedding: contextEmbedding } : {}),
        });

        aiSummaries++;
        updated++;
      } catch (err) {
        // Fallback to simple summary
        this.log(
          "warn",
          "AI summary failed, using fallback",
          err instanceof Error
            ? { channelId: row.channel_id, message: err.message }
            : { channelId: row.channel_id, err }
        );

        const fallbackShort = `${channelTitle}: ${videos.length} recent uploads`;
        const fallbackLong = videos.map((v) => `- ${v.title}`).join("\n");

        await this.publishContextUpdate({
          contextKey,
          summaryShort: fallbackShort.slice(0, 128),
          summaryLong: fallbackLong,
          keyPoints: videos.map((v) => v.title).slice(0, 5),
        });

        fallbackSummaries++;
        updated++;
      }
    }

    this.log("info", "youtube contexts refreshed", {
      updated,
      aiSummaries,
      fallbackSummaries,
    });

    return {
      updated,
      aiSummaries,
      fallbackSummaries,
      embeddingsInserted,
      ...(tokenRateCount ? { avgTokenRate: tokenRateSum / tokenRateCount } : {}),
    };
  }
}
