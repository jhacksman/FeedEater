import { BskyAgent, AtpSessionData, AtpSessionEvent } from "@atproto/api";
import { v5 as uuidv5 } from "uuid";
import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";

import {
  ContextUpdatedEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  subjectFor,
} from "@feedeater/core";

export type BlueskySettings = {
  enabled: boolean;
  identifier: string;
  appPassword: string;
  serviceUrl: string;
  lookbackHours: number;
  contextPrompt: string;
  contextPromptFallback: string;
  nonThreadContextTemplate: string;
};

type BlueskyPost = {
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  authorDisplayName: string | null;
  createdAt: string;
  text: string;
  replyRootUri: string | null;
  replyParentUri: string | null;
  embedType: string | null;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  payload: Record<string, unknown>;
  isRepost: boolean;
};

const UUID_NAMESPACE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

/**
 * Parse AT URI into components
 * Format: at://did:plc:xxx/collection/rkey
 */
function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const did = match[1];
  const collection = match[2];
  const rkey = match[3];
  if (!did || !collection || !rkey) return null;
  return { did, collection, rkey };
}

export function parseBlueskySettingsFromInternal(raw: Record<string, unknown>): BlueskySettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const identifier = String(raw.identifier ?? "");
  const appPassword = String(raw.appPassword ?? "");
  const serviceUrl = String(raw.serviceUrl ?? "https://bsky.social");
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;

  const defaultContextPrompt =
    "You are summarizing the provided Bluesky posts/thread. Summarize ONLY the posts provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided posts in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";
  const defaultNonThreadContextTemplate = "Post by {author}";

  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;
  const nonThreadContextTemplate =
    String(raw.nonThreadContextTemplate ?? "").trim() || defaultNonThreadContextTemplate;

  if (!identifier) throw new Error('Bluesky setting "identifier" is required');
  if (!appPassword) throw new Error('Bluesky setting "appPassword" is required');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Bluesky setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    identifier,
    appPassword,
    serviceUrl,
    lookbackHours,
    contextPrompt,
    contextPromptFallback,
    nonThreadContextTemplate,
  };
}

