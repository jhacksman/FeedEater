# RSS Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the RSS module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The RSS module collects content from RSS/Atom feeds and normalizes them into FeedEater's unified message bus. Each feed becomes a Context that evolves as new entries arrive.

## Architecture

### Data Flow

1. **poll job** (every 5 min): Iterates feeds due for polling → fetches with conditional GET → parses entries → stores in `mod_rss.entries` → publishes `MessageCreated` events
2. **updateContexts job** (every 30 min): Generates AI summaries for each feed's recent content → publishes `ContextUpdated` events
3. **cleanup job** (daily): Removes entries older than retention period

### Context Key Format

`feed:{feedId}` - e.g., `feed:a1b2c3d4`

Each entry links to its feed context; no sub-contexts unless the feed represents threaded discussions.

### Key Tables

- `mod_rss.feeds` — Subscription list (URL, title, settings overrides)
- `mod_rss.entries` — Parsed entries (guid, title, content, published, link)
- `mod_rss.poll_state` — Per-feed: ETag, Last-Modified, nextPollAt, consecutiveErrors
- `mod_rss.entry_embeddings` — Vector store for semantic search

---

## Parsing Edge Cases (CRITICAL)

RSS is a minefield. The "spec" is more of a suggestion.

### Character Encoding

```typescript
// WRONG: Trust Content-Type header
const xml = await response.text();

// RIGHT: Check XML declaration first, fallback to header, default UTF-8
const bytes = await response.arrayBuffer();
const xmlDecl = new TextDecoder('ascii').decode(bytes.slice(0, 100));
const declMatch = xmlDecl.match(/encoding=['"]([^'"]+)['"]/);
const encoding = declMatch?.[1] || response.headers.get('content-type')?.match(/charset=([^\s;]+)/)?.[1] || 'utf-8';
const xml = new TextDecoder(encoding).decode(bytes);
```

Common encoding issues:
- `ISO-8859-1` declared but actual UTF-8
- No declaration, header says `text/xml` (defaults to US-ASCII per spec!)
- Windows-1252 smartquotes in "UTF-8" feeds

### Date Parsing

RSS dates are chaos. You MUST handle all of these:

```
// RFC 822 (RSS 2.0 spec)
"Sat, 07 Sep 2002 09:42:31 GMT"
"Sat, 07 Sep 2002 09:42:31 +0000"

// RFC 3339 (Atom spec)
"2002-09-07T09:42:31Z"
"2002-09-07T09:42:31+00:00"

// Broken but common
"2002-09-07"                    // No time
"September 7, 2002"             // Human readable
"07 Sep 2002"                   // Missing day name
"Sat Sep 07 09:42:31 UTC 2002"  // Wrong order
"1631007751"                    // Unix timestamp (string)
```

Use a library like `date-fns` or `dayjs` with multiple format attempts. Log but don't crash on unparseable dates.

### GUID Uniqueness

```typescript
// WRONG: Trust <guid> blindly
const id = entry.guid;

// RIGHT: Normalize and dedupe
const guid = entry.guid || entry.link || entry.title + entry.pubDate;
const normalizedGuid = guid.trim().toLowerCase();
```

Some feeds:
- Reuse GUIDs across entries
- Change GUIDs on each publish
- Have no GUID at all

Use `(feedId, normalizedGuid)` as the composite key.

### Content Priority

RSS has multiple content fields. Check in order:

1. `content:encoded` — Full HTML content (RSS 2.0 extension)
2. `content` — Atom content element
3. `description` — Summary/excerpt (often the only content in RSS)
4. `summary` — Atom summary (prefer content over this)

```typescript
const content = 
  entry['content:encoded'] ||
  entry.content?.['#text'] || entry.content ||
  entry.description ||
  entry.summary ||
  '';
```

### Namespace Hell

XML namespaces vary wildly:

```xml
<!-- These are all the same thing -->
<content:encoded>...</content:encoded>
<content xmlns="http://purl.org/rss/1.0/modules/content/">...</content>
<encoded xmlns="http://purl.org/rss/1.0/modules/content/">...</encoded>
```

Use a parser that normalizes namespaces or check multiple variants.

### CDATA Sections

```xml
<description><![CDATA[<p>HTML content here</p>]]></description>
```

