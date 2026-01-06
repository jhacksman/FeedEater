import { WebClient } from "@slack/web-api";
import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";

import { MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

export type SlackSettings = {
  enabled: boolean;
  botToken: string;
  channelIds: string[];
  lookbackHours: number;
  includeThreads: boolean;
  excludeBots: boolean;
};

type SlackMessage = {
  text: string;
  user: string;
  username?: string;
  timestamp: string; // Slack ts
  channel: string;
  threadTs?: string;
  isThreadReply?: boolean;
  replyCount?: number;
};

const UUID_NAMESPACE = "b437f58d-5842-4c68-b2ea-22de67e3f9ff";

export function parseSlackSettingsFromInternal(raw: Record<string, unknown>): SlackSettings {
  // Internal settings endpoint returns strings (and decrypted secret strings) or nulls.
  // Normalize into the strongly-typed settings object.
  const enabled = String(raw.enabled ?? "true") !== "false";
  const botToken = String(raw.botToken ?? "");
  const channelIds = String(raw.channelIds ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const includeThreads = String(raw.includeThreads ?? "true") !== "false";
  const excludeBots = String(raw.excludeBots ?? "true") !== "false";

  if (!botToken) throw new Error('Slack setting "botToken" is required');
  if (channelIds.length === 0) throw new Error('Slack setting "channelIds" is required');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('Slack setting "lookbackHours" must be a positive number');
  }

  return { enabled, botToken, channelIds, lookbackHours, includeThreads, excludeBots };
}

export class SlackIngestor {
  private slack: WebClient;
  private userCache = new Map<string, string>();

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.slack.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "slack",
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
    private readonly settings: SlackSettings,
    private readonly db: Pool,
    private readonly nats: NatsConnection,
    private readonly sc: StringCodec
  ) {
    this.slack = new WebClient(settings.botToken);
  }

  private async resolveUsername(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.slack.users.info({ user: userId });
      const username =
        (result.user?.real_name as string | undefined) ??
        (result.user?.name as string | undefined) ??
        userId;
      this.userCache.set(userId, username);
      return username;
    } catch {
      return userId;
    }
  }

  private async fetchThreadReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
    try {
      const result = await this.slack.conversations.replies({ channel: channelId, ts: threadTs, limit: 100 });
      if (!result.messages || result.messages.length <= 1) return [];

      const replies: SlackMessage[] = [];
      for (let i = 1; i < result.messages.length; i++) {
        const m = result.messages[i];
        if (!m || !m.ts || !m.user || !m.text) continue;
        const username = await this.resolveUsername(String(m.user));
        replies.push({
          text: String(m.text),
          user: String(m.user),
          username,
          timestamp: String(m.ts),
          channel: channelId,
          threadTs,
          isThreadReply: true,
        });
      }
      return replies;
    } catch (err) {
      this.log(
        "warn",
        "failed to fetch thread replies (continuing)",
        err instanceof Error ? { channelId, threadTs, name: err.name, message: err.message } : { channelId, threadTs, err }
      );
      return [];
    }
  }

  private async fetchChannelMessages(channelIds: string[], lookbackHours: number): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    const lookbackTime = Date.now() / 1000 - lookbackHours * 3600;

    for (const channelId of channelIds) {
      this.log("info", "scraping channel history", { channelId, lookbackHours });

      let result: any;
      try {
        result = await this.slack.conversations.history({
          channel: channelId,
          oldest: String(lookbackTime),
          limit: 1000,
        });
      } catch (err) {
        // Keep going: one bad channel should not block other channels.
        // Still report prominently (and with channelId) to the logs UI.
        this.log(
          "error",
          "failed to fetch channel history (continuing)",
          err instanceof Error ? { channelId, name: err.name, message: err.message, stack: err.stack } : { channelId, err }
        );
        continue;
      }

      for (const m of result.messages ?? []) {
        if (!m || !m.ts || !m.user || !m.text) continue;
        if (this.settings.excludeBots && (m.subtype === "bot_message" || (m as any).bot_id)) continue;

        const username = await this.resolveUsername(String(m.user));
        const msg: SlackMessage = {
          text: String(m.text),
          user: String(m.user),
          username,
          timestamp: String(m.ts),
          channel: channelId,
          isThreadReply: false,
          replyCount: typeof m.reply_count === "number" ? m.reply_count : 0,
          ...(m.thread_ts ? { threadTs: String(m.thread_ts) } : {}),
        };
        messages.push(msg);

        if (
          this.settings.includeThreads &&
          msg.replyCount &&
          msg.replyCount > 0 &&
          msg.timestamp &&
          !msg.isThreadReply
        ) {
          const replies = await this.fetchThreadReplies(channelId, msg.timestamp);
          messages.push(...replies);
        }
      }
    }

    messages.sort((a, b) => parseFloat(a.timestamp) - parseFloat(b.timestamp));
    return messages;
  }

  async ensureSchema(): Promise<void> {
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_slack");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_slack.slack_messages (
        id text PRIMARY KEY,
        channel_id text NOT NULL,
        slack_ts text NOT NULL,
        slack_ts_num double precision NOT NULL,
        ts timestamptz NOT NULL,
        author_id text,
        author_name text,
        text text,
        thread_ts text,
        is_thread_reply boolean NOT NULL DEFAULT false,
        reply_count int,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS slack_messages_ts_idx ON mod_slack.slack_messages (ts)`);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS slack_messages_channel_ts_idx ON mod_slack.slack_messages (channel_id, ts)`
    );
  }

  async collectAndPersist(): Promise<{ insertedOrUpdated: number }> {
    this.log("info", "slack collect starting", { channelIds: this.settings.channelIds, lookbackHours: this.settings.lookbackHours });
    const msgs = await this.fetchChannelMessages(this.settings.channelIds, this.settings.lookbackHours);
    if (msgs.length === 0) return { insertedOrUpdated: 0 };

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      let count = 0;
      let published = 0;

      for (const m of msgs) {
        const tsNum = parseFloat(m.timestamp);
        const sourceId = `slack-${m.channel}-${m.timestamp}`;

        // De-duplication: only publish to the unified bus when we insert a previously unseen Slack message.
        // We still upsert the DB row (so payload/text changes can be updated), but avoid re-emitting duplicates.
        const upsert = (await client.query(
          `
          INSERT INTO mod_slack.slack_messages (
            id, channel_id, slack_ts, slack_ts_num, ts,
            author_id, author_name, text,
            thread_ts, is_thread_reply, reply_count, payload
          ) VALUES (
            $1, $2, $3, $4, to_timestamp($4),
            $5, $6, $7,
            $8, $9, $10, $11
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
            m.channel,
            m.timestamp,
            tsNum,
            m.user,
            m.username ?? m.user,
            m.text,
            m.threadTs ?? null,
            Boolean(m.isThreadReply),
            m.replyCount ?? null,
            m as any,
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };
        count++;

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const msgId = uuidv5(sourceId, UUID_NAMESPACE);
          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: new Date(tsNum * 1000).toISOString(),
            source: { module: "slack", stream: m.channel },
            Message: m.text,
            FollowMe: undefined,
            From: m.username ?? m.user,
            Thread: m.threadTs,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "slack",
              channelId: m.channel,
              author: m.username ?? m.user,
              isThreadReply: Boolean(m.isThreadReply),
            },
          });
          const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
          this.nats.publish(subjectFor("slack", "messageCreated"), this.sc.encode(JSON.stringify(event)));
          published++;
        }
      }

      await client.query("COMMIT");
      this.log("info", "slack collect finished", { insertedOrUpdated: count, publishedNew: published });
      return { insertedOrUpdated: count };
    } catch (e) {
      await client.query("ROLLBACK");
      this.log(
        "error",
        "slack collect failed (job will fail)",
        e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e
      );
      throw e;
    } finally {
      client.release();
    }
  }
}


