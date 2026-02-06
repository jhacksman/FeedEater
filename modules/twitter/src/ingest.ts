import { Rettiwt } from "rettiwt-api";
import { v5 as uuidv5 } from "uuid";

type DbPool = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  connect(): Promise<{
    query(sql: string, params?: unknown[]): Promise<unknown>;
    release(): void;
  }>;
};

type NatsConn = {
  publish(subject: string, data: Uint8Array): void;
};

type StrCodec = {
  encode(s: string): Uint8Array;
};

import {
  ContextUpdatedEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  subjectFor,
} from "@feedeater/core";

import { FeedSourceSchema, type FeedSource } from "../settings.js";

const UUID_NAMESPACE = "8f14e45f-ceea-467f-a6f4-12c7f9b8c3e1";

export type TwitterSettings = {
  enabled: boolean;
  authMode: "guest" | "user";
  apiKey: string;
  feedSources: FeedSource[];
  tweetsPerRequest: number;
  lookbackHours: number;
  requestDelayMs: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

type RettiwtTweet = {
  id: string;
  fullText: string;
  createdAt: string;
  replyCount: number;
  retweetCount: number;
  likeCount: number;
  quoteCount: number;
  viewCount?: number;
  conversationId?: string;
  replyTo?: string;
  quoted?: string;
  retweetedTweet?: RettiwtTweet;
  tweetBy: {
    id: string;
    userName: string;
    fullName: string;
  };
};

export function parseTwitterSettingsFromInternal(
  raw: Record<string, unknown>
): TwitterSettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const authMode = String(raw.authMode ?? "guest").trim() as "guest" | "user";
  const apiKey = String(raw.apiKey ?? "").trim();
  const tweetsPerRequest = raw.tweetsPerRequest
    ? Number(raw.tweetsPerRequest)
    : 20;
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const requestDelayMs = raw.requestDelayMs ? Number(raw.requestDelayMs) : 5000;

  const feedSourcesRaw = String(raw.feedSources ?? "[]").trim();
  let feedSources: FeedSource[] = [];
  try {
    const parsed = JSON.parse(feedSourcesRaw);
    if (Array.isArray(parsed)) {
      feedSources = parsed
        .map((item) => {
          try {
            return FeedSourceSchema.parse(item);
          } catch {
            return null;
          }
        })
        .filter((x): x is FeedSource => x !== null);
    }
  } catch {
    feedSources = [{ type: "user", username: "elonmusk" }];
  }

  if (feedSources.length === 0) {
    feedSources = [{ type: "user", username: "elonmusk" }];
  }

  const defaultContextPrompt =
    "You are summarizing a Twitter/X thread or conversation. Summarize ONLY the tweets provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs covering the main topic and key points.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided tweets in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";

  const contextPrompt =
    String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback =
    String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!Number.isFinite(tweetsPerRequest) || tweetsPerRequest <= 0) {
    throw new Error('Twitter setting "tweetsPerRequest" must be a positive number');
  }
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Twitter setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    authMode,
    apiKey,
    feedSources,
    tweetsPerRequest,
    lookbackHours,
    requestDelayMs,
    contextPrompt,
    contextPromptFallback,
  };
}

export class TwitterIngestor {
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;
  private rettiwt: Rettiwt | null = null;

