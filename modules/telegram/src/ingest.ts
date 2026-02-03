import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { FloodWaitError } from "telegram/errors/index.js";
import type { Dialog } from "telegram/tl/custom/dialog.js";
import bigInt from "big-integer";
import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection } from "nats";

import {
  ContextUpdatedEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  subjectFor,
} from "@feedeater/core";

import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";

import {
  type TelegramSettings,
  type TelegramDialogType,
  parseDialogTypes,
  parseDialogIds,
  buildContextKey,
} from "../settings.js";

const UUID_NAMESPACE = "a7e8f3d1-6c24-4b9a-8f12-3e4d5c6b7a89";

export type { TelegramSettings };

export function parseTelegramSettingsFromInternal(
  raw: Record<string, unknown>
): TelegramSettings {
  const enabled = String(raw.enabled ?? "false") !== "false";
  const apiId = raw.apiId ? Number(raw.apiId) : 0;
  const apiHash = String(raw.apiHash ?? "");
  const sessionString = String(raw.sessionString ?? "");
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 168;
  const collectDialogTypes = String(
    raw.collectDialogTypes ?? '["channel","supergroup","group","private"]'
  );
  const excludeArchived = String(raw.excludeArchived ?? "true") !== "false";
  const collectSavedMessages =
    String(raw.collectSavedMessages ?? "true") !== "false";
  const includeDialogIds = String(raw.includeDialogIds ?? "[]");
  const excludeDialogIds = String(raw.excludeDialogIds ?? "[]");
  const minMessageLength = raw.minMessageLength
    ? Number(raw.minMessageLength)
    : 0;
  const floodWaitMultiplier = raw.floodWaitMultiplier
    ? Number(raw.floodWaitMultiplier)
    : 1.5;

  const defaultContextPrompt =
    "You are summarizing the provided Telegram messages. Summarize ONLY the messages provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided messages in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";
  const contextPrompt =
    String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback =
    String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!apiId || apiId <= 0) throw new Error('Telegram setting "apiId" is required');
  if (!apiHash) throw new Error('Telegram setting "apiHash" is required');
  if (!sessionString)
    throw new Error('Telegram setting "sessionString" is required');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Telegram setting "lookbackHours" must be a positive number');
  }

  return {
    enabled,
    apiId,
    apiHash,
    sessionString,
    lookbackHours,
    collectDialogTypes,
    excludeArchived,
    collectSavedMessages,
    includeDialogIds,
    excludeDialogIds,
    minMessageLength,
    floodWaitMultiplier,
    contextPrompt,
    contextPromptFallback,
  };
}

type TelegramMessage = {
  dialogId: string;
  messageId: number;
  ts: Date;
  authorId: string;
  authorName: string;
  text: string;
  replyToMsgId: number | null;
  threadId: number | null;
  isForumTopic: boolean;
  payload: Record<string, unknown>;
};

type DialogInfo = {
  id: string;
  name: string;
  type: TelegramDialogType;
  isArchived: boolean;
  isForum: boolean;
};

export class TelegramIngestor {
  private client: TelegramClient | null = null;
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;
  private dialogCache = new Map<string, DialogInfo>();

