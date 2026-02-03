/**
 * Signal Module - Message Ingestor
 *
 * Collects messages from Signal via signal-cli daemon's JSON-RPC interface.
 * Signal is E2E encrypted - we can only receive messages AFTER device linking.
 * Historical messages are cryptographically inaccessible.
 */

import { v5 as uuidv5 } from "uuid";

import {
  ContextUpdatedEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  subjectFor,
} from "@feedeater/core";
import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";

export interface SignalSettings {
  phoneNumber: string;
  connectionMode: "socket" | "jsonrpc";
  daemonSocket: string;
  daemonRpcUrl: string;
  collectGroups: boolean;
  collectPrivate: boolean;
  collectReactions: boolean;
  handleDisappearing: boolean;
  persistViewOnce: boolean;
  trustAllIdentities: boolean;
  pollIntervalMs: number;
  sessionCheckIntervalHours: number;
  includeContacts: string[];
  excludeContacts: string[];
  includeGroups: string[];
  excludeGroups: string[];
  minMessageLength: number;
  downloadAttachments: boolean;
  maxAttachmentSize: number;
  // Context generation settings
  contextPrompt: string;
  contextPromptFallback: string;
  lookbackHours: number;
}

/**
 * Signal envelope structure from signal-cli daemon
 */
interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: {
    timestamp?: number;
    message?: string;
    groupInfo?: {
      groupId?: string;
      type?: string;
    };
    reaction?: {
      emoji?: string;
      targetAuthor?: string;
      targetSentTimestamp?: number;
      isRemove?: boolean;
    };
    quote?: {
      id?: number;
      author?: string;
      text?: string;
    };
    expiresInSeconds?: number;
    viewOnce?: boolean;
    attachments?: Array<{
      contentType?: string;
      filename?: string;
      size?: number;
      id?: string;
    }>;
    mentions?: Array<{
      start?: number;
      length?: number;
      uuid?: string;
    }>;
  };
  receiptMessage?: {
    type?: "DELIVERY" | "READ";
    timestamps?: number[];
  };
  typingMessage?: {
    action?: "STARTED" | "STOPPED";
    groupId?: string;
  };
  syncMessage?: {
    sentMessage?: {
      destination?: string;
      timestamp?: number;
      message?: string;
    };
  };
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: SignalEnvelope[];
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const UUID_NAMESPACE = "e8f3b7c9-4a2d-4b8e-9c1f-7d6e5a3f2b1c"; // Signal module namespace