  constructor(
    private readonly settings: TwitterSettings,
    private readonly db: DbPool,
    private readonly nats: NatsConn,
    private readonly sc: StrCodec,
    opts: {
      apiBaseUrl: string;
      internalToken: string;
      contextTopK: number;
      embedDim: number;
    }
  ) {
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: unknown
  ) {
    try {
      this.nats.publish(
        "feedeater.twitter.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "twitter",
            source: "collector",
            at: new Date().toISOString(),
            message,
            meta,
          })
        )
      );
    } catch {
      // ignore logging errors
    }
  }

  private async initRettiwt(): Promise<Rettiwt> {
    if (this.rettiwt) {
      return this.rettiwt;
    }

    const { authMode, apiKey } = this.settings;

    if (authMode === "user" && apiKey) {
      this.log("info", "initializing rettiwt with API key (user auth)");
      this.rettiwt = new Rettiwt({ apiKey });
      return this.rettiwt;
    }

    if (authMode === "user" && !apiKey) {
      this.log("warn", "user auth mode requires an API key - falling back to guest mode");
    }

    this.log("info", "initializing rettiwt in guest mode");
    this.rettiwt = new Rettiwt();
    return this.rettiwt;
  }

  private async fetchUserTimeline(username: string, count: number): Promise<RettiwtTweet[]> {
    const rettiwt = await this.initRettiwt();
    this.log("debug", "fetching user timeline", { username, count });

    try {
      const user = await rettiwt.user.details(username);
      if (!user?.id) {
        this.log("warn", "user not found", { username });
        return [];
      }

      const timeline = await rettiwt.user.timeline(user.id, count);
      const tweets = (timeline?.list ?? []) as unknown as RettiwtTweet[];
      this.log("info", `fetched ${tweets.length} tweets from @${username}`);
      return tweets;
    } catch (err) {
      this.log("error", "failed to fetch user timeline", {
        username,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async fetchHomeTimeline(): Promise<RettiwtTweet[]> {
    const rettiwt = await this.initRettiwt();
    this.log("debug", "fetching home timeline");

    if (this.settings.authMode !== "user") {
      this.log("warn", "home timeline requires user authentication");
      return [];
    }

    try {
      const timeline = await rettiwt.user.recommended();
      const tweets = (timeline?.list ?? []) as unknown as RettiwtTweet[];
      this.log("info", `fetched ${tweets.length} tweets from home timeline`);
      return tweets;
    } catch (err) {
      this.log("error", "failed to fetch home timeline", {
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async fetchListTimeline(listId: string, count: number): Promise<RettiwtTweet[]> {
    const rettiwt = await this.initRettiwt();
    this.log("debug", "fetching list timeline", { listId, count });

    if (this.settings.authMode !== "user") {
      this.log("warn", "list timeline requires user authentication");
      return [];
    }

    try {
      const timeline = await rettiwt.list.tweets(listId, count);
      const tweets = (timeline?.list ?? []) as unknown as RettiwtTweet[];
      this.log("info", `fetched ${tweets.length} tweets from list ${listId}`);
      return tweets;
    } catch (err) {
      this.log("error", "failed to fetch list timeline", {
        listId,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async fetchSearch(query: string, count: number): Promise<RettiwtTweet[]> {
    const rettiwt = await this.initRettiwt();
    this.log("debug", "fetching search results", { query, count });

    if (this.settings.authMode !== "user") {
      this.log("warn", "search requires user authentication");
      return [];
    }

    try {
      const results = await rettiwt.tweet.search({ includeWords: [query] }, count);
      const tweets = (results?.list ?? []) as unknown as RettiwtTweet[];
      this.log("info", `fetched ${tweets.length} tweets for search "${query}"`);
      return tweets;
    } catch (err) {
      this.log("error", "failed to fetch search results", {
        query,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseCreatedAt(createdAt: string): Date {
    const date = new Date(createdAt);
    if (isNaN(date.getTime())) {
      return new Date();
    }
    return date;
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
        ownerModule: "twitter",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(
      subjectFor("twitter", "contextUpdated"),
      this.sc.encode(JSON.stringify(contextEvent))
    );
  }

  private getFeedSourceId(source: FeedSource): string {
    switch (source.type) {
      case "home":
        return "home";
      case "list":
        return `list:${source.listId}`;
      case "user":
        return `user:${source.username}`;
      case "search":
        return `search:${source.query}`;
    }
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_twitter");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_twitter.tweets (
        id text PRIMARY KEY,
        conversation_id text,
        author_id text NOT NULL,
        author_username text NOT NULL,
        author_name text,
        text text,
        created_at timestamptz NOT NULL,
        reply_count int,
        retweet_count int,
        like_count int,
        quote_count int,
        view_count int,
        is_retweet boolean DEFAULT false,
        is_quote boolean DEFAULT false,
        quoted_tweet_id text,
        retweeted_tweet_id text,
        in_reply_to_id text,
        feed_source text,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.db.query(`
      CREATE INDEX IF NOT EXISTS tweets_created_at_idx 
      ON mod_twitter.tweets (created_at)
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS tweets_conversation_id_idx 
      ON mod_twitter.tweets (conversation_id)
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS tweets_author_idx 
      ON mod_twitter.tweets (author_username)
    `);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_twitter.tweet_embeddings (
        id text PRIMARY KEY,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);

    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_twitter.tweet_embeddings 
         ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }

    await this.db.query(`
      CREATE INDEX IF NOT EXISTS tweet_embeddings_context_idx 
      ON mod_twitter.tweet_embeddings (context_key, ts)
    `);

    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(`
        CREATE INDEX IF NOT EXISTS tweet_embeddings_vec_idx 
        ON mod_twitter.tweet_embeddings 
        USING ivfflat (embedding vector_cosine_ops)
      `);
    } else {
      await this.db.query(`DROP INDEX IF EXISTS mod_twitter.tweet_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }
  }

  async collectAndPersist(): Promise<{
    insertedOrUpdated: number;
    publishedNew: number;
  }> {
    this.log("info", "twitter collect starting", {
      feedSources: this.settings.feedSources,
      tweetsPerRequest: this.settings.tweetsPerRequest,
      authMode: this.settings.authMode,
    });

    const allTweets: Array<{ tweet: RettiwtTweet; source: string }> = [];

    for (const source of this.settings.feedSources) {
      try {
        let tweets: RettiwtTweet[] = [];
        const sourceId = this.getFeedSourceId(source);

        switch (source.type) {
          case "home":
            tweets = await this.fetchHomeTimeline();
            break;
          case "list":
            tweets = await this.fetchListTimeline(source.listId, this.settings.tweetsPerRequest);
            break;
          case "user":
            tweets = await this.fetchUserTimeline(source.username, this.settings.tweetsPerRequest);
            break;
          case "search":
            tweets = await this.fetchSearch(source.query, this.settings.tweetsPerRequest);
            break;
        }

        this.log("info", `fetched ${tweets.length} tweets from ${sourceId}`);
        for (const tweet of tweets) {
          allTweets.push({ tweet, source: sourceId });
        }

        if (this.settings.requestDelayMs > 0) {
          await this.sleep(this.settings.requestDelayMs);
        }
      } catch (err) {
        this.log(
          "error",
          "failed to fetch feed source",
          err instanceof Error
            ? { source, message: err.message }
            : { source, err }
        );
      }
    }

    if (allTweets.length === 0) {
      this.log("info", "no tweets collected");
      return { insertedOrUpdated: 0, publishedNew: 0 };
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      let count = 0;
      let published = 0;

      for (const { tweet, source } of allTweets) {
        const createdAt = this.parseCreatedAt(tweet.createdAt);
        const authorId = tweet.tweetBy.id;
        const authorUsername = tweet.tweetBy.userName;
        const authorName = tweet.tweetBy.fullName;
        const isRetweet = Boolean(tweet.retweetedTweet);
        const isQuote = Boolean(tweet.quoted);

        const upsert = (await client.query(
          `
          INSERT INTO mod_twitter.tweets (
            id, conversation_id, author_id, author_username, author_name,
            text, created_at, reply_count, retweet_count, like_count,
            quote_count, view_count, is_retweet, is_quote, quoted_tweet_id,
            retweeted_tweet_id, in_reply_to_id, feed_source, payload
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15,
            $16, $17, $18, $19
          )
          ON CONFLICT (id) DO UPDATE SET
            text = EXCLUDED.text,
            reply_count = EXCLUDED.reply_count,
            retweet_count = EXCLUDED.retweet_count,
            like_count = EXCLUDED.like_count,
            quote_count = EXCLUDED.quote_count,
            view_count = EXCLUDED.view_count,
            payload = EXCLUDED.payload,
            collected_at = now()
          RETURNING (xmax = 0) AS inserted
          `,
          [
            tweet.id,
            tweet.conversationId ?? tweet.id,
            authorId,
            authorUsername,
            authorName,
            tweet.fullText,
            createdAt,
            tweet.replyCount ?? 0,
            tweet.retweetCount ?? 0,
            tweet.likeCount ?? 0,
            tweet.quoteCount ?? 0,
            tweet.viewCount ?? null,
            isRetweet,
            isQuote,
            tweet.quoted ?? null,
            tweet.retweetedTweet?.id ?? null,
            tweet.replyTo ?? null,
            source,
            JSON.stringify(tweet),
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };
        count++;

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const sourceId = `twitter-${tweet.id}`;
          const msgId = uuidv5(sourceId, UUID_NAMESPACE);
          const contextKey = `thread:${tweet.conversationId ?? tweet.id}`;
          const tweetUrl = `https://x.com/${authorUsername}/status/${tweet.id}`;

          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: createdAt.toISOString(),
            source: { module: "twitter", stream: source },
            realtime: false,
            Message: tweet.fullText,
            contextRef: { ownerModule: "twitter", sourceKey: contextKey },
            followMePanel: {
              module: "twitter",
              panelId: "tweet",
              href: tweetUrl,
              label: "Open on X",
            },
            From: `@${authorUsername}`,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "twitter",
              authorId,
              authorUsername,
              isRetweet,
              isQuote,
              likeCount: tweet.likeCount ?? 0,
              retweetCount: tweet.retweetCount ?? 0,
            },
          });

          const event = MessageCreatedEventSchema.parse({
            type: "MessageCreated",
            message: normalized,
          });
          this.nats.publish(
            subjectFor("twitter", "messageCreated"),
            this.sc.encode(JSON.stringify(event))
          );

          if (tweet.fullText) {
            try {
              const embedText = `@${authorUsername}: ${tweet.fullText}`;
              const embedding = await this.aiEmbed(embedText);
              const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;

              if (embedding.length === embedDim) {
                await client.query(
                  `
                  INSERT INTO mod_twitter.tweet_embeddings (
                    id, context_key, ts, embedding
                  ) VALUES ($1, $2, $3, $4::vector)
                  ON CONFLICT (id) DO NOTHING
                  `,
                  [
                    sourceId,
                    contextKey,
                    createdAt,
                    `[${embedding.join(",")}]`,
                  ]
                );
              } else {
                this.log("warn", "embedding dimension mismatch", {
                  expected: embedDim,
                  got: embedding.length,
                });
              }
            } catch (embedErr) {
              this.log(
                "warn",
                "failed to generate embedding",
                embedErr instanceof Error
                  ? { message: embedErr.message }
                  : { err: embedErr }
              );
            }
          }

          published++;
        }
      }

      await client.query("COMMIT");
      this.log("info", "twitter collect finished", {
        insertedOrUpdated: count,
        publishedNew: published,
      });
      return { insertedOrUpdated: count, publishedNew: published };
    } catch (e) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "twitter collect failed",
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

    const res = (await this.db.query(
      `
      SELECT DISTINCT conversation_id, MIN(created_at) as first_tweet
      FROM mod_twitter.tweets
      WHERE created_at >= $1 AND conversation_id IS NOT NULL
      GROUP BY conversation_id
      ORDER BY first_tweet DESC
      LIMIT 100
      `,
      [cutoff]
    )) as { rows: Array<{ conversation_id: string; first_tweet: Date }> };

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of res.rows) {
      const contextKey = `thread:${row.conversation_id}`;

      const tweetsRes = (await this.db.query(
        `
        SELECT id, author_username, text, created_at
        FROM mod_twitter.tweets
        WHERE conversation_id = $1
        ORDER BY created_at ASC
        LIMIT 50
        `,
        [row.conversation_id]
      )) as {
        rows: Array<{
          id: string;
          author_username: string;
          text: string;
          created_at: Date;
        }>;
      };

      const tweets = tweetsRes.rows;

      if (tweets.length === 0) continue;

      if (tweets.length === 1) {
        const tweet = tweets[0]!;
        const summaryShort = `Tweet by @${tweet.author_username}`.slice(0, 128);
        const sourceId = `twitter-${tweet.id}`;
        const msgId = uuidv5(sourceId, UUID_NAMESPACE);

        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: tweet.text || summaryShort,
          keyPoints: [],
        });
        fallbackSummaries++;
        updated++;
        continue;
      }

      const tweetTexts = tweets
        .map((t, i) => `(${i + 1}) @${t.author_username}: ${t.text}`)
        .join("\n");

      const prompt = [
        "Summarize this Twitter/X thread or conversation.",
        "Recent tweets:",
        tweetTexts,
      ].join("\n");

      const maxPromptChars = 8000;
      const promptText =
        prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;

      try {
        const aiSummary = await this.aiGenerate(promptText);
        const firstTweet = tweets[0]!;
        const sourceId = `twitter-${firstTweet.id}`;
        const msgId = uuidv5(sourceId, UUID_NAMESPACE);

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
        updated++;
      } catch (err) {
        this.log(
          "warn",
          "failed to generate context summary",
          err instanceof Error
            ? { contextKey, message: err.message }
            : { contextKey, err }
        );
        const firstTweet = tweets[0]!;
        const authorList = [...new Set(tweets.map((t) => `@${t.author_username}`))].slice(0, 3);
        const summaryShort = `Thread with ${authorList.join(", ")}`.slice(0, 128);
        const sourceId = `twitter-${firstTweet.id}`;
        const msgId = uuidv5(sourceId, UUID_NAMESPACE);

        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: tweetTexts.slice(0, 500),
          keyPoints: [],
        });
        fallbackSummaries++;
        updated++;
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
