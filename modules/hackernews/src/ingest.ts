import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";

import { ContextUpdatedEventSchema, MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

const HN_API_BASE = "https://hacker-news.firebaseio.com/v0";
const UUID_NAMESPACE = "a7c3e1d0-9f2b-4e8a-b6d1-3c5f7a9e2b4d";

const FEED_ENDPOINTS: Record<string, string> = {
  top: `${HN_API_BASE}/topstories.json`,
  new: `${HN_API_BASE}/newstories.json`,
  best: `${HN_API_BASE}/beststories.json`,
  ask: `${HN_API_BASE}/askstories.json`,
  show: `${HN_API_BASE}/showstories.json`,
  job: `${HN_API_BASE}/jobstories.json`,
};

export type HackerNewsSettings = {
  enabled: boolean;
  feedTypes: string[];
  maxStoriesPerFeed: number;
  lookbackHours: number;
  includeComments: boolean;
  maxCommentsPerStory: number;
  requestTimeoutSeconds: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

type HNItem = {
  id: number;
  type: string;
  by?: string;
  time?: number;
  title?: string;
  text?: string;
  url?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  parent?: number;
  dead?: boolean;
  deleted?: boolean;
};

type StoryRow = {
  hn_id: number;
  feed_type: string;
  title: string;
  url: string | null;
  text: string | null;
  author: string;
  score: number;
  comment_count: number;
  hn_time: number;
};

export function parseHackerNewsSettingsFromInternal(raw: Record<string, unknown>): HackerNewsSettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const feedTypesRaw = String(raw.feedTypes ?? "top,best,new,ask,show");
  const feedTypes = feedTypesRaw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const maxStoriesPerFeed = raw.maxStoriesPerFeed ? Number(raw.maxStoriesPerFeed) : 30;
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const includeComments = String(raw.includeComments ?? "false") !== "false";
  const maxCommentsPerStory = raw.maxCommentsPerStory ? Number(raw.maxCommentsPerStory) : 5;
  const requestTimeoutSeconds = raw.requestTimeoutSeconds ? Number(raw.requestTimeoutSeconds) : 15;

  const defaultContextPrompt =
    "You are summarizing Hacker News stories and discussions. Summarize ONLY the content provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided Hacker News content in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(maxStoriesPerFeed) || maxStoriesPerFeed <= 0) {
    throw new Error('HN setting "maxStoriesPerFeed" must be a positive number');
  }
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('HN setting "lookbackHours" must be a positive number');
  }
  if (!Number.isFinite(requestTimeoutSeconds) || requestTimeoutSeconds <= 0) {
    throw new Error('HN setting "requestTimeoutSeconds" must be a positive number');
  }

  return {
    enabled,
    feedTypes,
    maxStoriesPerFeed,
    lookbackHours,
    includeComments,
    maxCommentsPerStory,
    requestTimeoutSeconds,
    contextPrompt,
    contextPromptFallback,
  };
}