Some parsers:
- Strip CDATA markers (good)
- Return raw CDATA string (bad)
- Double-encode entities (worse)

Test your parser with feeds that use CDATA heavily.

---

## Polling Best Practices

### Conditional GET

Always use conditional GET to reduce bandwidth:

```typescript
const headers: HeadersInit = {
  'User-Agent': settings.userAgent,
  'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
};

if (feed.etag) {
  headers['If-None-Match'] = feed.etag;
}
if (feed.lastModified) {
  headers['If-Modified-Since'] = feed.lastModified;
}

const response = await fetch(feed.url, { headers });

if (response.status === 304) {
  // Nothing changed, update nextPollAt and return
  return { changed: false };
}

// Save new caching headers
const newEtag = response.headers.get('ETag');
const newLastModified = response.headers.get('Last-Modified');
```

### Respect Rate Limits

1. **Check response headers**: `Retry-After`, `X-RateLimit-*`
2. **Exponential backoff on errors**: 1min → 2min → 4min → 8min → cap at 1hr
3. **Per-domain rate limiting**: Don't hammer the same server with 50 feeds simultaneously

```typescript
// Track errors per feed
if (response.ok) {
  feed.consecutiveErrors = 0;
  feed.backoffMinutes = null;
} else {
  feed.consecutiveErrors++;
  feed.backoffMinutes = Math.min(60, Math.pow(2, feed.consecutiveErrors));
  feed.nextPollAt = now + feed.backoffMinutes * 60 * 1000;
}
```

### Adaptive Polling Algorithm

```typescript
function calculateNextPoll(feed: Feed, hadNewEntries: boolean): number {
  const baseInterval = feed.pollIntervalMinutes || settings.defaultPollIntervalMinutes;
  
  if (!settings.adaptivePolling) {
    return baseInterval;
  }
  
  if (hadNewEntries) {
    // Content found, poll more frequently (but not below minimum)
    return Math.max(settings.adaptiveMinMinutes, baseInterval * 0.75);
  } else {
    // No content, back off gradually (but not above maximum)
    feed.consecutive304s = (feed.consecutive304s || 0) + 1;
    const backoff = 1 + (feed.consecutive304s * 0.25);
    return Math.min(settings.adaptiveMaxMinutes, baseInterval * backoff);
  }
}
```

---

## Feed Validation

### Before Adding a Feed

1. **Fetch and parse** — Does it return valid XML?
2. **Check structure** — Does it have `<channel>` (RSS) or `<feed>` (Atom)?
3. **Has entries** — Does it have at least one item/entry?
4. **Reasonable size** — Is it under 10MB?

```typescript
async function validateFeed(url: string): Promise<ValidationResult> {
  try {
    const response = await fetch(url, { 
      timeout: 10000,
      headers: { 'Accept': 'application/rss+xml, application/atom+xml, */*' }
    });
    
    if (!response.ok) {
      return { valid: false, error: `HTTP ${response.status}` };
    }
    
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
      return { valid: false, error: 'Feed too large (>10MB)' };
    }
    
    const xml = await response.text();
    const parsed = parseXml(xml);
    
    if (!parsed.rss && !parsed.feed) {
      return { valid: false, error: 'Not a valid RSS or Atom feed' };
    }
    
    const entries = getEntries(parsed);
    return { 
      valid: true, 
      title: getTitle(parsed),
      entryCount: entries.length,
      format: parsed.rss ? 'rss' : 'atom'
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}
```

### Periodic Health Checks

Track feed health over time:
- `lastSuccessAt` — Last successful poll
- `lastErrorAt` — Last error
- `consecutiveErrors` — Error streak
- `totalErrors` — Lifetime error count

Mark feeds as `stale` after N consecutive failures. Alert user, don't auto-delete.

---

## What NOT To Do

### Don't Trust Feed Metadata

```typescript
// WRONG: Use feed's self-reported URL
const feedUrl = parsed.channel.link;

// RIGHT: Use the URL we actually fetched
const feedUrl = originalRequestUrl;
```

Feeds lie about:
- Their own URL (redirects, CDNs)
- Update frequency (`<ttl>` is often wrong)
- Content length

### Don't Parse HTML as Content

```typescript
// WRONG: Strip all HTML
const text = content.replace(/<[^>]*>/g, '');

// RIGHT: Parse HTML properly, preserve structure for display
import { JSDOM } from 'jsdom';
const dom = new JSDOM(content);
const text = dom.window.document.body.textContent;
```