  constructor(
    private readonly settings: TelegramSettings,
    private readonly db: DbLike,
    private readonly nats: NatsLike,
    private readonly sc: StringCodecLike,
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
  ): void {
    try {
      this.nats.publish(
        "feedeater.telegram.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "telegram",
            source: "collector",
            at: new Date().toISOString(),
            message,
            meta,
          })
        )
      );
    } catch {
      // ignore publish errors
    }
  }

  private async connect(): Promise<TelegramClient> {
    if (this.client) return this.client;

    const session = new StringSession(this.settings.sessionString);
    this.client = new TelegramClient(session, this.settings.apiId, this.settings.apiHash, {
      connectionRetries: 5,
      floodSleepThreshold: 60,
    });

    try {
      await this.client.connect();
      this.log("info", "connected to Telegram");
    } catch (err) {
      this.client = null;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log("error", "failed to connect to Telegram", { error: errMsg });
      throw err;
    }

    return this.client;
  }

  private async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
        this.log("info", "disconnected from Telegram");
      } catch {
        // ignore disconnect errors
      }
      this.client = null;
    }
  }

  private getDialogType(dialog: Dialog): TelegramDialogType {
    const entity = dialog.entity;
    if (!entity) return "private";

    if (entity instanceof Api.Channel) {
      if (entity.megagroup) return "supergroup";
      return "channel";
    }
    if (entity instanceof Api.Chat) {
      return "group";
    }
    return "private";
  }

  private getDialogId(dialog: Dialog): string {
    const entity = dialog.entity;
    if (!entity) return "unknown";

    if ("id" in entity) {
      const id = entity.id;
      // Channels/supergroups have -100 prefix convention
      if (entity instanceof Api.Channel) {
        return `-100${id}`;
      }
      // Groups have negative IDs
      if (entity instanceof Api.Chat) {
        return `-${id}`;
      }
      // Users are positive
      return String(id);
    }
    return "unknown";
  }

  private getDialogName(dialog: Dialog): string {
    const entity = dialog.entity;
    if (!entity) return "Unknown";

    if ("title" in entity && entity.title) {
      return entity.title;
    }
    if (entity instanceof Api.User) {
      const parts = [entity.firstName, entity.lastName].filter(Boolean);
      if (parts.length > 0) return parts.join(" ");
      if (entity.username) return `@${entity.username}`;
    }
    return "Unknown";
  }

  private async fetchDialogs(): Promise<DialogInfo[]> {
    const client = await this.connect();
    const allowedTypes = parseDialogTypes(this.settings.collectDialogTypes);
    const includeIds = parseDialogIds(this.settings.includeDialogIds);
    const excludeIds = parseDialogIds(this.settings.excludeDialogIds);

    this.log("info", "fetching dialogs", {
      allowedTypes,
      includeIds: includeIds.length,
      excludeIds: excludeIds.length,
    });

    const dialogs: DialogInfo[] = [];

    try {
      const result = await client.getDialogs({});

      for (const dialog of result) {
        const id = this.getDialogId(dialog);
        const type = this.getDialogType(dialog);
        const name = this.getDialogName(dialog);
        const isArchived = Boolean(dialog.archived);
        const entity = dialog.entity;
        const isForum =
          entity instanceof Api.Channel ? Boolean(entity.forum) : false;

        // Apply filters
        if (!allowedTypes.includes(type)) continue;
        if (this.settings.excludeArchived && isArchived) continue;
        if (excludeIds.length > 0 && excludeIds.includes(id)) continue;
        if (includeIds.length > 0 && !includeIds.includes(id)) continue;

        const info: DialogInfo = { id, name, type, isArchived, isForum };
        dialogs.push(info);
        this.dialogCache.set(id, info);
      }

      // Add Saved Messages if enabled
      if (this.settings.collectSavedMessages) {
        const me = await client.getMe();
        if (me) {
          const savedId = "self";
          dialogs.push({
            id: savedId,
            name: "Saved Messages",
            type: "private",
            isArchived: false,
            isForum: false,
          });
          this.dialogCache.set(savedId, {
            id: savedId,
            name: "Saved Messages",
            type: "private",
            isArchived: false,
            isForum: false,
          });
        }
      }

      this.log("info", "fetched dialogs", { count: dialogs.length });
      return dialogs;
    } catch (err) {
      if (err instanceof FloodWaitError) {
        const waitMs =
          err.seconds * 1000 * this.settings.floodWaitMultiplier;
        this.log("warn", "FLOOD_WAIT on getDialogs", {
          seconds: err.seconds,
          waitingMs: waitMs,
        });
        await this.sleep(waitMs);
        return this.fetchDialogs(); // retry
      }
      throw err;
    }
  }

  private async fetchMessagesForDialog(
    dialogId: string,
    sinceId: number | null,
    limit: number = 100
  ): Promise<TelegramMessage[]> {
    const client = await this.connect();
    const messages: TelegramMessage[] = [];

    // Resolve the entity for iteration
    let entity: Api.TypeInputPeer;
    if (dialogId === "self") {
      entity = new Api.InputPeerSelf();
    } else {
      // Parse the dialog ID back to proper entity format
      const numId = bigInt(dialogId);
      if (dialogId.startsWith("-100")) {
        // Channel/supergroup
        const channelId = bigInt(dialogId.slice(4));
        entity = new Api.InputPeerChannel({
          channelId,
          accessHash: bigInt.zero,
        });
      } else if (dialogId.startsWith("-")) {
        // Group
        entity = new Api.InputPeerChat({ chatId: numId.negate() });
      } else {
        // User
        entity = new Api.InputPeerUser({
          userId: numId,
          accessHash: bigInt.zero,
        });
      }
    }

    try {
      const iterOpts: {
        limit: number;
        offsetId?: number;
        reverse?: boolean;
      } = { limit };

      if (sinceId !== null) {
        iterOpts.offsetId = sinceId;
        iterOpts.reverse = true; // oldest first when catching up
      }

      for await (const msg of client.iterMessages(entity, iterOpts)) {
        if (!msg || msg.id === undefined) continue;

        // Skip if we've seen this message (when catching up)
        if (sinceId !== null && msg.id <= sinceId) continue;

        const text = msg.message ?? "";
        if (
          this.settings.minMessageLength > 0 &&
          text.length < this.settings.minMessageLength
        ) {
          continue;
        }

        // Resolve sender name
        let authorId = "";
        let authorName = "";
        const sender = msg.sender;
        if (sender) {
          if (sender instanceof Api.User) {
            authorId = String(sender.id);
            const parts = [sender.firstName, sender.lastName].filter(Boolean);
            authorName = parts.length > 0 ? parts.join(" ") : `@${sender.username ?? sender.id}`;
          } else if (sender instanceof Api.Channel) {
            authorId = `-100${sender.id}`;
            authorName = sender.title ?? "Channel";
          } else if (sender instanceof Api.Chat) {
            authorId = `-${sender.id}`;
            authorName = sender.title ?? "Chat";
          }
        }

        // Get reply info
        let replyToMsgId: number | null = null;
        if (msg.replyTo && "replyToMsgId" in msg.replyTo) {
          replyToMsgId = msg.replyTo.replyToMsgId ?? null;
        }

        // Get thread/topic ID for forums
        let threadId: number | null = null;
        let isForumTopic = false;
        if (msg.replyTo && "replyToTopId" in msg.replyTo && msg.replyTo.replyToTopId) {
          threadId = msg.replyTo.replyToTopId;
          isForumTopic = true;
        }

        messages.push({
          dialogId,
          messageId: msg.id,
          ts: new Date(msg.date * 1000),
          authorId,
          authorName,
          text,
          replyToMsgId,
          threadId,
          isForumTopic,
          payload: {
            id: msg.id,
            date: msg.date,
            message: msg.message,
            peerId: msg.peerId?.className,
            fromId: msg.fromId?.className,
            hasMedia: Boolean(msg.media),
            mediaType: msg.media?.className ?? null,
          },
        });
      }

      return messages;
    } catch (err) {
      if (err instanceof FloodWaitError) {
        const waitMs = err.seconds * 1000 * this.settings.floodWaitMultiplier;
        this.log("warn", "FLOOD_WAIT on iterMessages", {
          dialogId,
          seconds: err.seconds,
          waitingMs: waitMs,
        });
        await this.sleep(waitMs);
        return this.fetchMessagesForDialog(dialogId, sinceId, limit);
      }
      this.log("warn", "failed to fetch messages for dialog", {
        dialogId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      if (!rawResponse) throw new Error("empty ai response");

      const parsed = this.parseSummaryJson(rawResponse);
      if (!parsed) return this.aiGenerateFallback(prompt);

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
      this.log("error", "ai summary failed", {
        error: err instanceof Error ? err.message : String(err),
      });
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
    if (!rawResponse) throw new Error("empty fallback summary");

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

      if (!res.ok) throw new Error(`ai embedding failed (${res.status})`);

      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error("empty embedding");
      }

      return data.embedding;
    } catch (err) {
      this.log("error", "ai embedding failed", {
        error: err instanceof Error ? err.message : String(err),
      });
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
  }): Promise<void> {
    const summaryShort = params.summaryShort.slice(0, 128);
    const contextEvent = ContextUpdatedEventSchema.parse({
      type: "ContextUpdated",
      createdAt: new Date().toISOString(),
      messageId: params.messageId,
      context: {
        ownerModule: "telegram",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });

    this.nats.publish(
      subjectFor("telegram", "contextUpdated"),
      this.sc.encode(JSON.stringify(contextEvent))
    );
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_telegram");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_telegram.telegram_messages (
        id text PRIMARY KEY,
        dialog_id text NOT NULL,
        message_id bigint NOT NULL,
        message_id_num bigint NOT NULL,
        ts timestamptz NOT NULL,
        author_id text,
        author_name text,
        text text,
        reply_to_msg_id bigint,
        thread_id bigint,
        is_forum_topic boolean NOT NULL DEFAULT false,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.db.query(`
      CREATE INDEX IF NOT EXISTS telegram_messages_ts_idx 
      ON mod_telegram.telegram_messages (ts)
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS telegram_messages_dialog_ts_idx 
      ON mod_telegram.telegram_messages (dialog_id, ts)
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS telegram_messages_dialog_msgid_idx 
      ON mod_telegram.telegram_messages (dialog_id, message_id_num)
    `);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_telegram.telegram_message_embeddings (
        id text PRIMARY KEY,
        dialog_id text NOT NULL,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);

    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(`
        ALTER TABLE mod_telegram.telegram_message_embeddings 
        ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector
      `);
    }

    await this.db.query(`
      CREATE INDEX IF NOT EXISTS telegram_message_embeddings_context_idx 
      ON mod_telegram.telegram_message_embeddings (context_key, ts)
    `);

    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(`
        CREATE INDEX IF NOT EXISTS telegram_message_embeddings_vec_idx 
        ON mod_telegram.telegram_message_embeddings 
        USING ivfflat (embedding vector_cosine_ops)
      `);
    } else {
      await this.db.query(
        `DROP INDEX IF EXISTS mod_telegram.telegram_message_embeddings_vec_idx`
      );
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", {
        embedDim,
      });
    }
  }

  async collectAndPersist(): Promise<{
    insertedOrUpdated: number;
    publishedNew: number;
    dialogsProcessed: number;
  }> {
    this.log("info", "telegram collect starting", {
      lookbackHours: this.settings.lookbackHours,
    });

    try {
      await this.connect();
      const dialogs = await this.fetchDialogs();

      if (dialogs.length === 0) {
        this.log("info", "no dialogs to process");
        return { insertedOrUpdated: 0, publishedNew: 0, dialogsProcessed: 0 };
      }

      const dbClient = await this.db.connect();
      let totalInserted = 0;
      let totalPublished = 0;

      try {
        await dbClient.query("BEGIN");

        for (const dialog of dialogs) {
          // Get last collected message ID for this dialog
          const lastResult = (await dbClient.query(
            `SELECT MAX(message_id_num) as last_id 
             FROM mod_telegram.telegram_messages 
             WHERE dialog_id = $1`,
            [dialog.id]
          )) as { rows: Array<{ last_id?: number | null }> };
          const lastId = lastResult.rows[0]?.last_id
            ? Number(lastResult.rows[0].last_id)
            : null;

          const messages = await this.fetchMessagesForDialog(
            dialog.id,
            lastId,
            100
          );

          for (const msg of messages) {
            const sourceId = `telegram-${msg.dialogId}-${msg.messageId}`;

            const upsert = (await dbClient.query(
              `
              INSERT INTO mod_telegram.telegram_messages (
                id, dialog_id, message_id, message_id_num, ts,
                author_id, author_name, text,
                reply_to_msg_id, thread_id, is_forum_topic, payload
              ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8,
                $9, $10, $11, $12
              )
              ON CONFLICT (id) DO UPDATE SET
                text = EXCLUDED.text,
                author_name = EXCLUDED.author_name,
                payload = EXCLUDED.payload,
                collected_at = now()
              RETURNING (xmax = 0) AS inserted
              `,
              [
                sourceId,
                msg.dialogId,
                msg.messageId,
                msg.messageId,
                msg.ts,
                msg.authorId,
                msg.authorName,
                msg.text,
                msg.replyToMsgId,
                msg.threadId,
                msg.isForumTopic,
                msg.payload,
              ]
            )) as { rows: Array<{ inserted: boolean }> };

            totalInserted++;

            const inserted = Boolean(upsert.rows[0]?.inserted);
            if (inserted) {
              const msgId = uuidv5(sourceId, UUID_NAMESPACE);
              const contextKey = buildContextKey(msg.dialogId, msg.threadId ?? 0);

              // Build link to message (web.telegram.org)
              let telegramLink = `https://web.telegram.org/`;
              if (msg.dialogId !== "self") {
                telegramLink = `https://t.me/c/${msg.dialogId.replace(/^-100/, "")}/${msg.messageId}`;
              }

              const normalized = NormalizedMessageSchema.parse({
                id: msgId,
                createdAt: msg.ts.toISOString(),
                source: { module: "telegram", stream: msg.dialogId },
                realtime: false,
                Message: msg.text,
                contextRef: { ownerModule: "telegram", sourceKey: contextKey },
                followMePanel: {
                  module: "telegram",
                  panelId: "message",
                  href: telegramLink,
                  label: "Open in Telegram",
                },
                From: msg.authorName || msg.authorId,
                isDirectMention: false,
                isDigest: false,
                isSystemMessage: false,
                tags: {
                  source: "telegram",
                  dialogId: msg.dialogId,
                  author: msg.authorName || msg.authorId,
                  isForumTopic: msg.isForumTopic,
                  ...(dialog.name ? { dialogName: dialog.name } : {}),
                },
              });

              const event = MessageCreatedEventSchema.parse({
                type: "MessageCreated",
                message: normalized,
              });
              this.nats.publish(
                subjectFor("telegram", "messageCreated"),
                this.sc.encode(JSON.stringify(event))
              );

              // Generate embedding for the message
              if (msg.text) {
                try {
                  const embedding = await this.aiEmbed(msg.text);
                  if (
                    embedding.length > 0 &&
                    (!Number.isFinite(this.embedDim) ||
                      embedding.length === this.embedDim)
                  ) {
                    await dbClient.query(
                      `
                      INSERT INTO mod_telegram.telegram_message_embeddings (
                        id, dialog_id, context_key, ts, embedding
                      ) VALUES ($1, $2, $3, $4, $5::vector)
                      ON CONFLICT (id) DO NOTHING
                      `,
                      [
                        sourceId,
                        msg.dialogId,
                        contextKey,
                        msg.ts,
                        `[${embedding.join(",")}]`,
                      ]
                    );
                  }
                } catch {
                  // Embedding failures shouldn't stop collection
                }
              }

              totalPublished++;
            }
          }
        }

        await dbClient.query("COMMIT");
        this.log("info", "telegram collect finished", {
          insertedOrUpdated: totalInserted,
          publishedNew: totalPublished,
          dialogsProcessed: dialogs.length,
        });

        return {
          insertedOrUpdated: totalInserted,
          publishedNew: totalPublished,
          dialogsProcessed: dialogs.length,
        };
      } catch (err) {
        await dbClient.query("ROLLBACK");
        throw err;
      } finally {
        dbClient.release();
      }
    } finally {
      await this.disconnect();
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
    const res = (await this.db.query(
      `
      SELECT DISTINCT ON (dialog_id, COALESCE(thread_id, 0))
        dialog_id,
        message_id,
        thread_id,
        text,
        ts
      FROM mod_telegram.telegram_messages
      WHERE ts >= $1
      ORDER BY dialog_id, COALESCE(thread_id, 0), ts DESC
      `,
      [cutoff]
    )) as {
      rows: Array<{
        dialog_id: string;
        message_id: number;
        thread_id: number | null;
        text: string | null;
      }>;
    };

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of res.rows) {
      const contextKey = buildContextKey(row.dialog_id, row.thread_id ?? 0);
      const sourceId = `telegram-${row.dialog_id}-${row.message_id}`;
      const msgId = uuidv5(sourceId, UUID_NAMESPACE);

      // For non-threaded messages, use a simple template
      if (row.thread_id === null) {
        const dialogInfo = this.dialogCache.get(row.dialog_id);
        const dialogName = dialogInfo?.name ?? row.dialog_id;
        const summaryShort = `Messages in ${dialogName}`.slice(0, 128);

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

      // For threaded/forum messages, generate AI summary
      const prior = (await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts 
         WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["telegram", contextKey]
      )) as { rows: Array<{ summaryLong?: string | null }> };
      const priorSummary = String(prior.rows[0]?.summaryLong ?? "");
      const queryText = priorSummary || String(row.text ?? "");

      let queryEmbedding: number[] = [];
      try {
        queryEmbedding = await this.aiEmbed(queryText);
      } catch {
        // Continue without embedding
      }

      let messages: string[] = [];
      const topK = Number.isFinite(this.contextTopK) ? this.contextTopK : 20;

      if (queryEmbedding.length > 0) {
        const embRows = (await this.db.query(
          `
          SELECT m.text
          FROM mod_telegram.telegram_message_embeddings e
          JOIN mod_telegram.telegram_messages m ON m.id = e.id
          WHERE e.context_key = $1
          ORDER BY e.embedding <-> $2::vector
          LIMIT $3
          `,
          [contextKey, `[${queryEmbedding.join(",")}]`, topK]
        )) as { rows: Array<{ text: string | null }> };
        messages = embRows.rows
          .map((r) => String(r.text ?? ""))
          .filter(Boolean);
      }

      if (messages.length === 0) {
        const fallback = (await this.db.query(
          `
          SELECT text
          FROM mod_telegram.telegram_messages
          WHERE dialog_id = $1 AND COALESCE(thread_id, 0) = $2
          ORDER BY ts DESC
          LIMIT $3
          `,
          [row.dialog_id, row.thread_id ?? 0, topK]
        )) as { rows: Array<{ text: string | null }> };
        messages = fallback.rows
          .map((r) => String(r.text ?? ""))
          .filter(Boolean);

        if (messages.length === 0) {
          this.log("warn", "no messages found for context", {
            contextKey,
            dialogId: row.dialog_id,
          });
          continue;
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
      const promptText =
        prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;

      try {
        const aiSummary = await this.aiGenerate(promptText);

        let contextEmbedding: number[] = [];
        try {
          contextEmbedding = await this.aiEmbed(aiSummary.summaryLong);
          if (contextEmbedding.length > 0) embeddingsInserted++;
        } catch {
          // Continue without embedding
        }

        if (typeof aiSummary.tokenRate === "number") {
          tokenRateSum += aiSummary.tokenRate;
          tokenRateCount++;
        }

        await this.publishContextUpdate({
          contextKey,
          messageId: msgId,
          summaryShort: aiSummary.summaryShort,
          summaryLong: aiSummary.summaryLong,
          keyPoints: [],
          ...(contextEmbedding.length > 0 ? { embedding: contextEmbedding } : {}),
        });

        aiSummaries++;
        updated++;
      } catch (err) {
        this.log("warn", "failed to generate context summary", {
          contextKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      updated,
      aiSummaries,
      fallbackSummaries,
      embeddingsInserted,
      ...(tokenRateCount > 0 ? { avgTokenRate: tokenRateSum / tokenRateCount } : {}),
    };
  }
}