export class HackerNewsIngestor {
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.hackernews.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "hackernews",
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
    private readonly settings: HackerNewsSettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodec,
    opts: { apiBaseUrl: string; internalToken: string; contextTopK: number; embedDim: number }
  ) {
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.requestTimeoutSeconds * 1000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HN API error (${res.status}) for ${url}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchStoryIds(feedType: string): Promise<number[]> {
    const endpoint = FEED_ENDPOINTS[feedType];
    if (!endpoint) {
      this.log("warn", `unknown feed type: ${feedType}`);
      return [];
    }
    const ids = await this.fetchJson<number[]>(endpoint);
    return ids.slice(0, this.settings.maxStoriesPerFeed);
  }

  private async fetchItem(id: number): Promise<HNItem | null> {
    try {
      const item = await this.fetchJson<HNItem | null>(`${HN_API_BASE}/item/${id}.json`);
      if (!item || item.deleted || item.dead) return null;
      return item;
    } catch (err) {
      this.log("warn", "failed to fetch HN item", {
        id,
        err: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      return null;
    }
  }

  private async fetchTopComments(item: HNItem): Promise<HNItem[]> {
    if (!this.settings.includeComments || !item.kids || item.kids.length === 0) return [];
    const commentIds = item.kids.slice(0, this.settings.maxCommentsPerStory);
    const comments: HNItem[] = [];
    for (const cid of commentIds) {
      const comment = await this.fetchItem(cid);
      if (comment && comment.text) comments.push(comment);
    }
    return comments;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/gi, "$1")
      .replace(/<p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private buildMessageBody(item: HNItem, feedType: string): string {
    const parts: string[] = [];
    if (item.title) parts.push(item.title);
    if (item.url) parts.push(item.url);
    if (item.text) parts.push(this.stripHtml(item.text));

    const meta: string[] = [];
    if (item.score !== undefined) meta.push(`${item.score} points`);
    if (item.descendants !== undefined) meta.push(`${item.descendants} comments`);
    meta.push(`[${feedType}]`);

    if (meta.length > 0) parts.push(meta.join(" | "));
    return parts.join("\n");
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
      this.log("info", "ai summary prompt", { prompt: prompt.slice(0, 200) });
      const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/summary`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
        body: JSON.stringify({ prompt, system: this.settings.contextPrompt, format: "json" }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ai summary failed (${res.status}) ${body}`.trim());
      }
      const data = (await res.json()) as { response?: string; token_rate?: number | null };
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
      this.log("error", "ai summary failed", err instanceof Error ? { message: err.message } : { err });
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
      headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
      body: JSON.stringify({ prompt, system: this.settings.contextPromptFallback }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ai summary fallback failed (${res.status}) ${body}`.trim());
    }
    const data = (await res.json()) as { response?: string; token_rate?: number | null };
    const rawResponse = String(data.response ?? "").trim();
    if (!rawResponse) throw new Error("invalid fallback summary payload");
    return {
      summaryShort: rawResponse.slice(0, 128),
      summaryLong: rawResponse,
      ...(typeof data.token_rate === "number" ? { tokenRate: data.token_rate } : {}),
      rawResponse,
    };
  }

  private parseSummaryJson(rawResponse: string): { summaryShort: string; summaryLong: string } | null {
    const trimmed = rawResponse.trim();
    const candidate = trimmed.startsWith("```")
      ? trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim()
      : trimmed;
    try {
      const parsed = JSON.parse(candidate) as { summary_short?: string; summary_long?: string };
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
        headers: { "content-type": "application/json", authorization: `Bearer ${this.internalToken}` },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`ai embeddings failed (${res.status})`);
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) throw new Error("empty embedding");
      return data.embedding;
    } catch (err) {
      this.log("error", "ai embeddings failed", err instanceof Error ? { message: err.message } : { err });
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
        ownerModule: "hackernews",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(subjectFor("hackernews", "contextUpdated"), this.sc.encode(JSON.stringify(contextEvent)));
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_hackernews");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_hackernews.stories (
        id text PRIMARY KEY,
        hn_id integer NOT NULL UNIQUE,
        feed_type text NOT NULL,
        title text NOT NULL,
        url text,
        hn_text text,
        author text NOT NULL,
        score integer NOT NULL DEFAULT 0,
        comment_count integer NOT NULL DEFAULT 0,
        hn_time integer NOT NULL,
        ts timestamptz NOT NULL,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS hn_stories_ts_idx ON mod_hackernews.stories (ts)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS hn_stories_feed_ts_idx ON mod_hackernews.stories (feed_type, ts)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS hn_stories_hn_id_idx ON mod_hackernews.stories (hn_id)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_hackernews.comments (
        id text PRIMARY KEY,
        hn_id integer NOT NULL UNIQUE,
        story_hn_id integer NOT NULL,
        author text NOT NULL,
        hn_text text,
        hn_time integer NOT NULL,
        ts timestamptz NOT NULL,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS hn_comments_story_idx ON mod_hackernews.comments (story_hn_id, ts)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_hackernews.story_embeddings (
        id text PRIMARY KEY,
        hn_id integer NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_hackernews.story_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS hn_story_embeddings_context_idx ON mod_hackernews.story_embeddings (context_key, ts)`
    );
    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS hn_story_embeddings_vec_idx ON mod_hackernews.story_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS hn_story_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }
  }

  async collectAndPersist(): Promise<{ insertedOrUpdated: number; publishedNew: number; feedsPolled: number }> {
    this.log("info", "hackernews collect starting", {
      feedTypes: this.settings.feedTypes,
      maxStoriesPerFeed: this.settings.maxStoriesPerFeed,
    });

    let totalInserted = 0;
    let totalPublished = 0;
    let feedsPolled = 0;
    const lookbackCutoff = Date.now() / 1000 - this.settings.lookbackHours * 3600;

    for (const feedType of this.settings.feedTypes) {
      feedsPolled++;
      let storyIds: number[];
      try {
        storyIds = await this.fetchStoryIds(feedType);
      } catch (err) {
        this.log("error", "failed to fetch story IDs (continuing)", {
          feedType,
          err: err instanceof Error ? { name: err.name, message: err.message } : err,
        });
        continue;
      }

      for (const storyId of storyIds) {
        const item = await this.fetchItem(storyId);
        if (!item || !item.time) continue;
        if (item.time < lookbackCutoff) continue;

        const sourceId = `hn-${item.id}`;
        const client = await this.db.connect();
        try {
          await client.query("BEGIN");

          const upsert = (await client.query(
            `
            INSERT INTO mod_hackernews.stories (
              id, hn_id, feed_type, title, url, hn_text,
              author, score, comment_count, hn_time, ts, payload
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9, $10, to_timestamp($10), $11
            )
            ON CONFLICT (hn_id) DO UPDATE SET
              score = EXCLUDED.score,
              comment_count = EXCLUDED.comment_count,
              feed_type = EXCLUDED.feed_type,
              payload = EXCLUDED.payload,
              collected_at = now()
            RETURNING (xmax = 0) AS inserted
            `,
            [
              sourceId,
              item.id,
              feedType,
              item.title ?? "",
              item.url ?? null,
              item.text ? this.stripHtml(item.text) : null,
              item.by ?? "unknown",
              item.score ?? 0,
              item.descendants ?? 0,
              item.time,
              item,
            ]
          )) as unknown as { rows: Array<{ inserted: boolean }> };
          totalInserted++;

          const inserted = Boolean(upsert.rows?.[0]?.inserted);
          if (inserted) {
            const msgId = uuidv5(sourceId, UUID_NAMESPACE);
            const contextKey = `story:${item.id}`;
            const hnLink = `https://news.ycombinator.com/item?id=${item.id}`;
            const messageBody = this.buildMessageBody(item, feedType);

            const normalized = NormalizedMessageSchema.parse({
              id: msgId,
              createdAt: new Date(item.time * 1000).toISOString(),
              source: { module: "hackernews", stream: feedType },
              realtime: false,
              Message: messageBody,
              contextRef: { ownerModule: "hackernews", sourceKey: contextKey },
              followMePanel: {
                module: "hackernews",
                panelId: "story",
                href: hnLink,
                label: "View on Hacker News",
              },
              From: item.by ?? "unknown",
              isDirectMention: false,
              isDigest: false,
              isSystemMessage: false,
              tags: {
                source: "hackernews",
                feedType,
                author: item.by ?? "unknown",
                score: item.score ?? 0,
                commentCount: item.descendants ?? 0,
                ...(item.url ? { storyUrl: item.url } : {}),
                ...(item.type === "job" ? { isJob: true } : {}),
              },
            });
            const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
            this.nats.publish(subjectFor("hackernews", "messageCreated"), this.sc.encode(JSON.stringify(event)));

            const embedText = [item.title, item.url, item.text ? this.stripHtml(item.text) : ""].filter(Boolean).join(" ");
            const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
            try {
              const embedding = embedText ? await this.aiEmbed(embedText) : [];
              if (embedding.length && (!Number.isFinite(embedDim) || embedding.length === embedDim)) {
                await client.query(
                  `
                  INSERT INTO mod_hackernews.story_embeddings (
                    id, hn_id, context_key, ts, embedding
                  ) VALUES ($1, $2, $3, to_timestamp($4), $5::vector)
                  ON CONFLICT (id) DO NOTHING
                  `,
                  [sourceId, item.id, contextKey, item.time, `[${embedding.join(",")}]`]
                );
              } else if (embedding.length) {
                this.log("warn", "embedding dimension mismatch", { expected: embedDim, got: embedding.length });
              }
            } catch (embErr) {
              this.log("warn", "embedding failed for story (continuing)", {
                hnId: item.id,
                err: embErr instanceof Error ? { message: embErr.message } : embErr,
              });
            }

            totalPublished++;
          }

          if (this.settings.includeComments) {
            const comments = await this.fetchTopComments(item);
            for (const comment of comments) {
              if (!comment.time) continue;
              const commentSourceId = `hn-comment-${comment.id}`;
              await client.query(
                `
                INSERT INTO mod_hackernews.comments (
                  id, hn_id, story_hn_id, author, hn_text, hn_time, ts, payload
                ) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($6), $7)
                ON CONFLICT (hn_id) DO NOTHING
                `,
                [
                  commentSourceId,
                  comment.id,
                  item.id,
                  comment.by ?? "unknown",
                  comment.text ? this.stripHtml(comment.text) : null,
                  comment.time,
                  comment,
                ]
              );
            }
          }

          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          this.log("error", "failed to persist story (continuing)", {
            hnId: item.id,
            err: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
          });
        } finally {
          client.release();
        }
      }
    }

    this.log("info", "hackernews collect finished", {
      insertedOrUpdated: totalInserted,
      publishedNew: totalPublished,
      feedsPolled,
    });
    return { insertedOrUpdated: totalInserted, publishedNew: totalPublished, feedsPolled };
  }

  async refreshContexts(params: { lookbackHours: number }): Promise<{
    updated: number;
    aiSummaries: number;
    fallbackSummaries: number;
    embeddingsInserted: number;
    avgTokenRate?: number;
  }> {
    const cutoff = new Date(Date.now() - params.lookbackHours * 3600_000);
    const res = await this.db.query(
      `
      SELECT hn_id, title, url, hn_text, author, score, comment_count, feed_type, hn_time
      FROM mod_hackernews.stories
      WHERE ts >= $1
      ORDER BY score DESC, ts DESC
      `,
      [cutoff]
    );

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of res.rows as StoryRow[]) {
      const contextKey = `story:${row.hn_id}`;
      const sourceId = `hn-${row.hn_id}`;
      const msgId = uuidv5(sourceId, UUID_NAMESPACE);

      const prior = await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["hackernews", contextKey]
      );
      const priorSummary = String(prior.rows?.[0]?.summaryLong ?? "");

      let commentTexts: string[] = [];
      if (this.settings.includeComments) {
        const commentRows = await this.db.query(
          `SELECT hn_text FROM mod_hackernews.comments WHERE story_hn_id = $1 ORDER BY hn_time ASC LIMIT $2`,
          [row.hn_id, this.contextTopK]
        );
        commentTexts = (commentRows.rows as Array<{ hn_text: string | null }>)
          .map((r) => String(r.hn_text ?? ""))
          .filter(Boolean);
      }

      const storyContent = [row.title, row.url, row.text].filter(Boolean).join("\n");
      if (!storyContent && commentTexts.length === 0) {
        const summaryShort = `${row.title ?? "HN Story"}`.slice(0, 128);
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: summaryShort,
          keyPoints: [],
        });
        fallbackSummaries++;
        updated++;
        continue;
      }

      const prompt = [
        priorSummary ? `Prior summary:\n${priorSummary}` : "",
        `Story: ${row.title ?? "(no title)"}`,
        row.url ? `URL: ${row.url}` : "",
        row.text ? `Text: ${row.text}` : "",
        `Score: ${row.score} | Comments: ${row.comment_count} | Feed: ${row.feed_type}`,
        ...(commentTexts.length > 0
          ? ["Top comments:", ...commentTexts.map((c, i) => `(${i + 1}) ${c}`)]
          : []),
      ]
        .filter(Boolean)
        .join("\n");
      const maxPromptChars = 8000;
      const promptText = prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;

      try {
        const aiSummary = await this.aiGenerate(promptText);

        const contextEmbedding = await this.aiEmbed(aiSummary.summaryLong);
        if (contextEmbedding.length) embeddingsInserted++;
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
      } catch (err) {
        const summaryShort = `${row.title ?? "HN Story"}`.slice(0, 128);
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: storyContent,
          keyPoints: [],
        });
        fallbackSummaries++;
        this.log("warn", "ai summary failed, using fallback", {
          hnId: row.hn_id,
          err: err instanceof Error ? { message: err.message } : err,
        });
      }
      updated++;
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