HTML stripping with regex breaks on:
- Malformed HTML
- CDATA sections
- Script/style content
- Entity encoding

### Don't Poll More Than Needed

```typescript
// WRONG: Poll every feed every 5 minutes
for (const feed of allFeeds) {
  await pollFeed(feed);
}

// RIGHT: Only poll feeds whose nextPollAt has passed
const dueFeeds = await db.query(
  'SELECT * FROM feeds WHERE nextPollAt <= NOW() AND enabled = true'
);
```

### Don't Ignore Redirects

```typescript
// WRONG: Save original URL forever
feed.url = userProvidedUrl;

// RIGHT: Follow redirects and update stored URL
const response = await fetch(url, { redirect: 'follow' });
if (response.redirected) {
  feed.url = response.url; // Save the final URL
  log(`Feed ${feed.id} redirected to ${response.url}`);
}
```

Many feeds redirect (HTTP→HTTPS, domain changes, CDN routing).

### Don't Store Everything Forever

```typescript
// Set retention policy
const retentionDays = feed.retentionDays || settings.defaultRetentionDays || 90;

// Cleanup job
await db.query(
  'DELETE FROM entries WHERE feedId = $1 AND createdAt < NOW() - INTERVAL $2 DAY',
  [feed.id, retentionDays]
);
```

### Don't Block on Embedding Failures

```typescript
// WRONG
const embedding = await getEmbedding(entry.content);
await db.insert('entries', { ...entry, embedding });

// RIGHT
await db.insert('entries', entry);
try {
  const embedding = await getEmbedding(entry.content);
  await db.update('entry_embeddings', { entryId: entry.id, embedding });
} catch (e) {
  log(`Embedding failed for entry ${entry.id}: ${e.message}`, 'warn');
  // Continue - embeddings are nice-to-have
}
```

---

## Context Summarization

### Strategy

1. **Fetch recent entries** (last 7 days or last 20 entries, whichever is more)
2. **Build prompt** with titles and excerpts
3. **Generate summary** describing the feed's current focus
4. **Store as context** with relevance metadata

### Prompt Template

```
You are summarizing an RSS feed's recent content for a feed reader.

Feed: ${feed.title}
Description: ${feed.description || 'No description'}

Recent entries:
${entries.map(e => `- ${e.title} (${e.pubDate})`).join('\n')}

Write a 2-3 sentence summary of what this feed is currently covering.
Focus on themes and topics, not individual articles.
```

### Update Frequency

- **High-volume feeds** (10+ entries/day): Summarize every 30 minutes
- **Normal feeds** (1-10 entries/day): Summarize every few hours
- **Low-volume feeds** (<1 entry/day): Summarize on new entry only

---

## Recommended Libraries

- **XML Parsing**: `fast-xml-parser` (fast, handles namespaces)
- **Feed Parsing**: `rss-parser` (good abstraction, but validate edge cases)
- **Date Parsing**: `dayjs` with plugins or `date-fns`
- **Content Extraction**: `@mozilla/readability` + `jsdom`
- **HTML Sanitization**: `DOMPurify` or `sanitize-html`

---

## Testing Checklist

- [ ] UTF-8, ISO-8859-1, Windows-1252 encoded feeds
- [ ] RSS 0.91, 0.92, 1.0 (RDF), 2.0
- [ ] Atom 1.0
- [ ] Feeds with CDATA sections
- [ ] Feeds with namespaced content (`content:encoded`, `dc:creator`)
- [ ] Feeds with no GUIDs
- [ ] Feeds with relative URLs (must resolve against feed URL)
- [ ] Feeds that redirect
- [ ] Feeds that 304 (conditional GET)
- [ ] Feeds that are too large
- [ ] Feeds with enclosures (podcasts)
- [ ] OPML import with nested folders
- [ ] OPML export roundtrip

---

## Lessons Learned

*(Update this section as you discover new edge cases)*

### Initial Implementation Notes

- RSS "2.0" can mean anything — always check actual structure
- Some servers return `text/html` content-type for XML feeds (check magic bytes)
- Cloudflare can block bot user agents — may need to rotate or customize
- Many feeds have entries with future pubDates (scheduled posts) — decide policy
