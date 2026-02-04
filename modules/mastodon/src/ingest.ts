import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";
import { createHash } from "node:crypto";

import { ContextUpdatedEventSchema, MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type MastodonSettings = {
  enabled: boolean;
  instanceUrl: string;
  accessToken: string;
  timelineType: "home" | "local" | "public";
  lookbackHours: number;
  includeBoosts: boolean;
  includeReplies: boolean;
  excludeSensitive: boolean;
  nonThreadContextTemplate: string;
  contextPrompt: string;
  contextPromptFallback: string;
};

// Mastodon API types
interface MastodonAccount {
  id: string;
  username: string;
  acct: string; // username@instance or just username if local
  display_name: string;
  url: string;
}

interface MastodonStatus {
  id: string;
  uri: string; // Globally unique ActivityPub URI
  created_at: string;
  content: string;
  visibility: "public" | "unlisted" | "private" | "direct";
  sensitive: boolean;
  spoiler_text: string;
  reblog: MastodonStatus | null;
  account: MastodonAccount;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  conversation_id?: string; // Instance-local conversation grouping
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  media_attachments: Array<{ id: string; type: string; url: string }>;
  poll: unknown | null;
  url: string | null;
}

const UUID_NAMESPACE = "a8f3c91d-7e2b-4f1a-9d3c-8b5e7a2f1c4d";

function hashUri(uri: string): string {
  return createHash("sha256").update(uri).digest("hex").slice(0, 16);
}

function extractInstanceHost(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return instanceUrl.replace(/^https?:\/\//, "").split("/")[0] ?? instanceUrl;
  }
}

function stripHtml(html: string): string {
  // Basic HTML stripping for text content
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p>/gi, "")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function parseMastodonSettingsFromInternal(raw: Record<string, unknown>): MastodonSettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const instanceUrl = String(raw.instanceUrl ?? "").trim().replace(/\/+$/, "");
  const accessToken = String(raw.accessToken ?? "");
  const timelineType = (["home", "local", "public"].includes(String(raw.timelineType ?? ""))
    ? String(raw.timelineType)
    : "home") as "home" | "local" | "public";
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const includeBoosts = String(raw.includeBoosts ?? "true") !== "false";
  const includeReplies = String(raw.includeReplies ?? "true") !== "false";
  const excludeSensitive = String(raw.excludeSensitive ?? "false") === "true";
  const nonThreadContextTemplate = String(raw.nonThreadContextTemplate ?? "Toot from @{author}");
  const defaultContextPrompt =
    "You are summarizing the provided Mastodon toots. Summarize ONLY the toots provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided toots in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!instanceUrl) throw new Error('Mastodon setting "instanceUrl" is required');
  if (!accessToken) throw new Error('Mastodon setting "accessToken" is required');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Mastodon setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    instanceUrl,
    accessToken,
    timelineType,
    lookbackHours,
    includeBoosts,
    includeReplies,
    excludeSensitive,
    nonThreadContextTemplate,
    contextPrompt,
    contextPromptFallback,
  };
}

