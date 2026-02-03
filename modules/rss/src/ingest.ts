import { XMLParser } from "fast-xml-parser";
import { v5 as uuidv5 } from "uuid";
import type { DbLike, NatsLike, StringCodecLike } from "@feedeater/module-sdk";

import {
  ContextUpdatedEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  subjectFor,
} from "@feedeater/core";

export interface RSSSettings {
  enabled: boolean;
  defaultPollIntervalMinutes: number;
  minPollIntervalMinutes: number;
  maxConcurrentPolls: number;
  requestTimeoutSeconds: number;
  userAgent: string;
  useConditionalGet: boolean;
  adaptivePolling: boolean;
  adaptiveMinMinutes: number;
  adaptiveMaxMinutes: number;
  retentionDays: number;
  maxEntriesPerFeed: number;
  contextPrompt: string;
  contextPromptFallback: string;
};

export interface Feed {
  id: string;
  url: string;
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  pollIntervalMinutes: number | null;
  enabled: boolean;
  tags: Record<string, unknown>;
};

export interface PollState {
  feedId: string;
  etag: string | null;
  lastModified: string | null;
  nextPollAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  consecutiveErrors: number;
  consecutive304s: number;
};

type ParsedEntry = {
  guid: string;
  url: string | null;
  title: string | null;
  content: string | null;
  author: string | null;
  publishedAt: Date | null;
  enclosures: Array<{ url: string; type: string | null; length: number | null }>;
};

type ParsedFeed = {
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  entries: ParsedEntry[];
};

const UUID_NAMESPACE = "c7f3a84d-9b52-4e68-a1ea-33de67e3f9aa";

// Type helper for db query results
type QueryResult<T> = { rows: T[]; rowCount?: number | null };

export function parseRSSSettingsFromInternal(raw: Record<string, unknown>): RSSSettings {
  const enabled = String(raw.enabled ?? "true") !== "false";
  const defaultPollIntervalMinutes = raw.defaultPollIntervalMinutes
    ? Number(raw.defaultPollIntervalMinutes)
    : 30;
  const minPollIntervalMinutes = raw.minPollIntervalMinutes
    ? Number(raw.minPollIntervalMinutes)
    : 5;
  const maxConcurrentPolls = raw.maxConcurrentPolls ? Number(raw.maxConcurrentPolls) : 10;
  const requestTimeoutSeconds = raw.requestTimeoutSeconds
    ? Number(raw.requestTimeoutSeconds)
    : 30;
  const userAgent = String(
    raw.userAgent ?? "FeedEater/1.0 (+https://feedeater.app)"
  );
  const useConditionalGet = String(raw.useConditionalGet ?? "true") !== "false";
  const adaptivePolling = String(raw.adaptivePolling ?? "false") === "true";
  const adaptiveMinMinutes = raw.adaptiveMinMinutes
    ? Number(raw.adaptiveMinMinutes)
    : 5;
  const adaptiveMaxMinutes = raw.adaptiveMaxMinutes
    ? Number(raw.adaptiveMaxMinutes)
    : 1440;
  const retentionDays = raw.retentionDays ? Number(raw.retentionDays) : 90;
  const maxEntriesPerFeed = raw.maxEntriesPerFeed ? Number(raw.maxEntriesPerFeed) : 1000;

  const defaultContextPrompt =
    "You are summarizing recent RSS feed entries. Summarize ONLY the content provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs describing the feed's current focus and themes.";
  const defaultContextPromptFallback =
    "Summarize ONLY the provided feed entries in plain text. 1-3 short sentences about the feed's recent content. Do not return JSON. Do not make suggestions or ask questions.";
  const contextPrompt =
    String(raw.contextPrompt ?? "").trim() || defaultContextPrompt;
  const contextPromptFallback =
    String(raw.contextPromptFallback ?? "").trim() || defaultContextPromptFallback;

  return {
    enabled,
    defaultPollIntervalMinutes,
    minPollIntervalMinutes,
    maxConcurrentPolls,
    requestTimeoutSeconds,
    userAgent,
    useConditionalGet,
    adaptivePolling,
    adaptiveMinMinutes,
    adaptiveMaxMinutes,
    retentionDays,
    maxEntriesPerFeed,
    contextPrompt,
    contextPromptFallback,
  };
}

