import type { Pool } from "pg";
import { v5 as uuidv5 } from "uuid";
import type { NatsConnection, StringCodec } from "nats";

import { ContextUpdatedEventSchema, MessageCreatedEventSchema, NormalizedMessageSchema, subjectFor } from "@feedeater/core";

const GH_API_BASE = "https://api.github.com";
const UUID_NAMESPACE = "d8e2f1a3-6b4c-4d9e-a1f3-7c8b9d0e5f2a";

export type GitHubSettings = {
  enabled: boolean;
  accessToken: string;
  username: string;
  watchedRepos: string[];
  collectNotifications: boolean;
  collectEvents: boolean;
  collectReleases: boolean;
  lookbackHours: number;
  maxEventsPerPoll: number;
  requestTimeoutSeconds: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

type GHNotification = {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: {
    title: string;
    url: string | null;
    latest_comment_url: string | null;
    type: string;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
};

type GHEvent = {
  id: string;
  type: string;
  actor: { login: string; display_login?: string };
  repo: { name: string };
  payload: Record<string, unknown>;
  created_at: string;
};

type GHRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  created_at: string;
  draft: boolean;
  prerelease: boolean;
  author: { login: string };
};

export function parseGitHubSettingsFromInternal(raw: Record<string, unknown>): GitHubSettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const accessToken = String(raw.accessToken ?? "");
  const username = String(raw.username ?? "");
  const watchedReposRaw = String(raw.watchedRepos ?? "");
  const watchedRepos = watchedReposRaw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const collectNotifications = String(raw.collectNotifications ?? "true") !== "false";
  const collectEvents = String(raw.collectEvents ?? "true") !== "false";
  const collectReleases = String(raw.collectReleases ?? "true") !== "false";
  const lookbackHours = raw.lookbackHours ? Number(raw.lookbackHours) : 24;
  const maxEventsPerPoll = raw.maxEventsPerPoll ? Number(raw.maxEventsPerPoll) : 100;
  const requestTimeoutSeconds = raw.requestTimeoutSeconds ? Number(raw.requestTimeoutSeconds) : 15;

  const defaultContextPrompt =
    "You are summarizing GitHub activity (notifications, events, releases). Summarize ONLY the content provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided GitHub activity in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions.";
  const contextPrompt = String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback = String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  if (!accessToken) throw new Error('GitHub setting "accessToken" is required');
  if (!username) throw new Error('GitHub setting "username" is required');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error('GitHub setting "lookbackHours" must be a positive number');
  }
  if (!Number.isFinite(requestTimeoutSeconds) || requestTimeoutSeconds <= 0) {
    throw new Error('GitHub setting "requestTimeoutSeconds" must be a positive number');
  }

  return {
    enabled,
    accessToken,
    username,
    watchedRepos,
    collectNotifications,
    collectEvents,
    collectReleases,
    lookbackHours,
    maxEventsPerPoll,
    requestTimeoutSeconds,
    contextPrompt,
    contextPromptFallback,
  };
}

export class GitHubIngestor {
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;
  private lastModifiedNotifications: string | null = null;
  private etagEvents: string | null = null;