export class BlueskyIngestor {
  private agent: BskyAgent;
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.bluesky.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "bluesky",
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
    private readonly settings: BlueskySettings,
    private readonly db: DbLike,
    private readonly nats: NatsLike,
    private readonly sc: StringCodecLike,
    opts: { apiBaseUrl: string; internalToken: string; contextTopK: number; embedDim: number }
  ) {
    this.agent = new BskyAgent({
      service: settings.serviceUrl,
      persistSession: (_evt: AtpSessionEvent, _sess?: AtpSessionData) => {
        // Session persistence would go here for production
        // For now, we re-login each job run which is fine for 5-min intervals
      },
    });
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
  }

  private async login(): Promise<void> {
    this.log("info", "logging in to Bluesky", { identifier: this.settings.identifier });
    await this.agent.login({
      identifier: this.settings.identifier,
      password: this.settings.appPassword,
    });
    this.log("info", "login successful", { did: this.agent.session?.did });
  }

  private async fetchTimeline(lookbackHours: number): Promise<BlueskyPost[]> {
    const posts: BlueskyPost[] = [];
    const cutoffTime = new Date(Date.now() - lookbackHours * 3600_000);
    let cursor: string | undefined;
    let pageCount = 0;
    const maxPages = 50; // Safety limit: 50 * 100 = 5000 posts max

    this.log("info", "fetching timeline", { lookbackHours, cutoffTime: cutoffTime.toISOString() });

    while (pageCount < maxPages) {
      const response = await this.agent.getTimeline(cursor ? { limit: 100, cursor } : { limit: 100 });
      pageCount++;

      if (!response.data.feed || response.data.feed.length === 0) break;

      let reachedCutoff = false;

      for (const item of response.data.feed) {
        const post = item.post;
        const record = post.record as {
          text?: string;
          createdAt?: string;
          reply?: {
            root?: { uri?: string; cid?: string };
            parent?: { uri?: string; cid?: string };
          };
          embed?: { $type?: string };
        };

        const createdAt = record.createdAt ? new Date(record.createdAt) : new Date();

        // Stop if we've gone past lookback period
        if (createdAt < cutoffTime) {
          reachedCutoff = true;
          break;
        }

        // Check if this is a repost
        const isRepost = item.reason?.$type === "app.bsky.feed.defs#reasonRepost";

        // Determine embed type
        let embedType: string | null = null;
        if (record.embed?.$type) {
          embedType = String(record.embed.$type).replace("app.bsky.embed.", "");
        }

        const bskyPost: BlueskyPost = {
          uri: post.uri,
          cid: post.cid,
          authorDid: post.author.did,
          authorHandle: post.author.handle,
          authorDisplayName: post.author.displayName ?? null,
          createdAt: createdAt.toISOString(),
          text: record.text ?? "",
          replyRootUri: record.reply?.root?.uri ?? null,
          replyParentUri: record.reply?.parent?.uri ?? null,
          embedType,
          likeCount: post.likeCount ?? 0,
          repostCount: post.repostCount ?? 0,
          replyCount: post.replyCount ?? 0,
          payload: post as unknown as Record<string, unknown>,
          isRepost,
        };

        posts.push(bskyPost);
      }

      if (reachedCutoff || !response.data.cursor) break;
      cursor = response.data.cursor;
    }

    this.log("info", "timeline fetch complete", { postsFound: posts.length, pagesScanned: pageCount });
    return posts;
  }

  private getContextKey(post: BlueskyPost): string {
    // For replies, use the root post as context
    // For standalone posts, use the post itself
    const rootUri = post.replyRootUri ?? post.uri;
    const parsed = parseAtUri(rootUri);
    if (!parsed) {
      // Fallback: use the post's own DID and rkey
      const selfParsed = parseAtUri(post.uri);
      if (selfParsed) {
        return `${selfParsed.did}:${selfParsed.rkey}`;
      }
      return `${post.authorDid}:${post.uri}`;
    }
    return `${parsed.did}:${parsed.rkey}`;
  }

  private getPostUrl(post: BlueskyPost): string {
    const parsed = parseAtUri(post.uri);
    if (parsed) {
      return `https://bsky.app/profile/${post.authorHandle}/post/${parsed.rkey}`;
    }
    return `https://bsky.app/profile/${post.authorHandle}`;
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
      this.log("info", "ai summary prompt", { promptLength: prompt.length });
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
        ownerModule: "bluesky",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(subjectFor("bluesky", "contextUpdated"), this.sc.encode(JSON.stringify(contextEvent)));
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_bsky");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_bsky.bsky_posts (
        uri TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        author_did TEXT NOT NULL,
        author_handle TEXT,
        author_display_name TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        text TEXT,
        reply_root_uri TEXT,
        reply_parent_uri TEXT,
        embed_type TEXT,
        like_count INT DEFAULT 0,
        repost_count INT DEFAULT 0,
        reply_count INT DEFAULT 0,
        is_repost BOOLEAN DEFAULT FALSE,
        payload JSONB NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.db.query(`CREATE INDEX IF NOT EXISTS bsky_posts_created_at_idx ON mod_bsky.bsky_posts (created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS bsky_posts_author_did_idx ON mod_bsky.bsky_posts (author_did)`);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS bsky_posts_reply_root_idx ON mod_bsky.bsky_posts (reply_root_uri) WHERE reply_root_uri IS NOT NULL`
    );

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_bsky.bsky_post_embeddings (
        uri TEXT PRIMARY KEY,
        context_key TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        embedding vector(${embedDim})
      )
    `);

    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_bsky.bsky_post_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }

    await this.db.query(
      `CREATE INDEX IF NOT EXISTS bsky_post_embeddings_context_idx ON mod_bsky.bsky_post_embeddings (context_key, ts)`
    );

    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS bsky_post_embeddings_vec_idx ON mod_bsky.bsky_post_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS mod_bsky.bsky_post_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }
  }

  async collectAndPersist(): Promise<{ insertedOrUpdated: number; publishedNew: number }> {
    this.log("info", "bluesky collect starting", { lookbackHours: this.settings.lookbackHours });

    await this.login();
    const posts = await this.fetchTimeline(this.settings.lookbackHours);

    if (posts.length === 0) {
      this.log("info", "no posts to collect");
      return { insertedOrUpdated: 0, publishedNew: 0 };
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      let count = 0;
      let published = 0;

      for (const post of posts) {
        const upsert = (await client.query(
          `
          INSERT INTO mod_bsky.bsky_posts (
            uri, cid, author_did, author_handle, author_display_name,
            created_at, text, reply_root_uri, reply_parent_uri,
            embed_type, like_count, repost_count, reply_count, is_repost, payload
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15
          )
          ON CONFLICT (uri) DO UPDATE SET
            cid = EXCLUDED.cid,
            author_handle = EXCLUDED.author_handle,
            author_display_name = EXCLUDED.author_display_name,
            text = EXCLUDED.text,
            like_count = EXCLUDED.like_count,
            repost_count = EXCLUDED.repost_count,
            reply_count = EXCLUDED.reply_count,
            payload = EXCLUDED.payload,
            collected_at = NOW()
          RETURNING (xmax = 0) AS inserted
          `,
          [
            post.uri,
            post.cid,
            post.authorDid,
            post.authorHandle,
            post.authorDisplayName,
            post.createdAt,
            post.text,
            post.replyRootUri,
            post.replyParentUri,
            post.embedType,
            post.likeCount,
            post.repostCount,
            post.replyCount,
            post.isRepost,
            post.payload,
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };

        count++;

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const msgId = uuidv5(post.uri, UUID_NAMESPACE);
          const contextKey = this.getContextKey(post);
          const postUrl = this.getPostUrl(post);

          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: post.createdAt,
            source: { module: "bluesky", stream: "timeline" },
            realtime: false,
            Message: post.text,
            contextRef: { ownerModule: "bluesky", sourceKey: contextKey },
            followMePanel: {
              module: "bluesky",
              panelId: "post",
              href: postUrl,
              label: "Open on Bluesky",
            },
            From: post.authorDisplayName ?? post.authorHandle,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            likes: post.likeCount,
            tags: {
              source: "bluesky",
              authorDid: post.authorDid,
              authorHandle: post.authorHandle,
              isReply: Boolean(post.replyRootUri),
              isRepost: post.isRepost,
              embedType: post.embedType ?? "",
            },
          });

          const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
          this.nats.publish(subjectFor("bluesky", "messageCreated"), this.sc.encode(JSON.stringify(event)));

          // Generate embedding for the post text
          if (post.text) {
            try {
              const embedding = await this.aiEmbed(post.text);
              const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;

              if (embedding.length && (!Number.isFinite(embedDim) || embedding.length === embedDim)) {
                await client.query(
                  `
                  INSERT INTO mod_bsky.bsky_post_embeddings (
                    uri, context_key, ts, embedding
                  ) VALUES ($1, $2, $3, $4::vector)
                  ON CONFLICT (uri) DO NOTHING
                  `,
                  [post.uri, contextKey, post.createdAt, `[${embedding.join(",")}]`]
                );
              } else if (embedding.length) {
                this.log("warn", "embedding dimension mismatch", {
                  expected: embedDim,
                  got: embedding.length,
                });
              }
            } catch (err) {
              // Log but don't fail the job for embedding errors
              this.log("warn", "failed to generate embedding", {
                uri: post.uri,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          published++;
        }
      }

      await client.query("COMMIT");
      this.log("info", "bluesky collect finished", { insertedOrUpdated: count, publishedNew: published });
      return { insertedOrUpdated: count, publishedNew: published };
    } catch (e) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "bluesky collect failed (job will fail)",
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
    await this.login();

    const cutoff = new Date(Date.now() - params.lookbackHours * 3600_000);

    // Get distinct contexts (threads or standalone posts) from recent posts
    const res = (await this.db.query(
      `
      SELECT DISTINCT ON (COALESCE(reply_root_uri, uri))
        uri,
        cid,
        author_did,
        author_handle,
        author_display_name,
        reply_root_uri,
        text,
        created_at
      FROM mod_bsky.bsky_posts
      WHERE created_at >= $1
      ORDER BY COALESCE(reply_root_uri, uri), created_at DESC
      `,
      [cutoff]
    )) as { rows: Array<{
      uri: string;
      cid: string;
      author_did: string;
      author_handle: string;
      author_display_name: string | null;
      reply_root_uri: string | null;
      text: string | null;
      created_at: Date;
    }> };

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of res.rows) {
      const rootUri = row.reply_root_uri ?? row.uri;
      const parsed = parseAtUri(rootUri);
      const contextKey = parsed ? `${parsed.did}:${parsed.rkey}` : `${row.author_did}:${row.uri}`;
      const msgId = uuidv5(row.uri, UUID_NAMESPACE);

      // For standalone posts (not threads), use template
      if (!row.reply_root_uri) {
        const authorName = row.author_display_name ?? row.author_handle;
        const summaryShort = this.settings.nonThreadContextTemplate.replace("{author}", authorName).slice(0, 128);
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: row.text ?? summaryShort,
          keyPoints: [],
        });
        fallbackSummaries++;
        updated++;
        continue;
      }

      // For threads, generate AI summary
      const prior = (await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["bluesky", contextKey]
      )) as { rows: Array<{ summaryLong?: string }> };
      const priorSummary = String(prior.rows[0]?.summaryLong ?? "");
      const queryText = priorSummary || String(row.text ?? "");
      
      let queryEmbedding: number[] = [];
      try {
        queryEmbedding = await this.aiEmbed(queryText);
      } catch {
        // Continue without embedding if it fails
      }

      let messages: Array<string> = [];
      const topK = Number.isFinite(this.contextTopK) ? this.contextTopK : 20;

      if (queryEmbedding.length) {
        const embRows = (await this.db.query(
          `
          SELECT p.text
          FROM mod_bsky.bsky_post_embeddings e
          JOIN mod_bsky.bsky_posts p ON p.uri = e.uri
          WHERE e.context_key = $1
          ORDER BY e.embedding <-> $2::vector
          LIMIT $3
          `,
          [contextKey, `[${queryEmbedding.join(",")}]`, topK]
        )) as { rows: Array<{ text: string | null }> };
        messages = embRows.rows.map((r) => String(r.text ?? "")).filter(Boolean);
      }

      if (messages.length === 0) {
        // Fallback: get messages by time
        const fallback = (await this.db.query(
          `
          SELECT text
          FROM mod_bsky.bsky_posts
          WHERE COALESCE(reply_root_uri, uri) = $1
          ORDER BY created_at DESC
          LIMIT $2
          `,
          [rootUri, topK]
        )) as { rows: Array<{ text: string | null }> };
        messages = fallback.rows.map((r) => String(r.text ?? "")).filter(Boolean);
        if (messages.length === 0) {
          this.log("warn", "no thread messages found for context", { contextKey, rootUri });
        }
      }

      const prompt = [
        priorSummary ? `Prior summary:\n${priorSummary}` : "",
        "Summarize ONLY the Bluesky posts listed below. Do not make suggestions or ask questions.",
        "Recent posts:",
        ...messages.map((m, i) => `(${i + 1}) ${m}`),
      ]
        .filter(Boolean)
        .join("\n");

      const maxPromptChars = 8000;
      const promptText = prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;

      try {
        const aiSummary = await this.aiGenerate(promptText);

        let contextEmbedding: number[] = [];
        try {
          contextEmbedding = await this.aiEmbed(aiSummary.summaryLong);
          if (contextEmbedding.length) embeddingsInserted++;
        } catch {
          // Continue without embedding
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
      } catch (err) {
        this.log("warn", "failed to generate AI summary for context", {
          contextKey,
          error: err instanceof Error ? err.message : String(err),
        });
        // Use fallback for failed summaries
        const authorName = row.author_display_name ?? row.author_handle;
        const summaryShort = this.settings.nonThreadContextTemplate.replace("{author}", authorName).slice(0, 128);
        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort,
          summaryLong: row.text ?? summaryShort,
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
