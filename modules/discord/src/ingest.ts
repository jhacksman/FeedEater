import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";

import { ContextUpdatedEventSchema, MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type DiscordSettings = {
  enabled: boolean;
  botToken: string;
  guildIds: string[];
  channelIds: string[];
  lookbackHours: number;
  includeThreads: boolean;
  excludeBots: boolean;
  channelNameMap: Record<string, string>;
  contextPrompt: string;
  contextPromptFallback: string;
};

/** Discord API message structure (partial) */
type DiscordApiMessage = {
  id: string;
  channel_id: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  thread?: {
    id: string;
    name: string;
  };
};

/** Discord API channel structure (partial) */
type DiscordApiChannel = {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  parent_id?: string;
};

/** Discord API thread structure */
type DiscordApiThread = {
  id: string;
  guild_id?: string;
  parent_id?: string;
  name?: string;
  type: number;
};

type DiscordMessage = {
  text: string;
  userId: string;
  username: string;
  messageId: string;
  channelId: string;
  guildId: string;
  timestamp: Date;
  threadId?: string;
  isThreadMessage?: boolean;
  referenceMessageId?: string;
  isBot?: boolean;
};

const UUID_NAMESPACE = "c8e3f892-4a7b-4d15-b6c2-9e8f3a2d1c4b";

const DISCORD_API_BASE = "https://discord.com/api/v10";

// Channel types that can contain text messages
const TEXT_CHANNEL_TYPES = new Set([
  0,  // GUILD_TEXT
  2,  // GUILD_VOICE (has text chat)
  5,  // GUILD_ANNOUNCEMENT
  10, // ANNOUNCEMENT_THREAD
  11, // PUBLIC_THREAD
  12, // PRIVATE_THREAD
  15, // GUILD_FORUM
  16, // GUILD_MEDIA
]);

export function parseDiscordSettingsFromInternal(raw: Record<string, unknown>): DiscordSettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const botToken = String(raw.botToken ?? "");
  const guildIds = String(raw.guildIds ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const channelIds = String(raw.channelIds ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const includeThreads = String(raw.includeThreads ?? "true") !== "false";
  const excludeBots = String(raw.excludeBots ?? "true") !== "false";
  const channelNameMapRaw = String(raw.channelNameMap ?? "{}");
  const defaultContextPrompt =
    "You are summarizing the provided Discord messages. Summarize ONLY the messages provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided messages in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;
  
  let channelNameMap: Record<string, string> = {};
  try {
    const parsed = JSON.parse(channelNameMapRaw) as Record<string, unknown>;
    channelNameMap = Object.fromEntries(
      Object.entries(parsed ?? {}).map(([k, v]) => [String(k), String(v)])
    );
  } catch {
    throw new Error('Discord setting "channelNameMap" must be valid JSON');
  }

  if (!botToken) throw new Error('Discord setting "botToken" is required');
  if (guildIds.length === 0) throw new Error('Discord setting "guildIds" is required');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Discord setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    botToken,
    guildIds,
    channelIds,
    lookbackHours,
    includeThreads,
    excludeBots,
    channelNameMap,
    contextPrompt,
    contextPromptFallback,
  };
}

export class DiscordIngestor {
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.discord.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "discord",
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
    private readonly settings: DiscordSettings,
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

  /**
   * Make a Discord API request with rate limit handling.
   * Automatically retries on 429 responses.
   */
  private async discordFetch<T>(
    endpoint: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const url = `${DISCORD_API_BASE}${endpoint}`;
    const method = options.method ?? "GET";
    
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.settings.botToken}`,
      "Content-Type": "application/json",
      "User-Agent": "FeedEater-Discord/1.0",
    };

    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      attempts++;

      const fetchOpts: RequestInit = { method, headers };
      if (options.body) {
        fetchOpts.body = JSON.stringify(options.body);
      }
      const res = await fetch(url, fetchOpts);

      // Log rate limit headers for debugging
      const remaining = res.headers.get("X-RateLimit-Remaining");
      const resetAfter = res.headers.get("X-RateLimit-Reset-After");
      const bucket = res.headers.get("X-RateLimit-Bucket");
      
      if (remaining !== null && Number(remaining) <= 1) {
        this.log("debug", "rate limit nearly exhausted", { 
          endpoint, remaining, resetAfter, bucket 
        });
      }

      if (res.ok) {
        return (await res.json()) as T;
      }

      if (res.status === 429) {
        // Rate limited - parse retry_after and wait
        const body = (await res.json()) as { retry_after?: number; global?: boolean; message?: string };
        const retryAfter = body.retry_after ?? 1;
        const isGlobal = body.global ?? false;
        
        this.log("warn", "rate limited by Discord", {
          endpoint,
          retryAfter,
          isGlobal,
          attempt: attempts,
        });

        // Wait with jitter
        const waitMs = (retryAfter * 1000) + Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (res.status === 401) {
        throw new Error(`Discord API auth failed (401): Check botToken`);
      }

      if (res.status === 403) {
        const body = await res.text().catch(() => "");
        throw new Error(`Discord API forbidden (403) for ${endpoint}: ${body}`);
      }

      if (res.status === 404) {
        const body = await res.text().catch(() => "");
        throw new Error(`Discord API not found (404) for ${endpoint}: ${body}`);
      }

      // Other errors - don't retry
      const body = await res.text().catch(() => "");
      throw new Error(`Discord API error (${res.status}) for ${endpoint}: ${body}`);
    }

    throw new Error(`Discord API: max retries exceeded for ${endpoint}`);
  }

  /**
   * Fetch all text-capable channels in a guild.
   */
  private async fetchGuildChannels(guildId: string): Promise<DiscordApiChannel[]> {
    const channels = await this.discordFetch<DiscordApiChannel[]>(`/guilds/${guildId}/channels`);
    return channels.filter((ch) => TEXT_CHANNEL_TYPES.has(ch.type));
  }

  /**
   * Fetch active threads in a guild.
   */
  private async fetchActiveThreads(guildId: string): Promise<DiscordApiThread[]> {
    try {
      const response = await this.discordFetch<{ threads: DiscordApiThread[] }>(
        `/guilds/${guildId}/threads/active`
      );
      return response.threads ?? [];
    } catch (err) {
      this.log("warn", "failed to fetch active threads", { 
        guildId, 
        error: err instanceof Error ? err.message : err 
      });
      return [];
    }
  }

  /**
   * Fetch messages from a channel, paginating with `after` parameter.
   */
  private async fetchChannelMessages(
    channelId: string,
    guildId: string,
    lookbackHours: number,
    afterMessageId?: string
  ): Promise<DiscordMessage[]> {
    const messages: DiscordMessage[] = [];
    const cutoffTime = new Date(Date.now() - lookbackHours * 3600_000);
    let lastId = afterMessageId;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({ limit: "100" });
      if (lastId) params.set("after", lastId);

      let batch: DiscordApiMessage[];
      try {
        batch = await this.discordFetch<DiscordApiMessage[]>(
          `/channels/${channelId}/messages?${params}`
        );
      } catch (err) {
        this.log("warn", "failed to fetch channel messages", {
          channelId,
          guildId,
          error: err instanceof Error ? err.message : err,
        });
        break;
      }

      if (!batch || batch.length === 0) {
        hasMore = false;
        break;
      }

      // Discord returns newest first, so we need to reverse for chronological order
      // and check cutoff against oldest message in batch
      batch.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      for (const m of batch) {
        const ts = new Date(m.timestamp);
        if (ts < cutoffTime) {
          // We've gone past the lookback window
          hasMore = false;
          break;
        }

        // Skip bots if configured
        if (this.settings.excludeBots && m.author.bot) {
          continue;
        }

        // Skip empty messages (MESSAGE_CONTENT intent not enabled)
        if (!m.content && !m.thread) {
          this.log("debug", "empty message content (check MESSAGE_CONTENT intent)", {
            messageId: m.id,
            channelId,
          });
        }

        const msg: DiscordMessage = {
          text: m.content ?? "",
          userId: m.author.id,
          username: m.author.username,
          messageId: m.id,
          channelId: m.channel_id,
          guildId,
          timestamp: ts,
          isBot: m.author.bot ?? false,
          ...(m.message_reference?.message_id ? { referenceMessageId: m.message_reference.message_id } : {}),
        };
        messages.push(msg);

        // Track last ID for pagination (use the newest message ID)
        if (!lastId || BigInt(m.id) > BigInt(lastId)) {
          lastId = m.id;
        }
      }

      // If we got less than 100, no more pages
      if (batch.length < 100) {
        hasMore = false;
      }
    }

    return messages;
  }

  /**
   * Fetch messages from threads.
   */
  private async fetchThreadMessages(
    threads: DiscordApiThread[],
    guildId: string,
    lookbackHours: number
  ): Promise<DiscordMessage[]> {
    const messages: DiscordMessage[] = [];

    for (const thread of threads) {
      const threadMsgs = await this.fetchChannelMessages(
        thread.id,
        guildId,
        lookbackHours
      );

      // Mark as thread messages and add thread ID
      for (const msg of threadMsgs) {
        msg.isThreadMessage = true;
        msg.threadId = thread.id;
      }

      messages.push(...threadMsgs);
    }

    return messages;
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
      this.log("info", "ai summary prompt", { prompt: prompt.slice(0, 200) + "..." });
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
        ownerModule: "discord",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(subjectFor("discord", "contextUpdated"), this.sc.encode(JSON.stringify(contextEvent)));
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_discord");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_discord.discord_messages (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        author_id TEXT,
        author_name TEXT,
        text TEXT,
        thread_id TEXT,
        is_thread_message BOOLEAN NOT NULL DEFAULT FALSE,
        reference_message_id TEXT,
        payload JSONB NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS discord_messages_ts_idx ON mod_discord.discord_messages (ts)`);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS discord_messages_channel_ts_idx ON mod_discord.discord_messages (channel_id, ts)`
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS discord_messages_guild_ts_idx ON mod_discord.discord_messages (guild_id, ts)`
    );

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_discord.discord_message_embeddings (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        context_key TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_discord.discord_message_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS discord_message_embeddings_context_idx ON mod_discord.discord_message_embeddings (context_key, ts)`
    );
    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS discord_message_embeddings_vec_idx ON mod_discord.discord_message_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS mod_discord.discord_message_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }
  }

  async collectAndPersist(): Promise<{ insertedOrUpdated: number; publishedNew: number }> {
    this.log("info", "discord collect starting", { 
      guildIds: this.settings.guildIds, 
      channelIds: this.settings.channelIds,
      lookbackHours: this.settings.lookbackHours 
    });

    const allMessages: DiscordMessage[] = [];

    for (const guildId of this.settings.guildIds) {
      this.log("info", "processing guild", { guildId });

      // Get all text channels
      let channels: DiscordApiChannel[];
      try {
        channels = await this.fetchGuildChannels(guildId);
      } catch (err) {
        this.log("error", "failed to fetch guild channels", {
          guildId,
          error: err instanceof Error ? err.message : err,
        });
        continue;
      }

      // Filter to configured channels if specified
      if (this.settings.channelIds.length > 0) {
        const allowedSet = new Set(this.settings.channelIds);
        channels = channels.filter((ch) => allowedSet.has(ch.id));
      }

      this.log("info", "found text channels", { 
        guildId, 
        count: channels.length,
        channels: channels.map((ch) => ({ id: ch.id, name: ch.name })),
      });

      // Fetch messages from each channel
      for (const channel of channels) {
        const messages = await this.fetchChannelMessages(
          channel.id,
          guildId,
          this.settings.lookbackHours
        );
        allMessages.push(...messages);
      }

      // Fetch thread messages if enabled
      if (this.settings.includeThreads) {
        const threads = await this.fetchActiveThreads(guildId);
        if (threads.length > 0) {
          this.log("info", "found active threads", { guildId, count: threads.length });
          const threadMessages = await this.fetchThreadMessages(
            threads,
            guildId,
            this.settings.lookbackHours
          );
          allMessages.push(...threadMessages);
        }
      }
    }

    if (allMessages.length === 0) {
      this.log("info", "no messages found");
      return { insertedOrUpdated: 0, publishedNew: 0 };
    }

    // Sort chronologically
    allMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      let count = 0;
      let published = 0;

      for (const m of allMessages) {
        const sourceId = `discord-${m.channelId}-${m.messageId}`;

        const upsert = (await client.query(
          `
          INSERT INTO mod_discord.discord_messages (
            id, guild_id, channel_id, message_id, ts,
            author_id, author_name, text,
            thread_id, is_thread_message, reference_message_id, payload
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10, $11, $12
          )
          ON CONFLICT (id) DO UPDATE SET
            text = EXCLUDED.text,
            author_name = EXCLUDED.author_name,
            payload = EXCLUDED.payload,
            collected_at = NOW()
          RETURNING (xmax = 0) AS inserted
          `,
          [
            sourceId,
            m.guildId,
            m.channelId,
            m.messageId,
            m.timestamp,
            m.userId,
            m.username,
            m.text,
            m.threadId ?? null,
            Boolean(m.isThreadMessage),
            m.referenceMessageId ?? null,
            m as any,
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };
        count++;

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const msgId = uuidv5(sourceId, UUID_NAMESPACE);
          const contextKey = m.threadId 
            ? `${m.guildId}:${m.channelId}:${m.threadId}`
            : `${m.guildId}:${m.channelId}`;
          
          const discordLink = `https://discord.com/channels/${m.guildId}/${m.channelId}/${m.messageId}`;
          
          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: m.timestamp.toISOString(),
            source: { module: "discord", stream: m.channelId },
            realtime: false,
            Message: m.text,
            contextRef: { ownerModule: "discord", sourceKey: contextKey },
            followMePanel: {
              module: "discord",
              panelId: "thread",
              href: discordLink,
              label: "Open in Discord",
            },
            From: m.username,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "discord",
              guildId: m.guildId,
              channelId: m.channelId,
              author: m.username,
              isThreadMessage: Boolean(m.isThreadMessage),
            },
          });
          const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
          this.nats.publish(subjectFor("discord", "messageCreated"), this.sc.encode(JSON.stringify(event)));

          // Generate embedding if text is present
          const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
          const embedding = m.text ? await this.aiEmbed(String(m.text)) : [];
          if (embedding.length && (!Number.isFinite(embedDim) || embedding.length === embedDim)) {
            await client.query(
              `
              INSERT INTO mod_discord.discord_message_embeddings (
                id, channel_id, context_key, ts, embedding
              ) VALUES ($1, $2, $3, $4, $5::vector)
              ON CONFLICT (id) DO NOTHING
              `,
              [sourceId, m.channelId, contextKey, m.timestamp, `[${embedding.join(",")}]`]
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
      this.log("info", "discord collect finished", { insertedOrUpdated: count, publishedNew: published });
      return { insertedOrUpdated: count, publishedNew: published };
    } catch (e) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "discord collect failed (job will fail)",
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
    
    // Find distinct contexts from recent messages
    const res = await this.db.query(
      `
      SELECT DISTINCT ON (guild_id, channel_id, COALESCE(thread_id, channel_id))
        guild_id,
        channel_id,
        message_id,
        thread_id,
        text,
        ts
      FROM mod_discord.discord_messages
      WHERE ts >= $1
      ORDER BY guild_id, channel_id, COALESCE(thread_id, channel_id), ts DESC
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
      guild_id: string;
      channel_id: string;
      message_id: string;
      thread_id: string | null;
      text: string | null;
    }>) {
      const contextKey = row.thread_id
        ? `${row.guild_id}:${row.channel_id}:${row.thread_id}`
        : `${row.guild_id}:${row.channel_id}`;
      const sourceId = `discord-${row.channel_id}-${row.message_id}`;
      const msgId = uuidv5(sourceId, UUID_NAMESPACE);

      // Non-threaded channels get a simple template summary
      if (!row.thread_id) {
        const channelName = this.settings.channelNameMap[row.channel_id] ?? row.channel_id;
        const summaryShort = `Messages in #${channelName}`.slice(0, 128);
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

      // Threaded messages get AI summaries
      const prior = await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["discord", contextKey]
      );
      const priorSummary = String(prior.rows?.[0]?.summaryLong ?? "");
      const queryText = priorSummary || String(row.text ?? "");
      const queryEmbedding = await this.aiEmbed(queryText);

      let messages: Array<string> = [];
      const topK = Number.isFinite(this.contextTopK) ? this.contextTopK : 20;
      
      if (queryEmbedding) {
        const embRows = await this.db.query(
          `
          SELECT m.text
          FROM mod_discord.discord_message_embeddings e
          JOIN mod_discord.discord_messages m ON m.id = e.id
          WHERE e.context_key = $1
          ORDER BY e.embedding <-> $2::vector
          LIMIT $3
          `,
          [contextKey, `[${queryEmbedding.join(",")}]`, topK]
        );
        messages = (embRows.rows ?? []).map((r: { text: string | null }) => String(r.text ?? "")).filter(Boolean);
      }

      if (messages.length === 0) {
        const fallback = await this.db.query(
          `
          SELECT text
          FROM mod_discord.discord_messages
          WHERE guild_id = $1 AND channel_id = $2 AND COALESCE(thread_id, channel_id) = $3
          ORDER BY ts DESC
          LIMIT $4
          `,
          [row.guild_id, row.channel_id, row.thread_id ?? row.channel_id, topK]
        );
        messages = (fallback.rows ?? []).map((r: { text: string | null }) => String(r.text ?? "")).filter(Boolean);
        if (messages.length === 0) {
          this.log("warn", "no thread messages found for context", { contextKey, channelId: row.channel_id });
        }
      }

      const prompt = [
        priorSummary ? `Prior summary:\n${priorSummary}` : "",
        "Summarize ONLY the messages listed below. Do not make suggestions or ask questions.",
        "Recent messages:",
        ...messages.map((m, i) => `(${i + 1}) ${m}`),
      ]
        .filter(Boolean)
        .join("\n");
      const maxPromptChars = 8000;
      const promptText = prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;

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