  private log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) {
    try {
      this.nats.publish(
        "feedeater.github.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "github",
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
    private readonly settings: GitHubSettings,
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

  private async ghFetch<T>(url: string, headers?: Record<string, string>): Promise<{ data: T; status: number; responseHeaders: Headers }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.requestTimeoutSeconds * 1000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.settings.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...headers,
        },
      });
      if (res.status === 304) {
        return { data: [] as unknown as T, status: 304, responseHeaders: res.headers };
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`GitHub API error (${res.status}) for ${url}: ${body}`.slice(0, 500));
      }
      const data = (await res.json()) as T;
      return { data, status: res.status, responseHeaders: res.headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  private formatEventDescription(event: GHEvent): string {
    const actor = event.actor.display_login ?? event.actor.login;
    const repo = event.repo.name;
    const payload = event.payload;

    switch (event.type) {
      case "PushEvent": {
        const size = (payload.size as number | undefined) ?? 0;
        return `${actor} pushed ${size} commit${size !== 1 ? "s" : ""} to ${repo}`;
      }
      case "CreateEvent": {
        const refType = (payload.ref_type as string | undefined) ?? "repository";
        const ref = payload.ref as string | undefined;
        return ref ? `${actor} created ${refType} ${ref} in ${repo}` : `${actor} created ${refType} ${repo}`;
      }
      case "DeleteEvent": {
        const refType = (payload.ref_type as string | undefined) ?? "branch";
        const ref = payload.ref as string | undefined;
        return `${actor} deleted ${refType} ${ref ?? ""} in ${repo}`;
      }
      case "IssuesEvent": {
        const action = (payload.action as string | undefined) ?? "updated";
        const title = (payload.issue as Record<string, unknown> | undefined)?.title as string | undefined;
        return `${actor} ${action} issue "${title ?? ""}" in ${repo}`;
      }
      case "PullRequestEvent": {
        const action = (payload.action as string | undefined) ?? "updated";
        const title = (payload.pull_request as Record<string, unknown> | undefined)?.title as string | undefined;
        return `${actor} ${action} PR "${title ?? ""}" in ${repo}`;
      }
      case "IssueCommentEvent": {
        const issueTitle = (payload.issue as Record<string, unknown> | undefined)?.title as string | undefined;
        return `${actor} commented on "${issueTitle ?? "issue"}" in ${repo}`;
      }
      case "WatchEvent":
        return `${actor} starred ${repo}`;
      case "ForkEvent":
        return `${actor} forked ${repo}`;
      case "ReleaseEvent": {
        const release = payload.release as Record<string, unknown> | undefined;
        const tagName = release?.tag_name as string | undefined;
        return `${actor} released ${tagName ?? "new version"} of ${repo}`;
      }
      case "PullRequestReviewEvent": {
        const prTitle = (payload.pull_request as Record<string, unknown> | undefined)?.title as string | undefined;
        return `${actor} reviewed PR "${prTitle ?? ""}" in ${repo}`;
      }
      case "PullRequestReviewCommentEvent": {
        const prTitle = (payload.pull_request as Record<string, unknown> | undefined)?.title as string | undefined;
        return `${actor} commented on PR review "${prTitle ?? ""}" in ${repo}`;
      }
      default:
        return `${actor} performed ${event.type ?? "action"} on ${repo}`;
    }
  }

  private notificationToHtmlUrl(notif: GHNotification): string {
    if (!notif.subject.url) return notif.repository.html_url;
    const apiUrl = notif.subject.url;
    return apiUrl
      .replace("https://api.github.com/repos/", "https://github.com/")
      .replace("/pulls/", "/pull/")
      .replace("/issues/", "/issues/")
      .replace("/commits/", "/commit/");
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
        ownerModule: "github",
        sourceKey: params.contextKey,
        summaryShort,
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(subjectFor("github", "contextUpdated"), this.sc.encode(JSON.stringify(contextEvent)));
  }

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_github");

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_github.notifications (
        id text PRIMARY KEY,
        gh_id text NOT NULL UNIQUE,
        reason text NOT NULL,
        subject_title text NOT NULL,
        subject_type text NOT NULL,
        subject_url text,
        repo_name text NOT NULL,
        updated_at timestamptz NOT NULL,
        unread boolean NOT NULL DEFAULT true,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS gh_notif_updated_idx ON mod_github.notifications (updated_at)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_github.events (
        id text PRIMARY KEY,
        gh_id text NOT NULL UNIQUE,
        event_type text NOT NULL,
        actor text NOT NULL,
        repo_name text NOT NULL,
        description text NOT NULL,
        created_at timestamptz NOT NULL,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS gh_events_created_idx ON mod_github.events (created_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS gh_events_repo_idx ON mod_github.events (repo_name, created_at)`);

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_github.releases (
        id text PRIMARY KEY,
        gh_id integer NOT NULL UNIQUE,
        repo_name text NOT NULL,
        tag_name text NOT NULL,
        release_name text,
        body text,
        html_url text NOT NULL,
        author text NOT NULL,
        published_at timestamptz NOT NULL,
        is_prerelease boolean NOT NULL DEFAULT false,
        payload jsonb NOT NULL,
        collected_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS gh_releases_repo_idx ON mod_github.releases (repo_name, published_at)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS gh_releases_published_idx ON mod_github.releases (published_at)`);

    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_github.activity_embeddings (
        id text PRIMARY KEY,
        context_key text NOT NULL,
        ts timestamptz NOT NULL,
        embedding vector(${embedDim})
      )
    `);
    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_github.activity_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS gh_activity_embeddings_ctx_idx ON mod_github.activity_embeddings (context_key, ts)`
    );
    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS gh_activity_embeddings_vec_idx ON mod_github.activity_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS gh_activity_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", { embedDim });
    }
  }

  async collectNotifications(): Promise<{ fetched: number; publishedNew: number }> {
    if (!this.settings.collectNotifications) return { fetched: 0, publishedNew: 0 };
    this.log("info", "collecting github notifications");

    const sinceDate = new Date(Date.now() - this.settings.lookbackHours * 3600_000).toISOString();
    const headers: Record<string, string> = {};
    if (this.lastModifiedNotifications) {
      headers["If-Modified-Since"] = this.lastModifiedNotifications;
    }

    let notifications: GHNotification[];
    try {
      const result = await this.ghFetch<GHNotification[]>(
        `${GH_API_BASE}/notifications?all=true&since=${sinceDate}&per_page=50`,
        headers
      );
      if (result.status === 304) {
        this.log("debug", "notifications not modified");
        return { fetched: 0, publishedNew: 0 };
      }
      const lm = result.responseHeaders.get("Last-Modified");
      if (lm) this.lastModifiedNotifications = lm;
      notifications = result.data;
    } catch (err) {
      this.log("error", "failed to fetch notifications", {
        err: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      return { fetched: 0, publishedNew: 0 };
    }

    let published = 0;
    for (const notif of notifications) {
      const sourceId = `gh-notif-${notif.id}`;
      const upsert = (await this.db.query(
        `
        INSERT INTO mod_github.notifications (
          id, gh_id, reason, subject_title, subject_type, subject_url,
          repo_name, updated_at, unread, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (gh_id) DO UPDATE SET
          unread = EXCLUDED.unread,
          updated_at = EXCLUDED.updated_at,
          payload = EXCLUDED.payload,
          collected_at = now()
        RETURNING (xmax = 0) AS inserted
        `,
        [
          sourceId,
          notif.id,
          notif.reason,
          notif.subject.title,
          notif.subject.type,
          notif.subject.url,
          notif.repository.full_name,
          notif.updated_at,
          notif.unread,
          notif,
        ]
      )) as unknown as { rows: Array<{ inserted: boolean }> };

      const inserted = Boolean(upsert.rows?.[0]?.inserted);
      if (inserted) {
        const msgId = uuidv5(sourceId, UUID_NAMESPACE);
        const contextKey = `repo:${notif.repository.full_name}`;
        const htmlUrl = this.notificationToHtmlUrl(notif);
        const messageBody = `[${notif.subject.type}] ${notif.subject.title}\n${notif.repository.full_name} | ${notif.reason}`;

        const normalized = NormalizedMessageSchema.parse({
          id: msgId,
          createdAt: notif.updated_at,
          source: { module: "github", stream: "notifications" },
          realtime: false,
          Message: messageBody,
          contextRef: { ownerModule: "github", sourceKey: contextKey },
          followMePanel: {
            module: "github",
            panelId: "notification",
            href: htmlUrl,
            label: "View on GitHub",
          },
          From: notif.repository.full_name,
          isDirectMention: notif.reason === "mention" || notif.reason === "team_mention",
          isDigest: false,
          isSystemMessage: false,
          tags: {
            source: "github",
            stream: "notification",
            reason: notif.reason,
            subjectType: notif.subject.type,
            repo: notif.repository.full_name,
            unread: notif.unread,
          },
        });
        const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
        this.nats.publish(subjectFor("github", "messageCreated"), this.sc.encode(JSON.stringify(event)));
        published++;
      }
    }

    this.log("info", "notifications collected", { fetched: notifications.length, publishedNew: published });
    return { fetched: notifications.length, publishedNew: published };
  }

  async collectEvents(): Promise<{ fetched: number; publishedNew: number }> {
    if (!this.settings.collectEvents) return { fetched: 0, publishedNew: 0 };
    this.log("info", "collecting github events", { username: this.settings.username });

    const perPage = Math.min(this.settings.maxEventsPerPoll, 100);
    const headers: Record<string, string> = {};
    if (this.etagEvents) {
      headers["If-None-Match"] = this.etagEvents;
    }

    let events: GHEvent[];
    try {
      const result = await this.ghFetch<GHEvent[]>(
        `${GH_API_BASE}/users/${encodeURIComponent(this.settings.username)}/received_events?per_page=${perPage}`,
        headers
      );
      if (result.status === 304) {
        this.log("debug", "events not modified");
        return { fetched: 0, publishedNew: 0 };
      }
      const etag = result.responseHeaders.get("ETag");
      if (etag) this.etagEvents = etag;
      events = result.data;
    } catch (err) {
      this.log("error", "failed to fetch events", {
        err: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      return { fetched: 0, publishedNew: 0 };
    }

    const lookbackCutoff = new Date(Date.now() - this.settings.lookbackHours * 3600_000);
    let published = 0;

    for (const ghEvent of events) {
      const eventTime = new Date(ghEvent.created_at);
      if (eventTime < lookbackCutoff) continue;

      const sourceId = `gh-event-${ghEvent.id}`;
      const description = this.formatEventDescription(ghEvent);
      const upsert = (await this.db.query(
        `
        INSERT INTO mod_github.events (
          id, gh_id, event_type, actor, repo_name, description, created_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (gh_id) DO NOTHING
        RETURNING (xmax = 0) AS inserted
        `,
        [
          sourceId,
          ghEvent.id,
          ghEvent.type,
          ghEvent.actor.display_login ?? ghEvent.actor.login,
          ghEvent.repo.name,
          description,
          ghEvent.created_at,
          ghEvent,
        ]
      )) as unknown as { rows: Array<{ inserted: boolean }> };

      const inserted = Boolean(upsert.rows?.[0]?.inserted);
      if (inserted) {
        const msgId = uuidv5(sourceId, UUID_NAMESPACE);
        const contextKey = `repo:${ghEvent.repo.name}`;
        const repoUrl = `https://github.com/${ghEvent.repo.name}`;

        const normalized = NormalizedMessageSchema.parse({
          id: msgId,
          createdAt: ghEvent.created_at,
          source: { module: "github", stream: "events" },
          realtime: false,
          Message: description,
          contextRef: { ownerModule: "github", sourceKey: contextKey },
          followMePanel: {
            module: "github",
            panelId: "event",
            href: repoUrl,
            label: "View on GitHub",
          },
          From: ghEvent.actor.display_login ?? ghEvent.actor.login,
          isDirectMention: false,
          isDigest: false,
          isSystemMessage: false,
          tags: {
            source: "github",
            stream: "event",
            eventType: ghEvent.type,
            actor: ghEvent.actor.display_login ?? ghEvent.actor.login,
            repo: ghEvent.repo.name,
          },
        });
        const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
        this.nats.publish(subjectFor("github", "messageCreated"), this.sc.encode(JSON.stringify(event)));
        published++;
      }
    }

    this.log("info", "events collected", { fetched: events.length, publishedNew: published });
    return { fetched: events.length, publishedNew: published };
  }

  async collectReleases(): Promise<{ fetched: number; publishedNew: number }> {
    if (!this.settings.collectReleases || this.settings.watchedRepos.length === 0) {
      return { fetched: 0, publishedNew: 0 };
    }
    this.log("info", "collecting github releases", { repos: this.settings.watchedRepos });

    let totalFetched = 0;
    let totalPublished = 0;
    const lookbackCutoff = new Date(Date.now() - this.settings.lookbackHours * 3600_000);

    for (const repoFullName of this.settings.watchedRepos) {
      let releases: GHRelease[];
      try {
        const result = await this.ghFetch<GHRelease[]>(
          `${GH_API_BASE}/repos/${repoFullName}/releases?per_page=10`
        );
        releases = result.data;
      } catch (err) {
        this.log("warn", "failed to fetch releases (continuing)", {
          repo: repoFullName,
          err: err instanceof Error ? { name: err.name, message: err.message } : err,
        });
        continue;
      }

      for (const release of releases) {
        if (release.draft) continue;
        const publishedAt = release.published_at ?? release.created_at;
        if (new Date(publishedAt) < lookbackCutoff) continue;

        totalFetched++;
        const sourceId = `gh-release-${release.id}`;
        const upsert = (await this.db.query(
          `
          INSERT INTO mod_github.releases (
            id, gh_id, repo_name, tag_name, release_name, body,
            html_url, author, published_at, is_prerelease, payload
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (gh_id) DO NOTHING
          RETURNING (xmax = 0) AS inserted
          `,
          [
            sourceId,
            release.id,
            repoFullName,
            release.tag_name,
            release.name,
            release.body,
            release.html_url,
            release.author.login,
            publishedAt,
            release.prerelease,
            release,
          ]
        )) as unknown as { rows: Array<{ inserted: boolean }> };

        const inserted = Boolean(upsert.rows?.[0]?.inserted);
        if (inserted) {
          const msgId = uuidv5(sourceId, UUID_NAMESPACE);
          const contextKey = `repo:${repoFullName}`;
          const messageBody = [
            `${repoFullName} released ${release.tag_name}${release.name ? ` — ${release.name}` : ""}`,
            release.prerelease ? "(pre-release)" : "",
            release.body ? release.body.slice(0, 500) : "",
          ]
            .filter(Boolean)
            .join("\n");

          const normalized = NormalizedMessageSchema.parse({
            id: msgId,
            createdAt: publishedAt,
            source: { module: "github", stream: "releases" },
            realtime: false,
            Message: messageBody,
            contextRef: { ownerModule: "github", sourceKey: contextKey },
            followMePanel: {
              module: "github",
              panelId: "release",
              href: release.html_url,
              label: "View Release",
            },
            From: release.author.login,
            isDirectMention: false,
            isDigest: false,
            isSystemMessage: false,
            tags: {
              source: "github",
              stream: "release",
              repo: repoFullName,
              tagName: release.tag_name,
              author: release.author.login,
              isPrerelease: release.prerelease,
            },
          });
          const event = MessageCreatedEventSchema.parse({ type: "MessageCreated", message: normalized });
          this.nats.publish(subjectFor("github", "messageCreated"), this.sc.encode(JSON.stringify(event)));
          totalPublished++;
        }
      }
    }

    this.log("info", "releases collected", { fetched: totalFetched, publishedNew: totalPublished });
    return { fetched: totalFetched, publishedNew: totalPublished };
  }

  async refreshContexts(params: { lookbackHours: number }): Promise<{
    updated: number;
    aiSummaries: number;
    fallbackSummaries: number;
    embeddingsInserted: number;
    avgTokenRate?: number;
  }> {
    const cutoff = new Date(Date.now() - params.lookbackHours * 3600_000);

    const repoRows = await this.db.query(
      `
      SELECT DISTINCT repo_name FROM (
        SELECT repo_name FROM mod_github.notifications WHERE updated_at >= $1
        UNION
        SELECT repo_name FROM mod_github.events WHERE created_at >= $1
        UNION
        SELECT repo_name FROM mod_github.releases WHERE published_at >= $1
      ) repos
      ORDER BY repo_name
      `,
      [cutoff]
    );

    let updated = 0;
    let aiSummaries = 0;
    let fallbackSummaries = 0;
    let embeddingsInserted = 0;
    let tokenRateSum = 0;
    let tokenRateCount = 0;

    for (const row of repoRows.rows as Array<{ repo_name: string }>) {
      const repoName = row.repo_name;
      const contextKey = `repo:${repoName}`;

      const prior = await this.db.query(
        `SELECT "summaryLong" FROM bus_contexts WHERE "ownerModule" = $1 AND "sourceKey" = $2 LIMIT 1`,
        ["github", contextKey]
      );
      const priorSummary = String(prior.rows?.[0]?.summaryLong ?? "");

      const notifRows = await this.db.query(
        `SELECT subject_title, subject_type, reason FROM mod_github.notifications
         WHERE repo_name = $1 AND updated_at >= $2 ORDER BY updated_at DESC LIMIT $3`,
        [repoName, cutoff, this.contextTopK]
      );
      const eventRows = await this.db.query(
        `SELECT description, event_type FROM mod_github.events
         WHERE repo_name = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT $3`,
        [repoName, cutoff, this.contextTopK]
      );
      const releaseRows = await this.db.query(
        `SELECT tag_name, release_name, body FROM mod_github.releases
         WHERE repo_name = $1 AND published_at >= $2 ORDER BY published_at DESC LIMIT 5`,
        [repoName, cutoff]
      );

      const lines: string[] = [];
      if (priorSummary) lines.push(`Prior summary:\n${priorSummary}`);
      lines.push(`Repository: ${repoName}`);

      for (const r of releaseRows.rows as Array<{ tag_name: string; release_name: string | null; body: string | null }>) {
        lines.push(`Release: ${r.tag_name}${r.release_name ? ` — ${r.release_name}` : ""}${r.body ? `\n${r.body.slice(0, 300)}` : ""}`);
      }
      for (const n of notifRows.rows as Array<{ subject_title: string; subject_type: string; reason: string }>) {
        lines.push(`[${n.subject_type}] ${n.subject_title} (${n.reason})`);
      }
      for (const e of eventRows.rows as Array<{ description: string; event_type: string }>) {
        lines.push(e.description);
      }

      if (lines.length <= 1) {
        const summaryShort = `Activity in ${repoName}`.slice(0, 128);
        await this.publishContextUpdate({
          contextKey,
          summaryShort,
          summaryLong: summaryShort,
          keyPoints: [],
        });
        fallbackSummaries++;
        updated++;
        continue;
      }

      const maxPromptChars = 8000;
      const prompt = lines.filter(Boolean).join("\n");
      const promptText = prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;

      try {
        const aiSummary = await this.aiGenerate(promptText);

        let contextEmbedding: number[] = [];
        try {
          contextEmbedding = await this.aiEmbed(aiSummary.summaryLong);
        } catch {
          // embedding optional
        }
        if (contextEmbedding.length) embeddingsInserted++;
        if (typeof aiSummary.tokenRate === "number") {
          tokenRateSum += aiSummary.tokenRate;
          tokenRateCount += 1;
        }
        await this.publishContextUpdate({
          contextKey,
          summaryShort: aiSummary.summaryShort,
          summaryLong: aiSummary.summaryLong,
          keyPoints: [],
          ...(contextEmbedding.length ? { embedding: contextEmbedding } : {}),
        });
        aiSummaries++;
      } catch (err) {
        const summaryShort = `Activity in ${repoName}`.slice(0, 128);
        await this.publishContextUpdate({
          contextKey,
          summaryShort,
          summaryLong: lines.slice(0, 5).join("\n"),
          keyPoints: [],
        });
        fallbackSummaries++;
        this.log("warn", "ai summary failed, using fallback", {
          repo: repoName,
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