export class RSSIngestor {
  private apiBaseUrl: string;
  private internalToken: string;
  private contextTopK: number;
  private embedDim: number;

  private parser: XMLParser;

  constructor(
    private readonly settings: RSSSettings,
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

    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      cdataPropName: "__cdata",
      parseTagValue: true,
      trimValues: true,
      // Don't remove namespace prefixes - we handle them manually
      removeNSPrefix: false,
    });
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: unknown
  ) {
    try {
      this.nats.publish(
        "feedeater.rss.log",
        this.sc.encode(
          JSON.stringify({
            level,
            module: "rss",
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

  async ensureSchema(): Promise<void> {
    await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.db.query("CREATE SCHEMA IF NOT EXISTS mod_rss");

    // Feed subscriptions table
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_rss.feeds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        url TEXT NOT NULL UNIQUE,
        title TEXT,
        site_url TEXT,
        description TEXT,
        poll_interval_minutes INT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        tags JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS feeds_enabled_idx ON mod_rss.feeds (enabled)`
    );

    // Cached entries table
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_rss.entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        feed_id UUID NOT NULL REFERENCES mod_rss.feeds(id) ON DELETE CASCADE,
        guid TEXT NOT NULL,
        url TEXT,
        title TEXT,
        content TEXT,
        author TEXT,
        published_at TIMESTAMPTZ,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        payload JSONB,
        UNIQUE(feed_id, guid)
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS entries_feed_published_idx ON mod_rss.entries (feed_id, published_at DESC)`
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS entries_collected_idx ON mod_rss.entries (collected_at)`
    );

    // Poll state table for conditional GET
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_rss.poll_state (
        feed_id UUID PRIMARY KEY REFERENCES mod_rss.feeds(id) ON DELETE CASCADE,
        etag TEXT,
        last_modified TEXT,
        next_poll_at TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        last_error TEXT,
        last_error_at TIMESTAMPTZ,
        consecutive_errors INT NOT NULL DEFAULT 0,
        consecutive_304s INT NOT NULL DEFAULT 0
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS poll_state_next_poll_idx ON mod_rss.poll_state (next_poll_at)`
    );

    // Embeddings table for semantic search
    const embedDim = Number.isFinite(this.embedDim) ? this.embedDim : 4096;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS mod_rss.entry_embeddings (
        id UUID PRIMARY KEY,
        feed_id UUID NOT NULL,
        context_key TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        embedding vector(${embedDim})
      )
    `);

    if (Number.isFinite(embedDim) && embedDim > 0) {
      await this.db.query(
        `ALTER TABLE mod_rss.entry_embeddings ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    }

    await this.db.query(
      `CREATE INDEX IF NOT EXISTS entry_embeddings_context_idx ON mod_rss.entry_embeddings (context_key, ts)`
    );

    if (Number.isFinite(embedDim) && embedDim <= 2000) {
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS entry_embeddings_vec_idx ON mod_rss.entry_embeddings USING ivfflat (embedding vector_cosine_ops)`
      );
    } else {
      await this.db.query(`DROP INDEX IF EXISTS mod_rss.entry_embeddings_vec_idx`);
      this.log("warn", "skipping ivfflat index (embedding dim > 2000)", {
        embedDim,
      });
    }
  }

  /**
   * Parse date from various RSS/Atom formats
   */
  private parseDate(dateStr: string | null | undefined): Date | null {
    if (!dateStr) return null;

    const str = String(dateStr).trim();
    if (!str) return null;

    // Try ISO 8601 / RFC 3339 first (most reliable)
    const isoDate = new Date(str);
    if (!isNaN(isoDate.getTime())) return isoDate;

    // Try unix timestamp (string)
    if (/^\d{10,13}$/.test(str)) {
      const ts = parseInt(str, 10);
      const date = new Date(ts > 1e11 ? ts : ts * 1000);
      if (!isNaN(date.getTime())) return date;
    }

    // RFC 822 variations
    const rfc822Patterns = [
      // "Sat, 07 Sep 2002 09:42:31 GMT"
      /^\w+,\s+(\d{1,2})\s+(\w+)\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([\w+-]+)?$/,
      // "07 Sep 2002 09:42:31 GMT" (missing day name)
      /^(\d{1,2})\s+(\w+)\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([\w+-]+)?$/,
    ];

    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };

    for (const pattern of rfc822Patterns) {
      const match = str.match(pattern);
      if (match && match[1] && match[2] && match[3] && match[4] && match[5] && match[6]) {
        const day = parseInt(match[1], 10);
        const monthName = match[2].toLowerCase().slice(0, 3);
        const month = months[monthName];
        const year = parseInt(match[3], 10);
        const hour = parseInt(match[4], 10);
        const minute = parseInt(match[5], 10);
        const second = parseInt(match[6], 10);

        if (month !== undefined) {
          const date = new Date(Date.UTC(year, month, day, hour, minute, second));
          if (!isNaN(date.getTime())) return date;
        }
      }
    }

    // Fallback: let Date.parse try its best
    const fallback = Date.parse(str);
    if (!isNaN(fallback)) return new Date(fallback);

    this.log("warn", "failed to parse date", { dateStr: str });
    return null;
  }

  /**
   * Extract text content from various XML node formats
   */
  private extractText(node: unknown): string | null {
    if (node === null || node === undefined) return null;
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);

    const obj = node as Record<string, unknown>;

    // Handle CDATA sections
    if (obj.__cdata !== undefined) return String(obj.__cdata);

    // Handle text nodes
    if (obj["#text"] !== undefined) return String(obj["#text"]);

    // If it's an object with a single text value
    if (typeof obj === "object" && Object.keys(obj).length === 0) return null;

    return null;
  }

  /**
   * Get content from entry, checking multiple possible fields
   */
  private getEntryContent(entry: Record<string, unknown>): string | null {
    // Priority order per CLAUDE.md
    const candidates = [
      entry["content:encoded"],
      (entry.content as Record<string, unknown> | undefined)?.["#text"],
      entry.content,
      entry.description,
      entry.summary,
    ];

    for (const candidate of candidates) {
      const text = this.extractText(candidate);
      if (text && text.trim()) return text.trim();
    }

    return null;
  }

  /**
   * Generate a stable GUID for an entry
   */
  private getEntryGuid(entry: Record<string, unknown>, feedId: string): string {
    // Try explicit guid/id fields first
    const explicitGuid = this.extractText(entry.guid) || this.extractText(entry.id);
    if (explicitGuid) return explicitGuid.trim().toLowerCase();

    // Fallback to link
    const link = this.extractText(entry.link);
    if (link) return link.trim().toLowerCase();

    // Last resort: hash of title + pubDate + feedId
    const title = this.extractText(entry.title) || "";
    const pubDate = this.extractText(entry.pubDate) || this.extractText(entry.published) || "";
    return `${feedId}:${title}:${pubDate}`.toLowerCase();
  }

  /**
   * Parse RSS/Atom XML into normalized structure
   */
  parseFeed(xml: string, feedUrl: string): ParsedFeed {
    const parsed = this.parser.parse(xml) as Record<string, unknown>;

    // Detect format and extract channel/feed
    let feedData: Record<string, unknown>;
    let items: unknown[];

    if (parsed.rss) {
      // RSS 2.0 / 0.9x
      const rss = parsed.rss as Record<string, unknown>;
      feedData = (rss.channel || {}) as Record<string, unknown>;
      items = Array.isArray(feedData.item)
        ? feedData.item
        : feedData.item
          ? [feedData.item]
          : [];
    } else if (parsed.feed) {
      // Atom 1.0
      feedData = parsed.feed as Record<string, unknown>;
      items = Array.isArray(feedData.entry)
        ? feedData.entry
        : feedData.entry
          ? [feedData.entry]
          : [];
    } else if ((parsed as Record<string, unknown>)["rdf:RDF"]) {
      // RSS 1.0 (RDF)
      const rdf = (parsed as Record<string, unknown>)["rdf:RDF"] as Record<string, unknown>;
      feedData = (rdf.channel || {}) as Record<string, unknown>;
      items = Array.isArray(rdf.item) ? rdf.item : rdf.item ? [rdf.item] : [];
    } else {
      throw new Error("Unrecognized feed format");
    }

    // Extract feed metadata
    const title = this.extractText(feedData.title);
    
    // Get site URL - handle Atom link elements
    let siteUrl: string | null = null;
    const linkNode = feedData.link;
    if (typeof linkNode === "string") {
      siteUrl = linkNode;
    } else if (Array.isArray(linkNode)) {
      // Atom: find rel="alternate" or first link
      for (const l of linkNode) {
        const lObj = l as Record<string, unknown>;
        const rel = lObj["@_rel"] || "alternate";
        if (rel === "alternate" || rel === undefined) {
          siteUrl = String(lObj["@_href"] || "");
          break;
        }
      }
    } else if (linkNode && typeof linkNode === "object") {
      const lObj = linkNode as Record<string, unknown>;
      siteUrl = String(lObj["@_href"] || lObj["#text"] || "");
    }

    const description =
      this.extractText(feedData.description) ||
      this.extractText(feedData.subtitle);

    // Parse entries
    const entries: ParsedEntry[] = [];
    for (const item of items) {
      const entry = item as Record<string, unknown>;

      // Extract link
      let entryUrl: string | null = null;
      const entryLink = entry.link;
      if (typeof entryLink === "string") {
        entryUrl = entryLink;
      } else if (Array.isArray(entryLink)) {
        // Atom: prefer alternate link
        for (const l of entryLink) {
          const lObj = l as Record<string, unknown>;
          const rel = lObj["@_rel"] || "alternate";
          if (rel === "alternate") {
            entryUrl = String(lObj["@_href"] || "");
            break;
          }
        }
        if (!entryUrl && entryLink.length > 0) {
          const first = entryLink[0] as Record<string, unknown>;
          entryUrl = String(first["@_href"] || "");
        }
      } else if (entryLink && typeof entryLink === "object") {
        const lObj = entryLink as Record<string, unknown>;
        entryUrl = String(lObj["@_href"] || lObj["#text"] || "");
      }

      // Extract enclosures (for podcasts, etc.)
      const enclosures: ParsedEntry["enclosures"] = [];
      const enclosure = entry.enclosure;
      if (enclosure) {
        const encArr = Array.isArray(enclosure) ? enclosure : [enclosure];
        for (const enc of encArr) {
          const encObj = enc as Record<string, unknown>;
          const encUrl = String(encObj["@_url"] || "");
          if (encUrl) {
            enclosures.push({
              url: encUrl,
              type: encObj["@_type"] ? String(encObj["@_type"]) : null,
              length: encObj["@_length"] ? Number(encObj["@_length"]) : null,
            });
          }
        }
      }

      // Extract author
      const author =
        this.extractText(entry.author) ||
        this.extractText((entry.author as Record<string, unknown>)?.name) ||
        this.extractText(entry["dc:creator"]) ||
        null;

      // Extract date
      const publishedAt = this.parseDate(
        this.extractText(entry.pubDate) ||
        this.extractText(entry.published) ||
        this.extractText(entry.updated) ||
        this.extractText(entry["dc:date"])
      );

      entries.push({
        guid: this.getEntryGuid(entry, feedUrl),
        url: entryUrl,
        title: this.extractText(entry.title),
        content: this.getEntryContent(entry),
        author,
        publishedAt,
        enclosures,
      });
    }

    return { title, siteUrl, description, entries };
  }

  /**
   * Fetch a single feed with conditional GET support
   */
  async fetchFeed(feed: Feed, state: PollState | null): Promise<{
    changed: boolean;
    parsed?: ParsedFeed;
    etag?: string | null;
    lastModified?: string | null;
    error?: string;
  }> {
    const headers: Record<string, string> = {
      "User-Agent": this.settings.userAgent,
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    };

    // Add conditional GET headers if we have cached values
    if (this.settings.useConditionalGet) {
      if (state?.etag) {
        headers["If-None-Match"] = state.etag;
      }
      if (state?.lastModified) {
        headers["If-Modified-Since"] = state.lastModified;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.settings.requestTimeoutSeconds * 1000
    );

    try {
      const response = await fetch(feed.url, {
        headers,
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      // Handle 304 Not Modified
      if (response.status === 304) {
        return {
          changed: false,
          etag: response.headers.get("ETag") || state?.etag || null,
          lastModified: response.headers.get("Last-Modified") || state?.lastModified || null,
        };
      }

      if (!response.ok) {
        return { changed: false, error: `HTTP ${response.status}` };
      }

      // Check content length
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
        return { changed: false, error: "Feed too large (>10MB)" };
      }

      // Handle encoding per CLAUDE.md recommendations
      const bytes = await response.arrayBuffer();
      const xmlDecl = new TextDecoder("ascii").decode(bytes.slice(0, 100));
      const declMatch = xmlDecl.match(/encoding=['"]([^'"]+)['"]/);
      const contentType = response.headers.get("content-type") || "";
      const charsetMatch = contentType.match(/charset=([^\s;]+)/);
      const encoding = declMatch?.[1] || charsetMatch?.[1] || "utf-8";

      let xml: string;
      try {
        xml = new TextDecoder(encoding).decode(bytes);
      } catch {
        // Fallback to UTF-8 if encoding is unknown
        xml = new TextDecoder("utf-8").decode(bytes);
      }

      const parsed = this.parseFeed(xml, feed.url);

      return {
        changed: true,
        parsed,
        etag: response.headers.get("ETag"),
        lastModified: response.headers.get("Last-Modified"),
      };
    } catch (err) {
      clearTimeout(timeout);
      const errorMsg =
        err instanceof Error ? err.message : "Unknown fetch error";
      return { changed: false, error: errorMsg };
    }
  }

  /**
   * Calculate next poll time based on adaptive polling settings
   */
  private calculateNextPoll(
    feed: Feed,
    state: PollState | null,
    hadNewEntries: boolean
  ): Date {
    const baseInterval =
      feed.pollIntervalMinutes || this.settings.defaultPollIntervalMinutes;

    if (!this.settings.adaptivePolling) {
      return new Date(Date.now() + baseInterval * 60 * 1000);
    }

    let multiplier = 1;
    if (hadNewEntries) {
      // Content found, poll more frequently
      multiplier = 0.75;
    } else {
      // No new content, back off gradually
      const consecutive304s = (state?.consecutive304s || 0) + 1;
      multiplier = 1 + consecutive304s * 0.25;
    }

    const newInterval = Math.max(
      this.settings.adaptiveMinMinutes,
      Math.min(this.settings.adaptiveMaxMinutes, baseInterval * multiplier)
    );

    return new Date(Date.now() + newInterval * 60 * 1000);
  }

  /**
   * Publish MessageCreated event for a new entry
   */
  private publishMessageCreated(
    entry: ParsedEntry,
    feed: Feed,
    entryId: string
  ) {
    const contextKey = `feed:${feed.id}`;
    const msgId = uuidv5(`rss-${feed.id}-${entry.guid}`, UUID_NAMESPACE);

    const normalized = NormalizedMessageSchema.parse({
      id: msgId,
      createdAt: (entry.publishedAt || new Date()).toISOString(),
      source: { module: "rss", stream: feed.id },
      realtime: false,
      Message: entry.content || entry.title || "",
      contextRef: { ownerModule: "rss", sourceKey: contextKey },
      followMePanel: entry.url
        ? {
            module: "rss",
            panelId: "entry",
            href: entry.url,
            label: "Read Article",
          }
        : undefined,
      From: entry.author || feed.title || "Unknown",
      isDirectMention: false,
      isDigest: false,
      isSystemMessage: false,
      tags: {
        source: "rss",
        feedId: feed.id,
        feedTitle: feed.title || "",
        author: entry.author || "",
        hasEnclosure: entry.enclosures.length > 0,
      },
    });

    const event = MessageCreatedEventSchema.parse({
      type: "MessageCreated",
      message: normalized,
    });

    this.nats.publish(
      subjectFor("rss", "messageCreated"),
      this.sc.encode(JSON.stringify(event))
    );
  }

  /**
   * Poll all feeds that are due
   */
  async pollFeeds(): Promise<{
    feedsPolled: number;
    entriesInserted: number;
    feedsUnchanged: number;
    feedsErrored: number;
  }> {
    this.log("info", "rss poll starting");

    // Get feeds due for polling
    const result = await this.db.query(`
      SELECT f.id, f.url, f.title, f.site_url, f.description, 
             f.poll_interval_minutes, f.enabled, f.tags
      FROM mod_rss.feeds f
      LEFT JOIN mod_rss.poll_state ps ON ps.feed_id = f.id
      WHERE f.enabled = true
        AND (ps.next_poll_at IS NULL OR ps.next_poll_at <= now())
      ORDER BY COALESCE(ps.next_poll_at, '1970-01-01'::timestamptz)
      LIMIT $1
    `, [this.settings.maxConcurrentPolls]) as QueryResult<Feed>;

    const feeds = result.rows;
    if (feeds.length === 0) {
      this.log("info", "no feeds due for polling");
      return { feedsPolled: 0, entriesInserted: 0, feedsUnchanged: 0, feedsErrored: 0 };
    }

    let feedsPolled = 0;
    let entriesInserted = 0;
    let feedsUnchanged = 0;
    let feedsErrored = 0;

    for (const feed of feeds) {
      feedsPolled++;

      // Get current poll state
      const stateResult = await this.db.query(
        `SELECT * FROM mod_rss.poll_state WHERE feed_id = $1`,
        [feed.id]
      ) as QueryResult<PollState>;
      const state = stateResult.rows[0] as PollState | undefined;

      const fetchResult = await this.fetchFeed(feed, state || null);

      if (fetchResult.error) {
        feedsErrored++;
        this.log("warn", "feed fetch error", {
          feedId: feed.id,
          url: feed.url,
          error: fetchResult.error,
        });

        // Update poll state with error
        const consecutiveErrors = (state?.consecutiveErrors || 0) + 1;
        const backoffMinutes = Math.min(60, Math.pow(2, consecutiveErrors));
        const nextPollAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

        await this.db.query(
          `
          INSERT INTO mod_rss.poll_state (feed_id, next_poll_at, last_error, last_error_at, consecutive_errors)
          VALUES ($1, $2, $3, now(), $4)
          ON CONFLICT (feed_id) DO UPDATE SET
            next_poll_at = EXCLUDED.next_poll_at,
            last_error = EXCLUDED.last_error,
            last_error_at = EXCLUDED.last_error_at,
            consecutive_errors = EXCLUDED.consecutive_errors
          `,
          [feed.id, nextPollAt, fetchResult.error, consecutiveErrors]
        );
        continue;
      }

      if (!fetchResult.changed) {
        feedsUnchanged++;
        // Update poll state for 304
        const consecutive304s = (state?.consecutive304s || 0) + 1;
        const nextPollAt = this.calculateNextPoll(feed, state || null, false);

        await this.db.query(
          `
          INSERT INTO mod_rss.poll_state (feed_id, etag, last_modified, next_poll_at, consecutive_304s, consecutive_errors)
          VALUES ($1, $2, $3, $4, $5, 0)
          ON CONFLICT (feed_id) DO UPDATE SET
            etag = COALESCE(EXCLUDED.etag, mod_rss.poll_state.etag),
            last_modified = COALESCE(EXCLUDED.last_modified, mod_rss.poll_state.last_modified),
            next_poll_at = EXCLUDED.next_poll_at,
            consecutive_304s = EXCLUDED.consecutive_304s,
            consecutive_errors = 0
          `,
          [feed.id, fetchResult.etag, fetchResult.lastModified, nextPollAt, consecutive304s]
        );
        continue;
      }

      // Process new/updated feed
      const parsed = fetchResult.parsed!;

      // Update feed metadata if changed
      if (parsed.title || parsed.siteUrl || parsed.description) {
        await this.db.query(
          `
          UPDATE mod_rss.feeds SET
            title = COALESCE($2, title),
            site_url = COALESCE($3, site_url),
            description = COALESCE($4, description),
            updated_at = now()
          WHERE id = $1
          `,
          [feed.id, parsed.title, parsed.siteUrl, parsed.description]
        );
      }

      // Insert new entries
      const client = await this.db.connect();
      let newEntries = 0;
      try {
        await client.query("BEGIN");

        for (const entry of parsed.entries) {
          const insertResult = await client.query(
            `
            INSERT INTO mod_rss.entries (feed_id, guid, url, title, content, author, published_at, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (feed_id, guid) DO UPDATE SET
              title = EXCLUDED.title,
              content = EXCLUDED.content,
              author = EXCLUDED.author,
              published_at = COALESCE(EXCLUDED.published_at, mod_rss.entries.published_at)
            RETURNING id, (xmax = 0) AS inserted
            `,
            [
              feed.id,
              entry.guid,
              entry.url,
              entry.title,
              entry.content,
              entry.author,
              entry.publishedAt,
              entry as unknown,
            ]
          ) as QueryResult<{ id: string; inserted: boolean }>;

          const row = insertResult.rows[0];
          if (row && row.inserted) {
            newEntries++;
            entriesInserted++;
            this.publishMessageCreated(entry, feed, row.id);

            // Generate and store embedding
            if (entry.content || entry.title) {
              try {
                const embedding = await this.aiEmbed(
                  entry.content || entry.title || ""
                );
                if (embedding.length === this.embedDim) {
                  await client.query(
                    `
                    INSERT INTO mod_rss.entry_embeddings (id, feed_id, context_key, ts, embedding)
                    VALUES ($1, $2, $3, $4, $5::vector)
                    ON CONFLICT (id) DO NOTHING
                    `,
                    [
                      row.id,
                      feed.id,
                      `feed:${feed.id}`,
                      entry.publishedAt || new Date(),
                      `[${embedding.join(",")}]`,
                    ]
                  );
                }
              } catch (embErr) {
                this.log("warn", "embedding failed", {
                  entryId: row.id,
                  error:
                    embErr instanceof Error ? embErr.message : String(embErr),
                });
              }
            }
          }
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      // Update poll state
      const nextPollAt = this.calculateNextPoll(feed, state || null, newEntries > 0);
      await this.db.query(
        `
        INSERT INTO mod_rss.poll_state (feed_id, etag, last_modified, next_poll_at, last_success_at, consecutive_errors, consecutive_304s)
        VALUES ($1, $2, $3, $4, now(), 0, 0)
        ON CONFLICT (feed_id) DO UPDATE SET
          etag = EXCLUDED.etag,
          last_modified = EXCLUDED.last_modified,
          next_poll_at = EXCLUDED.next_poll_at,
          last_success_at = EXCLUDED.last_success_at,
          consecutive_errors = 0,
          consecutive_304s = 0
        `,
        [feed.id, fetchResult.etag, fetchResult.lastModified, nextPollAt]
      );

      this.log("info", "feed polled successfully", {
        feedId: feed.id,
        url: feed.url,
        entriesTotal: parsed.entries.length,
        entriesNew: newEntries,
      });
    }

    this.log("info", "rss poll complete", {
      feedsPolled,
      entriesInserted,
      feedsUnchanged,
      feedsErrored,
    });

    return { feedsPolled, entriesInserted, feedsUnchanged, feedsErrored };
  }

  /**
   * AI embedding helper
   */
  private async aiEmbed(text: string): Promise<number[]> {
    if (!this.apiBaseUrl || !this.internalToken) {
      throw new Error("AI embedding unavailable");
    }
    const res = await fetch(`${this.apiBaseUrl}/api/internal/ai/embedding`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.internalToken}`,
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`AI embedding failed (${res.status})`);
    const data = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) throw new Error("Invalid embedding response");
    return data.embedding;
  }

  /**
   * AI summary helper
   */
  private async aiGenerate(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
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
        system: this.settings.contextPrompt,
        format: "json",
      }),
    });
    if (!res.ok) {
      return this.aiGenerateFallback(prompt);
    }
    const data = (await res.json()) as { response?: string };
    const rawResponse = String(data.response ?? "").trim();
    if (!rawResponse) return this.aiGenerateFallback(prompt);

    const parsed = this.parseSummaryJson(rawResponse);
    if (!parsed) return this.aiGenerateFallback(prompt);

    return {
      summaryShort: parsed.summaryShort.slice(0, 128),
      summaryLong: parsed.summaryLong,
      rawResponse,
    };
  }

  private async aiGenerateFallback(prompt: string): Promise<{
    summaryShort: string;
    summaryLong: string;
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
    if (!res.ok) throw new Error(`AI summary fallback failed (${res.status})`);
    const data = (await res.json()) as { response?: string };
    const rawResponse = String(data.response ?? "").trim();
    if (!rawResponse) throw new Error("Empty fallback response");
    return {
      summaryShort: rawResponse.slice(0, 128),
      summaryLong: rawResponse,
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

  private async publishContextUpdate(params: {
    contextKey: string;
    summaryShort: string;
    summaryLong: string;
    keyPoints?: string[];
    embedding?: number[];
  }) {
    const contextEvent = ContextUpdatedEventSchema.parse({
      type: "ContextUpdated",
      createdAt: new Date().toISOString(),
      context: {
        ownerModule: "rss",
        sourceKey: params.contextKey,
        summaryShort: params.summaryShort.slice(0, 128),
        summaryLong: params.summaryLong,
        keyPoints: params.keyPoints ?? [],
        embedding: params.embedding,
      },
    });
    this.nats.publish(
      subjectFor("rss", "contextUpdated"),
      this.sc.encode(JSON.stringify(contextEvent))
    );
  }

  /**
   * Refresh context summaries for all feeds
   */
  async refreshContexts(params: { lookbackDays: number }): Promise<{
    updated: number;
    aiSummaries: number;
    embeddingsInserted: number;
  }> {
    const cutoff = new Date(Date.now() - params.lookbackDays * 24 * 3600_000);

    // Get feeds with recent entries
    const result = await this.db.query(
      `
      SELECT DISTINCT f.id, f.title, f.description
      FROM mod_rss.feeds f
      JOIN mod_rss.entries e ON e.feed_id = f.id
      WHERE f.enabled = true AND e.collected_at >= $1
      `,
      [cutoff]
    ) as QueryResult<{
      id: string;
      title: string | null;
      description: string | null;
    }>;

    const feeds = result.rows;

    let updated = 0;
    let aiSummaries = 0;
    let embeddingsInserted = 0;

    for (const feed of feeds) {
      const contextKey = `feed:${feed.id}`;

      // Get recent entries for this feed
      const entriesResult = await this.db.query(
        `
        SELECT title, content, author, published_at
        FROM mod_rss.entries
        WHERE feed_id = $1 AND collected_at >= $2
        ORDER BY COALESCE(published_at, collected_at) DESC
        LIMIT 20
        `,
        [feed.id, cutoff]
      ) as QueryResult<{
        title: string | null;
        content: string | null;
        author: string | null;
        published_at: Date | null;
      }>;

      const entries = entriesResult.rows;

      if (entries.length === 0) continue;

      // Build prompt
      const entryList = entries
        .map((e, i) => {
          const title = e.title || "(untitled)";
          const date = e.published_at
            ? e.published_at.toISOString().split("T")[0]
            : "unknown date";
          return `(${i + 1}) ${title} [${date}]`;
        })
        .join("\n");

      const prompt = [
        `Feed: ${feed.title || "Unknown Feed"}`,
        feed.description ? `Description: ${feed.description}` : "",
        "",
        "Recent entries:",
        entryList,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 8000);

      try {
        const summary = await this.aiGenerate(prompt);
        aiSummaries++;

        // Generate embedding for context
        let contextEmbedding: number[] | undefined;
        try {
          contextEmbedding = await this.aiEmbed(summary.summaryLong);
          if (contextEmbedding.length === this.embedDim) {
            embeddingsInserted++;
          } else {
            contextEmbedding = undefined;
          }
        } catch {
          // Embedding optional
        }

        await this.publishContextUpdate({
          contextKey,
          summaryShort: summary.summaryShort,
          summaryLong: summary.summaryLong,
          ...(contextEmbedding ? { embedding: contextEmbedding } : {}),
        });

        updated++;
      } catch (err) {
        this.log("warn", "context update failed", {
          feedId: feed.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.log("info", "context refresh complete", {
      updated,
      aiSummaries,
      embeddingsInserted,
    });

    return { updated, aiSummaries, embeddingsInserted };
  }

  /**
   * Clean up old entries past retention period
   */
  async cleanup(): Promise<{ entriesDeleted: number; embeddingsDeleted: number }> {
    const cutoff = new Date(
      Date.now() - this.settings.retentionDays * 24 * 3600_000
    );

    // Delete old embeddings first (FK constraint)
    const embResult = await this.db.query(
      `
      DELETE FROM mod_rss.entry_embeddings
      WHERE ts < $1
      RETURNING id
      `,
      [cutoff]
    ) as QueryResult<{ id: string }>;

    // Delete old entries
    const entryResult = await this.db.query(
      `
      DELETE FROM mod_rss.entries
      WHERE collected_at < $1
      RETURNING id
      `,
      [cutoff]
    ) as QueryResult<{ id: string }>;

    const entriesDeleted = entryResult.rowCount ?? 0;
    const embeddingsDeleted = embResult.rowCount ?? 0;

    this.log("info", "cleanup complete", { entriesDeleted, embeddingsDeleted });

    return { entriesDeleted, embeddingsDeleted };
  }
}