export function parseSignalSettingsFromInternal(
  raw: Record<string, unknown>
): SignalSettings {
  const phoneNumber = String(raw.phoneNumber ?? "");
  const connectionMode =
    String(raw.connectionMode ?? "jsonrpc") === "socket" ? "socket" : "jsonrpc";
  const daemonSocket = String(
    raw.daemonSocket ?? "/var/run/signal-cli/socket"
  );
  const daemonRpcUrl = String(raw.daemonRpcUrl ?? "http://localhost:7583");
  const collectGroups = String(raw.collectGroups ?? "true") !== "false";
  const collectPrivate = String(raw.collectPrivate ?? "true") !== "false";
  const collectReactions = String(raw.collectReactions ?? "true") !== "false";
  const handleDisappearing =
    String(raw.handleDisappearing ?? "true") !== "false";
  const persistViewOnce = String(raw.persistViewOnce ?? "false") === "true";
  const trustAllIdentities =
    String(raw.trustAllIdentities ?? "false") === "true";
  const pollIntervalMs = raw.pollIntervalMs ? Number(raw.pollIntervalMs) : 5000;
  const sessionCheckIntervalHours = raw.sessionCheckIntervalHours
    ? Number(raw.sessionCheckIntervalHours)
    : 24;
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;

  const includeContacts = String(raw.includeContacts ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const excludeContacts = String(raw.excludeContacts ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const includeGroups = String(raw.includeGroups ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const excludeGroups = String(raw.excludeGroups ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const minMessageLength = raw.minMessageLength
    ? Number(raw.minMessageLength)
    : 0;
  const downloadAttachments =
    String(raw.downloadAttachments ?? "false") === "true";
  const maxAttachmentSize = raw.maxAttachmentSize
    ? Number(raw.maxAttachmentSize)
    : 10 * 1024 * 1024;

  const defaultContextPrompt =
    "You are summarizing the provided Signal messages. Summarize ONLY the messages provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided messages in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";
  const contextPrompt =
    String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback =
    String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!phoneNumber) {
    throw new Error('Signal setting "phoneNumber" is required');
  }

  return {
    phoneNumber,
    connectionMode,
    daemonSocket,
    daemonRpcUrl,
    collectGroups,
    collectPrivate,
    collectReactions,
    handleDisappearing,
    persistViewOnce,
    trustAllIdentities,
    pollIntervalMs,
    sessionCheckIntervalHours,
    includeContacts,
    excludeContacts,
    includeGroups,
    excludeGroups,
    minMessageLength,
    downloadAttachments,
    maxAttachmentSize,
    contextPrompt,
    contextPromptFallback,
    lookbackHours,
  };
}

export class SignalIngestor {
  private rpcId = 0;
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
        "feedeater.signal.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "signal",
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
    private readonly settings: SignalSettings,
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

  /**
   * Make a JSON-RPC call to signal-cli daemon
   */
  private async rpcCall<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const id = ++this.rpcId;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: params ?? {},
      id,
    });

    this.log("debug", "signal-cli RPC call", { method, id });

    try {
      const response = await fetch(this.settings.daemonRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!response.ok) {
        throw new Error(
          `signal-cli daemon returned HTTP ${response.status}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as JsonRpcResponse;

      if (data.error) {
        const errMsg = data.error.message ?? "Unknown RPC error";
        // Check for session-related errors
        if (
          errMsg.includes("Unregistered") ||
          errMsg.includes("Not found") ||
          errMsg.includes("not registered")
        ) {
          this.log("error", "Signal session appears expired", {
            error: data.error,
          });
        }
        throw new Error(`signal-cli RPC error: ${errMsg}`);
      }

      return data.result as T;
    } catch (err) {
      if (
        err instanceof TypeError &&
        String(err.message).includes("fetch failed")
      ) {
        throw new Error(
          `Cannot connect to signal-cli daemon at ${this.settings.daemonRpcUrl}. Is the daemon running?`
        );
      }
      throw err;
    }
  }

  /**
   * Check if a message should be collected based on settings
   */
  private shouldCollectMessage(envelope: SignalEnvelope): boolean {
    const source = envelope.source ?? envelope.sourceNumber;
    const groupId = envelope.dataMessage?.groupInfo?.groupId;

    if (!source) return false;

    // Check contact whitelist/blacklist
    if (this.settings.includeContacts.length > 0) {
      if (!this.settings.includeContacts.includes(source)) return false;
    }
    if (this.settings.excludeContacts.includes(source)) return false;

    // Check group whitelist/blacklist
    if (groupId) {
      if (!this.settings.collectGroups) return false;
      if (this.settings.includeGroups.length > 0) {
        if (!this.settings.includeGroups.includes(groupId)) return false;
      }
      if (this.settings.excludeGroups.includes(groupId)) return false;
    } else {
      if (!this.settings.collectPrivate) return false;
    }

    // Check message length
    const body = envelope.dataMessage?.message;
    if (body && body.length < this.settings.minMessageLength) return false;

    return true;
  }

  /**
   * Get the conversation ID for context tracking
   */
  private getConversationId(envelope: SignalEnvelope): string {
    const groupId = envelope.dataMessage?.groupInfo?.groupId;
    if (groupId) {
      return `group.${groupId}`;
    }
    // For 1:1 chats, use the other party's phone number
    return envelope.source ?? envelope.sourceNumber ?? "unknown";
  }

  /**
   * Determine message type from envelope
   */
  private getMessageType(
    envelope: SignalEnvelope
  ): "data" | "reaction" | "receipt" | "typing" {
    if (envelope.receiptMessage) return "receipt";
    if (envelope.typingMessage) return "typing";
    if (envelope.dataMessage?.reaction) return "reaction";
    return "data";
  }

  /**
   * Ensure database schema exists
   */
  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_signal");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_signal.signal_messages (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        source_phone VARCHAR(20) NOT NULL,
        source_uuid VARCHAR(50),
        group_id VARCHAR(200),
        body TEXT,
        message_type VARCHAR(20) NOT NULL DEFAULT 'data',
        expires_in_seconds INTEGER,
        view_once BOOLEAN DEFAULT false,
        reaction_emoji VARCHAR(10),
        reaction_target_timestamp BIGINT,
        quote_id BIGINT,
        quote_author VARCHAR(20),
        quote_text TEXT,
        has_attachments BOOLEAN DEFAULT false,
        attachment_count INTEGER DEFAULT 0,
        raw_envelope JSONB,
        collected_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(timestamp, source_phone)
      )
    `);

    await this.db.query(`
      CREATE INDEX IF NOT EXISTS idx_signal_messages_timestamp 
        ON mod_signal.signal_messages(timestamp DESC)
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS idx_signal_messages_source 
        ON mod_signal.signal_messages(source_phone)
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS idx_signal_messages_group 
        ON mod_signal.signal_messages(group_id) 
        WHERE group_id IS NOT NULL
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS idx_signal_messages_collected 
        ON mod_signal.signal_messages(collected_at DESC)
    `);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_signal.signal_message_embeddings (
        message_id INTEGER PRIMARY KEY REFERENCES mod_signal.signal_messages(id) ON DELETE CASCADE,
        embedding vector(${embedDim}),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_signal.signal_message_embeddings 
         ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_signal.signal_session_health (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) NOT NULL,
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        is_alive BOOLEAN NOT NULL,
        linked_device_active BOOLEAN,
        error_message TEXT,
        last_message_at TIMESTAMPTZ,
        messages_since_check INTEGER DEFAULT 0
      )
    `);

    await this.db.query(`
      CREATE INDEX IF NOT EXISTS idx_signal_session_health_phone 
        ON mod_signal.signal_session_health(phone_number, checked_at DESC)
    `);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_signal.signal_collection_state (
        phone_number VARCHAR(20) PRIMARY KEY,
        last_timestamps JSONB DEFAULT '{}',
        total_messages_collected INTEGER DEFAULT 0,
        total_groups_tracked INTEGER DEFAULT 0,
        total_contacts_tracked INTEGER DEFAULT 0,
        linked_at TIMESTAMPTZ,
        last_successful_collect TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  /**
   * Generate embedding for text using AI service
   */
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
      if (!res.ok) throw new Error(`AI embeddings failed (${res.status})`);
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error("Empty embedding returned");
      }
      return data.embedding;
    } catch (err) {
      this.log(
        "error",
        "AI embeddings failed",
        err instanceof Error ? { message: err.message } : { err }
      );
      throw err;
    }
  }

  /**
   * Generate AI summary for context
   */
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
      this.log("debug", "AI summary request", { promptLength: prompt.length });
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
        throw new Error(`AI summary failed (${res.status}) ${body}`.trim());
      }
      const data = (await res.json()) as {
        response?: string;
        token_rate?: number | null;
      };
      const rawResponse = String(data.response ?? "").trim();
      if (!rawResponse) throw new Error("Invalid summary payload");

      const parsed = this.parseSummaryJson(rawResponse);
      if (!parsed) return await this.aiGenerateFallback(prompt);

      const summaryShort = parsed.summaryShort.slice(0, 128);
      const summaryLong = parsed.summaryLong;
      if (!summaryShort || !summaryLong) {
        throw new Error("Invalid summary payload");
      }
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
        "AI summary failed",
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
        `AI summary fallback failed (${res.status}) ${body}`.trim()
      );
    }
    const data = (await res.json()) as {
      response?: string;
      token_rate?: number | null;
    };
    const rawResponse = String(data.response ?? "").trim();
    if (!rawResponse) throw new Error("Invalid fallback summary payload");
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

  /**
   * Publish context update event to NATS
   */
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
        ownerModule: "signal",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(
      subjectFor("signal", "contextUpdated"),
      this.sc.encode(JSON.stringify(contextEvent))
    );
  }

  /**
   * Main collection job - receive messages from signal-cli daemon
   */
  async collectAndPersist(): Promise<{
    messagesReceived: number;
    messagesStored: number;
    reactionsReceived: number;
  }> {
    this.log("info", "Signal collect starting", {
      phoneNumber: this.settings.phoneNumber,
    });

    // Receive messages from daemon
    let envelopes: SignalEnvelope[];
    try {
      envelopes = await this.rpcCall<SignalEnvelope[]>("receive", {
        account: this.settings.phoneNumber,
      });
    } catch (err) {
      this.log(
        "error",
        "Failed to receive messages from signal-cli daemon",
        err instanceof Error ? { message: err.message } : { err }
      );
      throw err;
    }

    if (!Array.isArray(envelopes) || envelopes.length === 0) {
      this.log("info", "No new messages received");
      return { messagesReceived: 0, messagesStored: 0, reactionsReceived: 0 };
    }

    this.log("info", "Received messages from daemon", {
      count: envelopes.length,
    });

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      let messagesStored = 0;
      let reactionsReceived = 0;

      for (const envelope of envelopes) {
        const messageType = this.getMessageType(envelope);

        // Skip typing and receipt messages
        if (messageType === "typing" || messageType === "receipt") continue;

        // Check filters
        if (!this.shouldCollectMessage(envelope)) continue;

        if (messageType === "reaction") {
          if (!this.settings.collectReactions) continue;
          reactionsReceived++;
        }

        const source = envelope.source ?? envelope.sourceNumber ?? "unknown";
        const timestamp =
          envelope.timestamp ?? envelope.dataMessage?.timestamp ?? Date.now();
        const groupId = envelope.dataMessage?.groupInfo?.groupId ?? null;
        const conversationId = this.getConversationId(envelope);

        // Handle view-once messages
        let body = envelope.dataMessage?.message ?? null;
        if (envelope.dataMessage?.viewOnce && !this.settings.persistViewOnce) {
          body = "[view-once media - content not persisted]";
        }

        // Handle disappearing messages flag
        const expiresInSeconds = envelope.dataMessage?.expiresInSeconds ?? null;
        if (expiresInSeconds && !this.settings.handleDisappearing) {
          // Skip entirely if not handling disappearing
          continue;
        }

        const sourceId = `signal-${timestamp}-${source}`;
        const hasAttachments =
          (envelope.dataMessage?.attachments?.length ?? 0) > 0;
        const attachmentCount = envelope.dataMessage?.attachments?.length ?? 0;

        // Upsert message
        const upsert = (await client.query(
          `
          INSERT INTO mod_signal.signal_messages (
            timestamp, source_phone, source_uuid, group_id, body,
            message_type, expires_in_seconds, view_once,
            reaction_emoji, reaction_target_timestamp,
            quote_id, quote_author, quote_text,
            has_attachments, attachment_count, raw_envelope
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10,
            $11, $12, $13,
            $14, $15, $16
          )
          ON CONFLICT (timestamp, source_phone) DO UPDATE SET
            body = EXCLUDED.body,
            raw_envelope = EXCLUDED.raw_envelope,
            collected_at = NOW()
          RETURNING id, (xmax = 0) AS inserted
          `,
          [
            timestamp,
            source,
            envelope.sourceUuid ?? null,
            groupId,
            body,
            messageType,
            expiresInSeconds,
            envelope.dataMessage?.viewOnce ?? false,
            envelope.dataMessage?.reaction?.emoji ?? null,
            envelope.dataMessage?.reaction?.targetSentTimestamp ?? null,
            envelope.dataMessage?.quote?.id ?? null,
            envelope.dataMessage?.quote?.author ?? null,
            envelope.dataMessage?.quote?.text ?? null,
            hasAttachments,
            attachmentCount,
            envelope as unknown,
          ]
        )) as { rows: Array<{ id: number; inserted: boolean }> };

        const row = upsert.rows[0];
        const inserted = Boolean(row?.inserted);

        if (inserted && messageType === "data") {
          messagesStored++;

          // Generate message ID and context key
          const msgId = uuidv5(sourceId, UUID_NAMESPACE);
          const contextKey = `signal:${this.settings.phoneNumber}:${conversationId}`;

          // Determine sender display name
          const fromDisplay =
            envelope.sourceName ?? envelope.sourceUuid ?? source;

          // Build normalized message
          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: new Date(timestamp).toISOString(),
            source: { module: "signal", stream: conversationId },
            realtime: true,
            Message: body ?? undefined,
            contextRef: { ownerModule: "signal", sourceKey: contextKey },
            From: fromDisplay,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "signal",
              phoneNumber: source,
              isGroup: Boolean(groupId),
              ...(groupId ? { groupId } : {}),
              ...(expiresInSeconds ? { disappearing: true } : {}),
              ...(envelope.dataMessage?.viewOnce ? { viewOnce: true } : {}),
            },
          });

          // Publish to NATS
          const event = MessageCreatedEventSchema.parse({
            type: "MessageCreated",
            message: normalized,
          });
          this.nats.publish(
            subjectFor("signal", "messageCreated"),
            this.sc.encode(JSON.stringify(event))
          );

          // Generate embedding if message has body
          if (body && row?.id) {
            try {
              const embedding = await this.aiEmbed(body);
              const embedDim = Number.isFinite(this.embedDim)
                ? this.embedDim
                : 4096;
              if (
                embedding.length &&
                (!Number.isFinite(embedDim) || embedding.length === embedDim)
              ) {
                await client.query(
                  `
                  INSERT INTO mod_signal.signal_message_embeddings (message_id, embedding)
                  VALUES ($1, $2::vector)
                  ON CONFLICT (message_id) DO NOTHING
                  `,
                  [row.id, `[${embedding.join(",")}]`]
                );
              }
            } catch (err) {
              this.log("warn", "Failed to generate embedding for message", {
                messageId: row.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }

      // Update collection state
      await client.query(
        `
        INSERT INTO mod_signal.signal_collection_state (phone_number, last_successful_collect, updated_at)
        VALUES ($1, NOW(), NOW())
        ON CONFLICT (phone_number) DO UPDATE SET
          total_messages_collected = mod_signal.signal_collection_state.total_messages_collected + $2,
          last_successful_collect = NOW(),
          updated_at = NOW()
        `,
        [this.settings.phoneNumber, messagesStored]
      );

      await client.query("COMMIT");

      this.log("info", "Signal collect finished", {
        messagesReceived: envelopes.length,
        messagesStored,
        reactionsReceived,
      });

      return {
        messagesReceived: envelopes.length,
        messagesStored,
        reactionsReceived,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "Signal collect failed",
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err
      );
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Check signal-cli session health
   */
  async checkSessionHealth(): Promise<{
    isAlive: boolean;
    linkedDeviceActive: boolean;
    errorMessage?: string;
  }> {
    this.log("info", "Checking Signal session health");

    let isAlive = false;
    let linkedDeviceActive = false;
    let errorMessage: string | undefined;

    try {
      // Try to get account info or list identities
      // signal-cli daemon should respond if session is alive
      await this.rpcCall("listIdentities", {
        account: this.settings.phoneNumber,
      });
      isAlive = true;
      linkedDeviceActive = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorMessage = msg;

      if (
        msg.includes("Unregistered") ||
        msg.includes("Not found") ||
        msg.includes("not registered")
      ) {
        isAlive = false;
        linkedDeviceActive = false;
        this.log("error", "Signal session expired - device needs re-linking", {
          error: msg,
        });
      } else if (msg.includes("fetch failed") || msg.includes("Cannot connect")) {
        isAlive = false;
        linkedDeviceActive = false;
        this.log("error", "Cannot connect to signal-cli daemon", {
          error: msg,
        });
      } else {
        // Some other error - daemon might be alive but command failed
        isAlive = true;
        linkedDeviceActive = false;
        this.log("warn", "Session check returned error", { error: msg });
      }
    }

    // Record health check
    await this.db.query(
      `
      INSERT INTO mod_signal.signal_session_health (
        phone_number, is_alive, linked_device_active, error_message
      ) VALUES ($1, $2, $3, $4)
      `,
      [this.settings.phoneNumber, isAlive, linkedDeviceActive, errorMessage]
    );

    return {
      isAlive,
      linkedDeviceActive,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }

  /**
   * Refresh context summaries for recent conversations
   */
  async refreshContexts(params: { lookbackHours: number }): Promise<{
    updated: number;
    aiSummaries: number;
    fallbackSummaries: number;
    embeddingsInserted: number;
    avgTokenRate?: number;
  }> {
    const cutoff = new Date(Date.now() - params.lookbackHours * 3600_000);

    // Get distinct conversations with recent messages
    const res = (await this.db.query(
      `
      SELECT DISTINCT ON (COALESCE(group_id, source_phone))
        id,
        timestamp,
        source_phone,
        group_id,
        body
      FROM mod_signal.signal_messages
      WHERE collected_at >= $1
        AND message_type = 'data'
      ORDER BY COALESCE(group_id, source_phone), timestamp DESC
      `,
      [cutoff]
    )) as { rows: Array<{
      id: number;
      timestamp: string;
      source_phone: string;
      group_id: string | null;
      body: string | null;
    }> };

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of res.rows as Array<{
      id: number;
      timestamp: string;
      source_phone: string;
      group_id: string | null;
      body: string | null;
    }>) {
      const conversationId = row.group_id
        ? `group.${row.group_id}`
        : row.source_phone;
      const contextKey = `signal:${this.settings.phoneNumber}:${conversationId}`;
      const sourceId = `signal-${row.timestamp}-${row.source_phone}`;
      const msgId = uuidv5(sourceId, UUID_NAMESPACE);

      // For 1:1 chats, generate simple context
      if (!row.group_id) {
        const summaryShort = `Conversation with ${row.source_phone}`.slice(
          0,
          128
        );
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

      // For groups, generate AI summary
      const prior = (await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["signal", contextKey]
      )) as { rows: Array<{ summaryLong?: string }> };
      const priorSummary = String(prior.rows?.[0]?.summaryLong ?? "");
      const queryText = priorSummary || String(row.body ?? "");

      // Get recent messages for this conversation
      const topK = Number.isFinite(this.contextTopK) ? this.contextTopK : 20;
      const msgRows = (await this.db.query(
        `
        SELECT body, source_phone
        FROM mod_signal.signal_messages
        WHERE (group_id = $1 OR ($1 IS NULL AND source_phone = $2))
          AND message_type = 'data'
          AND body IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT $3
        `,
        [row.group_id, row.source_phone, topK]
      )) as { rows: Array<{ body: string | null; source_phone: string }> };

      const messages = msgRows.rows
        .map((r) => `${r.source_phone}: ${r.body ?? ""}`)
        .filter(Boolean);

      if (messages.length === 0) {
        this.log("warn", "No messages found for context", {
          contextKey,
          groupId: row.group_id,
        });
        continue;
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
        this.log("warn", "Failed to generate AI summary for context", {
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
      ...(tokenRateCount ? { avgTokenRate: tokenRateSum / tokenRateCount } : {}),
    };
  }
}
