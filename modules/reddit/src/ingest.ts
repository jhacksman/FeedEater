import Snoowrap from "snoowrap";
import { v5 as uuidv5 } from "uuid";

import {
  ContextUpdatedEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  subjectFor,
} from "@feedeater/core";
import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";

export type RedditSettings = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
  feedTypes: string[];
  lookbackHours: number;
  postsPerFeed: number;
  minScore: number;
  excludeNSFW: boolean;
  rateLimitDelay: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

interface RedditPost {
  id: string;
  name: string;
  title: string;
  selftext: string;
  url: string;
  author: string;
  subreddit: string;
  score: number;
  numComments: number;
  createdUtc: number;
  isNSFW: boolean;
  isSelfPost: boolean;
  permalink: string;
  flairText: string | null;
  upvoteRatio: number;
}

const UUID_NAMESPACE = "8a7b6c5d-4e3f-2a1b-9c8d-7e6f5a4b3c2d";

export function parseRedditSettingsFromInternal(raw: Record<string, unknown>): RedditSettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const clientId = String(raw.clientId ?? "");
  const clientSecret = String(raw.clientSecret ?? "");
  const username = String(raw.username ?? "");
  const password = String(raw.password ?? "");
  const userAgent = String(raw.userAgent ?? "");
  const feedTypes = String(raw.feedTypes ?? "home")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const postsPerFeed = raw.postsPerFeed ? Number(raw.postsPerFeed) : 25;
  const minScore = raw.minScore ? Number(raw.minScore) : 0;
  const excludeNSFW = String(raw.excludeNSFW ?? "true") !== "false";
  const rateLimitDelay = raw.rateLimitDelay ? Number(raw.rateLimitDelay) : 1000;

  const defaultContextPrompt =
    "You are summarizing a Reddit post and its top comments. Summarize ONLY the content provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided Reddit content in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!clientId) throw new Error('Reddit setting "clientId" is required');
  if (!clientSecret) throw new Error('Reddit setting "clientSecret" is required');
  if (!username) throw new Error('Reddit setting "username" is required');
  if (!password) throw new Error('Reddit setting "password" is required');
  if (!userAgent) throw new Error('Reddit setting "userAgent" is required');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Reddit setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    clientId,
    clientSecret,
    username,
    password,
    userAgent,
    feedTypes,
    lookbackHours,
    postsPerFeed,
    minScore,
    excludeNSFW,
    rateLimitDelay,
    contextPrompt,
    contextPromptFallback,
  };
}

