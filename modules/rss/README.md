# RSS/Atom Module

**Priority: P1** — Foundational module. No authentication required. High user demand.

The RSS module collects content from RSS 2.0, Atom 1.0, and legacy RSS formats. It normalizes feed entries into FeedEater's unified message bus and tracks feed/channel contexts.

## Why P1?

- **Zero auth complexity** — Public feeds just work
- **Universal format** — Blogs, news, podcasts, YouTube channels all have feeds
- **High demand** — RSS is what most users think of when they hear "feed aggregator"
- **Foundation for other modules** — Many platforms offer RSS as an alternative to their API

## Quick Start

1. **Add feeds** via the FeedEater UI or OPML import
2. **Configure polling** intervals per-feed or globally
3. **Enable content extraction** if you want full articles (not just excerpts)

No API keys. No OAuth. Just URLs.

---

## Feed Management

### Adding Feeds

Feeds can be added:
- **Manually** — Paste RSS/Atom URL directly
- **Discovery** — Paste any website URL; module attempts to find feed links
- **OPML import** — Bulk import from other readers

### Feed Discovery

When given a non-feed URL, the module:
1. Fetches the HTML
2. Looks for `<link rel="alternate" type="application/rss+xml">` or `application/atom+xml`
3. Checks common paths: `/feed`, `/rss`, `/atom.xml`, `/feed.xml`, `/rss.xml`
4. Returns discovered feed URLs for user confirmation

### Supported Formats

| Format | Content-Type | Notes |
|--------|--------------|-------|
| RSS 2.0 | `application/rss+xml` | Most common |
| Atom 1.0 | `application/atom+xml` | Modern, well-specified |
| RSS 1.0 | `application/rdf+xml` | RDF-based, rare |
| RSS 0.91/0.92 | `text/xml` | Legacy, still works |

---

## OPML Import/Export

### Import

Upload an OPML file to bulk-add subscriptions. The module:
- Parses all `<outline>` elements with `xmlUrl` attributes
- Preserves folder structure as tags (optional)
- Validates each feed URL before adding
- Reports import results (success/fail per feed)

### Export

Export all subscriptions as OPML for backup or migration. Includes:
- Feed URL, title, and site URL
- Folder organization (from tags)
- Custom categories

### OPML Format Reference

```xml
<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>My Feeds</title>
  </head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Hacker News" 
               xmlUrl="https://news.ycombinator.com/rss" 
               htmlUrl="https://news.ycombinator.com"/>
    </outline>
  </body>
</opml>
```

---

## Polling Configuration

### Global Defaults

| Setting | Default | Description |
|---------|---------|-------------|
| `defaultPollIntervalMinutes` | `30` | How often to check feeds |
| `minPollIntervalMinutes` | `5` | Minimum allowed interval |
| `maxConcurrentPolls` | `10` | Parallel feed fetches |
| `requestTimeoutSeconds` | `30` | Per-feed timeout |

### Per-Feed Overrides

Each feed can override the global poll interval:
- **Fast feeds** (news): 5-15 minutes
- **Slow feeds** (blogs): 1-6 hours
- **Very slow** (annual reports): 24+ hours

### Conditional GET (Bandwidth Optimization)

The module uses HTTP caching headers to minimize bandwidth:

1. **ETag** — Server sends `ETag` header; we send `If-None-Match` on next request
2. **Last-Modified** — Server sends `Last-Modified`; we send `If-Modified-Since`
3. **304 Not Modified** — Server returns empty body if nothing changed

This dramatically reduces bandwidth for feeds that update infrequently.

### Adaptive Polling (Optional)

When `adaptivePolling` is enabled:
- Feeds that rarely update get polled less frequently
- Feeds that update often get polled more frequently
- Backoff increases after repeated 304s
- Interval resets when new content appears

---

## Content Extraction

Many feeds provide only excerpts. The module can fetch full article content.

### Extraction Modes

| Mode | Description |
|------|-------------|
| `none` | Use feed content as-is |
| `readability` | Apply Mozilla Readability to extract article |
| `custom` | Use CSS selectors defined per-feed |

### When to Use Extraction