export class MastodonIngestor {
  private instanceHost: string;
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.mastodon.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "mastodon",
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
    private readonly settings: MastodonSettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodec,
    opts: { apiBaseUrl: string; internalToken: string; contextTopK: number; embedDim: number }
  ) {
    this.instanceHost = extractInstanceHost(settings.instanceUrl);
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.internalToken = opts.internalToken;
    this.contextTopK = opts.contextTopK;
    this.embedDim = opts.embedDim;
  }

  private async fetchWithRateLimit(url: string): Promise<Response> {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.settings.accessToken}`,
        Accept: "application/json",
      },
    });

    if (res.status === 429) {
      const resetAt = res.headers.get("X-RateLimit-Reset");
      const waitMs = resetAt ? new Date(resetAt).getTime() - Date.now() : 60000;
      this.log("warn", "rate limited, waiting", { waitMs, resetAt });
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs + 1000, 120000)));
      return this.fetchWithRateLimit(url);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Mastodon API error (${res.status}): ${body}`);
    }

    // Log rate limit status
    const remaining = res.headers.get("X-RateLimit-Remaining");
    if (remaining && parseInt(remaining) < 50) {
      this.log("warn", "rate limit running low", { remaining });
    }

    return res;
  }

  private parseLinkHeader(header: string | null): { next?: string; prev?: string } {
    if (!header) return {};
    const result: { next?: string; prev?: string } = {};
    const links = header.split(",");
    for (const link of links) {
      const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(link.trim());
      if (match) {
        const [, url, rel] = match;
        if (rel === "next" && url) result.next = url;
        if (rel === "prev" && url) result.prev = url;
      }
    }
    return result;
  }

  private async fetchTimeline(lookbackHours: number): Promise<MastodonStatus[]> {
    const allStatuses: MastodonStatus[] = [];
    const cutoffTime = Date.now() - lookbackHours * 3600_000;
    const endpoint = this.settings.timelineType === "local"
      ? "/api/v1/timelines/public?local=true"
      : this.settings.timelineType === "public"
        ? "/api/v1/timelines/public"
        : "/api/v1/timelines/home";

    const separator = endpoint.includes("?") ? "&" : "?";
    let url: string | undefined = `${this.settings.instanceUrl}${endpoint}${separator}limit=40`;
    let pageCount = 0;
    const maxPages = 25; // Safety limit

    while (url && pageCount < maxPages) {
      this.log("debug", "fetching timeline page", { url, pageCount });
      const res = await this.fetchWithRateLimit(url);
      const statuses = (await res.json()) as MastodonStatus[];

      if (statuses.length === 0) break;

      for (const status of statuses) {
        const createdAt = new Date(status.created_at).getTime();
        if (createdAt < cutoffTime) {
          // We've gone past the lookback window
          return allStatuses;
        }
        allStatuses.push(status);
      }

      // Get next page URL from Link header
      const linkHeader = res.headers.get("Link");
      const links = this.parseLinkHeader(linkHeader);
      url = links.next;
      pageCount++;
    }

    return allStatuses;
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
        ownerModule: "mastodon",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(subjectFor("mastodon", "contextUpdated"), this.sc.encode(JSON.stringify(contextEvent)));
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_mastodon");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_mastodon.mastodon_statuses (
        id text PRIMARY KEY,
        uri text NOT NULL UNIQUE,
        status_id text NOT NULL,
        instance_host text NOT NULL,
        created_at timestamptz NOT NULL,
        author_id text NOT NULL,
        author_handle text NOT NULL,
        author_display_name text,
        content text,
        content_text text,
        visibility text NOT NULL,
        sensitive boolean NOT NULL DEFAULT false,
        spoiler_text text,
        in_reply_to_id text,
        in_reply_to_uri text,
        conversation_id text,
        reblog_uri text,
        boosted_by_handle text,
        favorites_count int DEFAULT 0,
        reblogs_count int DEFAULT 0,
        replies_count int DEFAULT 0,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS mastodon_statuses_created_at_idx ON mod_mastodon.mastodon_statuses (created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS mastodon_statuses_conversation_idx ON mod_mastodon.mastodon_statuses (instance_host, conversation_id)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS mastodon_statuses_author_idx ON mod_mastodon.mastodon_statuses (author_handle)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_mastodon.mastodon_status_embeddings (
        id text PRIMARY KEY,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_mastodon.mastodon_status_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS mastodon_status_embeddings_context_idx ON mod_mastodon.mastodon_status_embeddings (context_key, ts)`
    );
    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS mastodon_status_embeddings_vec_idx ON mod_mastodon.mastodon_status_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS mod_mastodon.mastodon_status_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }
  }

  async collectAndPersist(): Promise<{ insertedOrUpdated: number; publishedNew: number; boostsSkipped: number }> {
    this.log("info", "mastodon collect starting", { instanceHost: this.instanceHost, timeline: this.settings.timelineType, lookbackHours: this.settings.lookbackHours });

    const rawStatuses = await this.fetchTimeline(this.settings.lookbackHours);
    if (rawStatuses.length === 0) {
      this.log("info", "no toots found in timeline");
      return { insertedOrUpdated: 0, publishedNew: 0, boostsSkipped: 0 };
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      let count = 0;
      let published = 0;
      let boostsSkipped = 0;

      for (const rawStatus of rawStatuses) {
        // Handle boosts: store the original status, not the boost wrapper
        let status: MastodonStatus;
        let boostedByHandle: string | null = null;

        if (rawStatus.reblog) {
          if (!this.settings.includeBoosts) {
            boostsSkipped++;
            continue;
          }
          status = rawStatus.reblog;
          boostedByHandle = rawStatus.account.acct;
        } else {
          status = rawStatus;
        }

        // Skip replies if configured
        if (status.in_reply_to_id && !this.settings.includeReplies) {
          continue;
        }

        // Skip sensitive content if configured
        if (status.sensitive && this.settings.excludeSensitive) {
          continue;
        }

        const uri = status.uri;
        const uriHash = hashUri(uri);
        const sourceId = `mastodon-${this.instanceHost}-${uriHash}`;
        const contentText = stripHtml(status.content);

        // Determine context key
        const conversationId = status.conversation_id ?? `standalone-${uriHash}`;
        const contextKey = `${this.instanceHost}:${conversationId}`;

        // Upsert status
        const upsert = (await client.query(
          `
          INSERT INTO mod_mastodon.mastodon_statuses (
            id, uri, status_id, instance_host, created_at,
            author_id, author_handle, author_display_name,
            content, content_text, visibility, sensitive, spoiler_text,
            in_reply_to_id, in_reply_to_uri, conversation_id,
            reblog_uri, boosted_by_handle,
            favorites_count, reblogs_count, replies_count, payload
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10, $11, $12, $13,
            $14, $15, $16,
            $17, $18,
            $19, $20, $21, $22
          )
          ON CONFLICT (uri) DO UPDATE SET
            content = EXCLUDED.content,
            content_text = EXCLUDED.content_text,
            favorites_count = EXCLUDED.favorites_count,
            reblogs_count = EXCLUDED.reblogs_count,
            replies_count = EXCLUDED.replies_count,
            boosted_by_handle = COALESCE(mod_mastodon.mastodon_statuses.boosted_by_handle, EXCLUDED.boosted_by_handle),
            payload = EXCLUDED.payload,
            collected_at = now()
          RETURNING (xmax = 0) AS inserted
          `,
          [
            sourceId,
            uri,
            status.id,
            this.instanceHost,
            status.created_at,
            status.account.id,
            status.account.acct,
            status.account.display_name || null,
            status.content,
            contentText,
            status.visibility,
            status.sensitive,
            status.spoiler_text || null,
            status.in_reply_to_id,
            null, // in_reply_to_uri not available in standard API response
            conversationId,
            rawStatus.reblog ? rawStatus.reblog.uri : null,
            boostedByHandle,
            status.favourites_count,
            status.reblogs_count,
            status.replies_count,
            status as unknown,
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };
        count++;

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const msgId = uuidv5(sourceId, UUID_NAMESPACE);
          const statusUrl = status.url ?? `${this.settings.instanceUrl}/@${status.account.acct}/${status.id}`;

          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: status.created_at,
            source: { module: "mastodon", stream: this.instanceHost },
            realtime: false,
            Message: contentText,
            contextRef: { ownerModule: "mastodon", sourceKey: contextKey },
            followMePanel: {
              module: "mastodon",
              panelId: "status",
              href: statusUrl,
              label: "Open in Mastodon",
            },
            From: status.account.display_name || `@${status.account.acct}`,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "mastodon",
              instanceHost: this.instanceHost,
              author: status.account.acct,
              visibility: status.visibility,
              isReply: Boolean(status.in_reply_to_id),
              isBoost: Boolean(boostedByHandle),
              ...(boostedByHandle ? { boostedBy: boostedByHandle } : {}),
              ...(status.sensitive ? { sensitive: true, spoilerText: status.spoiler_text } : {}),
            },
          });
          const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
          this.nats.publish(subjectFor("mastodon", "messageCreated"), this.sc.encode(JSON.stringify(event)));

          // Generate embedding for semantic search
          if (contentText) {
            const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
            try {
              const embedding = await this.aiEmbed(contentText);
              if (embedding.length && (!Number.isFinite(embedDim) || embedding.length === embedDim)) {
                await client.query(
                  `
                  INSERT INTO mod_mastodon.mastodon_status_embeddings (
                    id, context_key, ts, embedding
                  ) VALUES ($1, $2, $3, $4::vector)
                  ON CONFLICT (id) DO NOTHING
                  `,
                  [sourceId, contextKey, status.created_at, `[${embedding.join(",")}]`]
                );
              } else if (embedding.length) {
                this.log("warn", "embedding dimension mismatch", {
                  expected: embedDim,
                  got: embedding.length,
                });
              }
            } catch (err) {
              // Log but don't fail the whole collection
              this.log("warn", "failed to generate embedding", { uri, error: err instanceof Error ? err.message : err });
            }
          }
          published++;
        }
      }

      await client.query("COMMIT");
      this.log("info", "mastodon collect finished", { insertedOrUpdated: count, publishedNew: published, boostsSkipped });
      return { insertedOrUpdated: count, publishedNew: published, boostsSkipped };
    } catch (e) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "mastodon collect failed (job will fail)",
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

    // Find distinct conversations from recent toots
    const res = await this.db.query(
      `
      SELECT DISTINCT ON (instance_host, conversation_id)
        instance_host,
        conversation_id,
        status_id,
        uri,
        content_text,
        author_handle,
        created_at
      FROM mod_mastodon.mastodon_statuses
      WHERE created_at >= $1
        AND conversation_id IS NOT NULL
      ORDER BY instance_host, conversation_id, created_at DESC
      `,
      [cutoff]
    );

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of res.rows as Array<{
      instance_host: string;
      conversation_id: string;
      status_id: string;
      uri: string;
      content_text: string | null;
      author_handle: string;
      created_at: Date;
    }>) {
      const contextKey = `${row.instance_host}:${row.conversation_id}`;
      const uriHash = hashUri(row.uri);
      const sourceId = `mastodon-${row.instance_host}-${uriHash}`;
      const msgId = uuidv5(sourceId, UUID_NAMESPACE);

      // Check if this is a standalone toot (not a thread)
      const threadCheck = await this.db.query(
        `
        SELECT COUNT(*) as count
        FROM mod_mastodon.mastodon_statuses
        WHERE instance_host = $1 AND conversation_id = $2
        `,
        [row.instance_host, row.conversation_id]
      );
      const isThread = parseInt(String((threadCheck.rows[0] as { count: string })?.count ?? "0")) > 1;

      if (!isThread) {
        // Use template for standalone toots
        const summaryShort = this.settings.nonThreadContextTemplate
          .replace("{author}", row.author_handle)
          .slice(0, 128);
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

      // Get prior summary for context
      const prior = await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["mastodon", contextKey]
      );
      const priorSummary = String(prior.rows?.[0]?.summaryLong ?? "");

      // Use semantic search to find relevant toots in the thread
      const queryText = priorSummary || String(row.content_text ?? "");
      let messages: Array<string> = [];
      const topK = Number.isFinite(this.contextTopK) ? this.contextTopK : 20;

      try {
        const queryEmbedding = await this.aiEmbed(queryText);
        if (queryEmbedding.length) {
          const embRows = await this.db.query(
            `
            SELECT m.content_text
            FROM mod_mastodon.mastodon_status_embeddings e
            JOIN mod_mastodon.mastodon_statuses m ON m.id = e.id
            WHERE e.context_key = $1
            ORDER BY e.embedding <-> $2::vector
            LIMIT $3
            `,
            [contextKey, `[${queryEmbedding.join(",")}]`, topK]
          );
          messages = (embRows.rows ?? []).map((r: { content_text: string | null }) => String(r.content_text ?? "")).filter(Boolean);
        }
      } catch {
        // Fall back to simple recent messages
      }

      if (messages.length === 0) {
        const fallback = await this.db.query(
          `
          SELECT content_text
          FROM mod_mastodon.mastodon_statuses
          WHERE instance_host = $1 AND conversation_id = $2
          ORDER BY created_at DESC
          LIMIT $3
          `,
          [row.instance_host, row.conversation_id, topK]
        );
        messages = (fallback.rows ?? []).map((r: { content_text: string | null }) => String(r.content_text ?? "")).filter(Boolean);
        if (messages.length === 0) {
          this.log("warn", "no thread messages found for context", { contextKey });
        }
      }

      const prompt = [
        priorSummary ? `Prior summary:\n${priorSummary}` : "",
        "Summarize ONLY the toots listed below. Do not make suggestions or ask questions.",
        "Recent toots:",
        ...messages.map((m, i) => `(${i + 1}) ${m}`),
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
        this.log("warn", "ai summary failed for context, skipping", { contextKey, error: err instanceof Error ? err.message : err });
        continue;
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