export class RedditIngestor {
  private reddit: Snoowrap;
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.reddit.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "reddit",
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
    private readonly settings: RedditSettings,
    private readonly db: DbLike,
    private readonly nats: NatsLike,
    private readonly sc: StringCodecLike,
    opts: { apiBaseUrl: string; internalToken: string; contextTopK: number; embedDim: number }
  ) {
    this.reddit = new Snoowrap({
      userAgent: settings.userAgent,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      username: settings.username,
      password: settings.password,
    });

    this.reddit.config({
      requestDelay: settings.rateLimitDelay,
      requestTimeout: 30000,
      continueAfterRatelimitError: true,
      warnings: false,
    });

    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
  }

  private normalizePost(submission: {
    id: string;
    name: string;
    title: string;
    selftext: string;
    url: string;
    author: { name: string } | string;
    subreddit: { display_name: string } | string;
    score: number;
    num_comments: number;
    created_utc: number;
    over_18: boolean;
    is_self: boolean;
    permalink: string;
    link_flair_text: string | null;
    upvote_ratio: number;
  }): RedditPost {
    const authorName =
      typeof submission.author === "string"
        ? submission.author
        : submission.author?.name ?? "[deleted]";
    const subredditName =
      typeof submission.subreddit === "string"
        ? submission.subreddit
        : submission.subreddit?.display_name ?? "unknown";

    return {
      id: submission.id,
      name: submission.name,
      title: submission.title || "",
      selftext: submission.selftext || "",
      url: submission.url || "",
      author: authorName,
      subreddit: subredditName,
      score: submission.score ?? 0,
      numComments: submission.num_comments ?? 0,
      createdUtc: submission.created_utc ?? Date.now() / 1000,
      isNSFW: Boolean(submission.over_18),
      isSelfPost: Boolean(submission.is_self),
      permalink: submission.permalink || "",
      flairText: submission.link_flair_text ?? null,
      upvoteRatio: submission.upvote_ratio ?? 0,
    };
  }

  private async fetchHomeFeed(limit: number): Promise<RedditPost[]> {
    this.log("info", "fetching /best home feed", { limit });
    const posts: RedditPost[] = [];

    try {
      const listing = await this.reddit.getBest({ limit: Math.min(limit, 100) });
      for (const submission of listing) {
        const post = this.normalizePost(submission);

        // Skip deleted content
        if (post.author === "[deleted]" || post.author === "[removed]") {
          continue;
        }

        // Apply filters
        if (this.settings.excludeNSFW && post.isNSFW) {
          continue;
        }
        if (post.score < this.settings.minScore) {
          continue;
        }

        posts.push(post);
      }

      this.log("info", "fetched home feed posts", { count: posts.length, requested: limit });
    } catch (err) {
      this.log(
        "error",
        "failed to fetch home feed",
        err instanceof Error ? { name: err.name, message: err.message } : { err }
      );
      throw err;
    }

    return posts;
  }

  private async fetchSubredditPosts(subreddit: string, limit: number): Promise<RedditPost[]> {
    const subName = subreddit.replace(/^r\//, "");
    this.log("info", "fetching subreddit posts", { subreddit: subName, limit });
    const posts: RedditPost[] = [];

    try {
      const listing = await this.reddit.getHot(subName, { limit: Math.min(limit, 100) });
      for (const submission of listing) {
        const post = this.normalizePost(submission);

        if (post.author === "[deleted]" || post.author === "[removed]") {
          continue;
        }
        if (this.settings.excludeNSFW && post.isNSFW) {
          continue;
        }
        if (post.score < this.settings.minScore) {
          continue;
        }

        posts.push(post);
      }

      this.log("info", "fetched subreddit posts", { subreddit: subName, count: posts.length });
    } catch (err) {
      this.log(
        "warn",
        "failed to fetch subreddit (continuing)",
        err instanceof Error ? { subreddit: subName, name: err.name, message: err.message } : { subreddit: subName, err }
      );
    }

    return posts;
  }

  private async fetchSavedContent(limit: number): Promise<RedditPost[]> {
    this.log("info", "fetching saved content", { limit });
    const posts: RedditPost[] = [];

    try {
      const listing = await this.reddit.getMe().getSavedContent({ limit: Math.min(limit, 100) });
      for (const item of listing) {
        // Saved content can include comments; only process submissions
        if (!("title" in item)) continue;
        const submission = item as unknown as {
          id: string;
          name: string;
          title: string;
          selftext: string;
          url: string;
          author: { name: string } | string;
          subreddit: { display_name: string } | string;
          score: number;
          num_comments: number;
          created_utc: number;
          over_18: boolean;
          is_self: boolean;
          permalink: string;
          link_flair_text: string | null;
          upvote_ratio: number;
        };

        const post = this.normalizePost(submission);

        if (post.author === "[deleted]" || post.author === "[removed]") {
          continue;
        }
        if (this.settings.excludeNSFW && post.isNSFW) {
          continue;
        }

        posts.push(post);
      }

      this.log("info", "fetched saved content", { count: posts.length });
    } catch (err) {
      this.log(
        "warn",
        "failed to fetch saved content (continuing)",
        err instanceof Error ? { name: err.name, message: err.message } : { err }
      );
    }

    return posts;
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
        ownerModule: "reddit",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(subjectFor("reddit", "contextUpdated"), this.sc.encode(JSON.stringify(contextEvent)));
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_reddit");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_reddit.reddit_posts (
        id text PRIMARY KEY,
        post_id text NOT NULL,
        subreddit text NOT NULL,
        title text NOT NULL,
        selftext text,
        url text,
        author text,
        score int,
        num_comments int,
        created_utc double precision NOT NULL,
        ts timestamptz NOT NULL,
        is_nsfw boolean NOT NULL DEFAULT false,
        is_self boolean NOT NULL DEFAULT false,
        permalink text,
        flair_text text,
        upvote_ratio double precision,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS reddit_posts_ts_idx ON mod_reddit.reddit_posts (ts)`);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS reddit_posts_subreddit_ts_idx ON mod_reddit.reddit_posts (subreddit, ts)`
    );

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_reddit.reddit_post_embeddings (
        id text PRIMARY KEY,
        subreddit text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_reddit.reddit_post_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS reddit_post_embeddings_context_idx ON mod_reddit.reddit_post_embeddings (context_key, ts)`
    );
    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS reddit_post_embeddings_vec_idx ON mod_reddit.reddit_post_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS mod_reddit.reddit_post_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }

    // Pagination state table for cursor-based pagination
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_reddit.pagination_state (
        feed_key text PRIMARY KEY,
        after_cursor text,
        last_fetched_at timestamptz NOT NULL DEFAULT now(),
        posts_fetched int NOT NULL DEFAULT 0
      )
    `);
  }

  async collectAndPersist(): Promise<{ insertedOrUpdated: number; publishedNew: number }> {
    this.log("info", "reddit collect starting", { feedTypes: this.settings.feedTypes, lookbackHours: this.settings.lookbackHours });

    const allPosts: RedditPost[] = [];
    const lookbackTime = Date.now() / 1000 - this.settings.lookbackHours * 3600;

    for (const feedType of this.settings.feedTypes) {
      let posts: RedditPost[] = [];

      if (feedType === "home") {
        posts = await this.fetchHomeFeed(this.settings.postsPerFeed);
      } else if (feedType === "saved") {
        posts = await this.fetchSavedContent(this.settings.postsPerFeed);
      } else if (feedType.startsWith("r/") || !feedType.includes("/")) {
        posts = await this.fetchSubredditPosts(feedType, this.settings.postsPerFeed);
      } else {
        this.log("warn", "unknown feed type, skipping", { feedType });
        continue;
      }

      // Filter by lookback time
      posts = posts.filter((p) => p.createdUtc >= lookbackTime);
      allPosts.push(...posts);
    }

    if (allPosts.length === 0) {
      this.log("info", "no posts to collect");
      return { insertedOrUpdated: 0, publishedNew: 0 };
    }

    // Deduplicate by post ID
    const seenIds = new Set<string>();
    const uniquePosts = allPosts.filter((p) => {
      if (seenIds.has(p.id)) return false;
      seenIds.add(p.id);
      return true;
    });

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      let count = 0;
      let published = 0;

      for (const post of uniquePosts) {
        const sourceId = `reddit-${post.subreddit}-${post.id}`;
        const contextKey = `${post.subreddit}:${post.id}`;

        const upsert = (await client.query(
          `
          INSERT INTO mod_reddit.reddit_posts (
            id, post_id, subreddit, title, selftext, url,
            author, score, num_comments, created_utc, ts,
            is_nsfw, is_self, permalink, flair_text, upvote_ratio, payload
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, to_timestamp($10),
            $11, $12, $13, $14, $15, $16
          )
          ON CONFLICT (id) DO UPDATE SET
            score = EXCLUDED.score,
            num_comments = EXCLUDED.num_comments,
            upvote_ratio = EXCLUDED.upvote_ratio,
            payload = EXCLUDED.payload,
            collected_at = now()
          RETURNING (xmax = 0) AS inserted
          `,
          [
            sourceId,
            post.id,
            post.subreddit,
            post.title,
            post.selftext || null,
            post.url || null,
            post.author,
            post.score,
            post.numComments,
            post.createdUtc,
            post.isNSFW,
            post.isSelfPost,
            post.permalink || null,
            post.flairText,
            post.upvoteRatio,
            post as unknown,
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };
        count++;

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const msgId = uuidv5(sourceId, UUID_NAMESPACE);
          const messageBody = post.selftext || post.title;
          const redditLink = `https://reddit.com${post.permalink}`;

          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: new Date(post.createdUtc * 1000).toISOString(),
            source: { module: "reddit", stream: post.subreddit },
            realtime: false,
            Message: messageBody,
            contextRef: { ownerModule: "reddit", sourceKey: contextKey },
            followMePanel: {
              module: "reddit",
              panelId: "post",
              href: redditLink,
              label: "Open on Reddit",
            },
            From: post.author,
            likes: post.score,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "reddit",
              subreddit: post.subreddit,
              author: post.author,
              isNSFW: post.isNSFW,
              isSelfPost: post.isSelfPost,
              commentCount: post.numComments,
              title: post.title,
            },
          });

          const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
          this.nats.publish(subjectFor("reddit", "messageCreated"), this.sc.encode(JSON.stringify(event)));

          // Generate embedding for the post
          const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
          const textToEmbed = `${post.title}\n\n${post.selftext || ""}`.trim();
          const embedding = textToEmbed ? await this.aiEmbed(textToEmbed) : [];
          if (embedding.length && (!Number.isFinite(embedDim) || embedding.length === embedDim)) {
            await client.query(
              `
              INSERT INTO mod_reddit.reddit_post_embeddings (
                id, subreddit, context_key, ts, embedding
              ) VALUES ($1, $2, $3, to_timestamp($4), $5::vector)
              ON CONFLICT (id) DO NOTHING
              `,
              [sourceId, post.subreddit, contextKey, post.createdUtc, `[${embedding.join(",")}]`]
            );
          } else if (embedding.length) {
            this.log("warn", "embedding dimension mismatch", {
              expected: embedDim,
              got: embedding.length,
            });
          }
          published++;
        }
      }

      await client.query("COMMIT");
      this.log("info", "reddit collect finished", { insertedOrUpdated: count, publishedNew: published });
      return { insertedOrUpdated: count, publishedNew: published };
    } catch (e) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "reddit collect failed (job will fail)",
        e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e
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
    const res = (await this.db.query(
      `
      SELECT DISTINCT ON (subreddit, post_id)
        id,
        post_id,
        subreddit,
        title,
        selftext,
        author,
        score,
        num_comments,
        ts
      FROM mod_reddit.reddit_posts
      WHERE ts >= $1
      ORDER BY subreddit, post_id, ts DESC
      `,
      [cutoff]
    )) as { rows: Array<{
      id: string;
      post_id: string;
      subreddit: string;
      title: string;
      selftext: string | null;
      author: string;
      score: number;
      num_comments: number;
    }> };

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of res.rows as Array<{
      id: string;
      post_id: string;
      subreddit: string;
      title: string;
      selftext: string | null;
      author: string;
      score: number;
      num_comments: number;
    }>) {
      const contextKey = `${row.subreddit}:${row.post_id}`;
      const msgId = uuidv5(row.id, UUID_NAMESPACE);

      // For posts without much text, use a simple summary
      const postContent = `${row.title}\n\n${row.selftext || ""}`.trim();
      if (postContent.length < 100) {
        const summaryShort = `${row.title.slice(0, 120)}...`;
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: postContent,
          keyPoints: [],
        });
        fallbackSummaries++;
        updated++;
        continue;
      }

      // Check for prior summary
      const prior = (await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["reddit", contextKey]
      )) as { rows?: Array<{ summaryLong?: string }> };
      const priorSummary = String(prior.rows?.[0]?.summaryLong ?? "");

      // Build the prompt
      const prompt = [
        priorSummary ? `Prior summary:\n${priorSummary}` : "",
        "Summarize ONLY the Reddit post below. Do not make suggestions or ask questions.",
        `Title: ${row.title}`,
        `Author: u/${row.author}`,
        `Score: ${row.score} | Comments: ${row.num_comments}`,
        row.selftext ? `Content:\n${row.selftext}` : "",
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
        this.log("warn", "ai summary failed for post, using fallback", {
          contextKey,
          error: err instanceof Error ? err.message : String(err),
        });
        const summaryShort = `${row.title.slice(0, 120)}...`;
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: postContent.slice(0, 1000),
          keyPoints: [],
        });
        fallbackSummaries++;
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