- **News sites** — Often truncate to drive clicks
- **Paywalled sites** — May not work (respects robots.txt)
- **Full-text feeds** — Don't bother, wastes bandwidth

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `contentExtraction` | `none` | Global default mode |
| `extractionUserAgent` | `FeedEater/1.0` | User-Agent for extraction requests |
| `respectRobotsTxt` | `true` | Skip extraction if disallowed |

---

## Media Enclosures

RSS supports media attachments via `<enclosure>` elements. Common uses:
- **Podcasts** — Audio files (MP3, M4A)
- **Video** — YouTube, Vimeo embeds
- **Images** — Photo blogs, comics

### Enclosure Handling

| Setting | Default | Description |
|---------|---------|-------------|
| `downloadEnclosures` | `false` | Download media locally |
| `enclosureMaxSizeMb` | `100` | Skip files larger than this |
| `allowedEnclosureTypes` | `audio/*,video/*,image/*` | MIME type whitelist |

When `downloadEnclosures` is enabled:
- Media is stored in module's private storage
- Original URL is preserved in metadata
- Useful for archiving or offline access

---

## Context Generation

### Feed as Context

Each feed becomes a **Context** in FeedEater:
- Context key: `feed:{feedId}`
- Summary: AI-generated description of the feed's recent content
- Updated when new entries arrive

### Entry Linking

Each feed entry:
- Becomes a **Message** on the bus
- Links to its feed's Context via `contextRef`
- Can spawn sub-contexts for discussion threads (if supported by feed)

---

## Settings Reference

### Core Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Module enabled |
| `defaultPollIntervalMinutes` | number | `30` | Default polling interval |
| `minPollIntervalMinutes` | number | `5` | Minimum allowed interval |
| `maxConcurrentPolls` | number | `10` | Parallel fetches |
| `requestTimeoutSeconds` | number | `30` | Per-request timeout |
| `userAgent` | string | `FeedEater/1.0 (+https://feedeater.app)` | HTTP User-Agent |

### Conditional GET

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `useConditionalGet` | boolean | `true` | Use ETag/If-Modified-Since |
| `adaptivePolling` | boolean | `false` | Adjust intervals based on update frequency |
| `adaptiveMinMinutes` | number | `5` | Minimum adaptive interval |
| `adaptiveMaxMinutes` | number | `1440` | Maximum adaptive interval (24h) |

### Content Extraction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `contentExtraction` | enum | `none` | `none`, `readability`, `custom` |
| `extractionUserAgent` | string | `FeedEater/1.0` | User-Agent for extraction |
| `respectRobotsTxt` | boolean | `true` | Honor robots.txt |
| `extractionTimeoutSeconds` | number | `15` | Timeout for extraction requests |

### Media

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `downloadEnclosures` | boolean | `false` | Download media attachments |
| `enclosureMaxSizeMb` | number | `100` | Maximum file size |
| `allowedEnclosureTypes` | string | `audio/*,video/*,image/*` | Allowed MIME types |

### Import/Export

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `preserveOpmlFolders` | boolean | `true` | Import folder structure as tags |
| `validateOnImport` | boolean | `true` | Validate feeds during OPML import |

---

## Jobs

| Job | Schedule | Description |
|-----|----------|-------------|
| `poll` | `*/5 * * * *` | Check feeds due for polling |
| `cleanup` | `0 4 * * *` | Remove old entries per retention settings |
| `updateContexts` | `*/30 * * * *` | Regenerate feed context summaries |

---

## Database Schema

Private schema: `mod_rss`

### Tables

- `feeds` — Feed subscriptions and metadata
- `entries` — Cached feed entries
- `poll_state` — ETag, Last-Modified, next poll time per feed
- `entry_embeddings` — Vector embeddings for semantic search

---

## Troubleshooting

### Feed won't parse

1. Check if URL returns valid XML
2. Try the feed in another reader
3. Check charset declaration
4. Look for malformed CDATA sections

### Always getting full content (no 304s)

- Server may not support conditional GET
- Some CDNs strip caching headers
- Dynamic feeds regenerate on each request

### Entries missing content

- Feed may be excerpt-only (enable content extraction)
- Check `<content:encoded>` vs `<description>` handling
- Some feeds use different namespaces

### High bandwidth usage

1. Enable conditional GET
2. Increase poll intervals
3. Enable adaptive polling
4. Disable content extraction for full-text feeds
