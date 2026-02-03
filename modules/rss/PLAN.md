# RSS Module Implementation Plan

Following Boris Cherny method: PLAN → EXECUTE → VERIFY → DOCUMENT

## Overview

Implement RSS module following Slack module patterns. Key differences:
- No auth (universal format)
- External XML parsing (fast-xml-parser)
- Conditional GET for bandwidth optimization
- OPML import support
- Adaptive polling

## File Structure

```
modules/rss/
├── CLAUDE.md (exists)
├── README.md (exists)
├── PLAN.md (this file)
├── module.json
├── package.json
├── tsconfig.json
├── settings.ts
└── src/
    ├── index.ts
    ├── ingest.ts
    └── runtime.ts
```

## Implementation Steps

### Step 1: Configuration Files

**package.json**
- Dependencies: fast-xml-parser, @feedeater/core, @feedeater/module-sdk, uuid, zod, nats, pg
- Same scripts pattern as Slack

**tsconfig.json**
- Extend base config
- outDir: dist

**module.json**
- Three jobs: poll, cleanup, updateContexts
- Settings for polling, conditional GET, adaptive polling
- Single queue: mod_rss

**settings.ts**
- Zod schemas matching module.json settings

### Step 2: Core Implementation (src/ingest.ts)

**RSSIngestor class**

Constructor params:
- settings: RSSSettings
- db: Pool
- nats: NatsConnection
- sc: StringCodec
- opts: { apiBaseUrl, internalToken, contextTopK, embedDim }

Key methods:
1. `ensureSchema()` - Create mod_rss schema and tables
2. `pollFeeds()` - Main polling logic
3. `fetchFeed(feed)` - Fetch single feed with conditional GET
4. `parseFeed(xml, url)` - Parse RSS/Atom with fast-xml-parser
5. `normalizeEntry(entry, feed)` - Normalize to FeedEater message format
6. `refreshContexts()` - Generate AI summaries for feed contexts

**Database Schema (mod_rss)**
```sql
-- Feed subscriptions
feeds (
  id UUID PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  site_url TEXT,
  description TEXT,
  poll_interval_minutes INT,
  enabled BOOLEAN DEFAULT true,
  tags JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
)

-- Cached entries
entries (
  id UUID PRIMARY KEY,
  feed_id UUID REFERENCES feeds(id),
  guid TEXT NOT NULL,
  url TEXT,
  title TEXT,
  content TEXT,
  author TEXT,
  published_at TIMESTAMPTZ,
  collected_at TIMESTAMPTZ DEFAULT now(),
  payload JSONB,
  UNIQUE(feed_id, guid)
)

-- Poll state for conditional GET
poll_state (
  feed_id UUID PRIMARY KEY REFERENCES feeds(id),
  etag TEXT,
  last_modified TEXT,
  next_poll_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  consecutive_errors INT DEFAULT 0,
  consecutive_304s INT DEFAULT 0
)

-- Embeddings for semantic search
entry_embeddings (
  id UUID PRIMARY KEY,
  feed_id UUID,
  context_key TEXT,
  ts TIMESTAMPTZ,
  embedding VECTOR
)
```

### Step 3: Runtime (src/runtime.ts)

**createModuleRuntime()** returns:
- moduleName: "rss"
- handlers.mod_rss.poll - Poll all due feeds
- handlers.mod_rss.cleanup - Remove old entries
- handlers.mod_rss.updateContexts - Refresh AI summaries

### Step 4: Exports (src/index.ts)

Export:
- RSSIngestor
- parseRSSSettingsFromInternal
- RSSSettings type
- createModuleRuntime

## Key Edge Cases to Handle

### XML Parsing (fast-xml-parser config)
```typescript
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '__cdata',
  parseTagValue: true,
  trimValues: true,
  // Handle namespaces
  removeNSPrefix: false,
});
```

### Date Parsing
Try multiple formats:
1. RFC 822 (RSS 2.0)
2. RFC 3339/ISO 8601 (Atom)
3. Fallback patterns

### Content Priority
1. content:encoded
2. content (Atom)
3. description
4. summary

### GUID Generation
```typescript
const guid = entry.guid || entry.id || entry.link || 
             `${feedId}:${entry.title}:${entry.pubDate}`;
```

## Testing Checklist

- [ ] TypeScript compiles without errors
- [ ] Exports are correct
- [ ] Module.json validates
- [ ] Settings schema matches module.json

## Commit Plan

1. Add configuration files (package.json, tsconfig.json, module.json, settings.ts)
2. Implement ingest.ts (RSSIngestor class)
3. Implement runtime.ts (job handlers)
4. Add index.ts exports
5. Test TypeScript compilation
6. Update CLAUDE.md with lessons learned

## Estimated Complexity

- Total lines: ~800-1000
- Similar complexity to Slack module
- Main challenges: XML parsing edge cases, date normalization
