# Bluesky Module Implementation Plan

Following the Boris Cherny Method: PLAN → EXECUTE → VERIFY → DOCUMENT

## Overview

Implement a Bluesky collector module for FeedEater that:
1. Authenticates via App Password (not OAuth)
2. Collects posts from the user's home timeline
3. Stores posts using DIDs as primary keys
4. Emits normalized messages to the bus
5. Generates AI summaries for thread contexts

## Architecture

```
┌─────────────────┐
│  Bluesky API    │
│  (bsky.social)  │
└────────┬────────┘
         │ getTimeline()
         ▼
┌─────────────────┐
│ BlueskyIngestor │
│   - login()     │
│   - collect()   │
│   - contexts()  │
└────────┬────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
┌──────┐┌────┐┌────────┐
│ mod_ ││NATS││Internal│
│bsky  ││Bus ││AI API  │
└──────┘└────┘└────────┘
```

## File Structure

```
modules/bluesky/
├── CLAUDE.md           (existing)
├── README.md           (existing)
├── PLAN.md             (this file)
├── module.json         (manifest)
├── package.json        (dependencies)
├── tsconfig.json       (TypeScript config)
├── settings.ts         (Zod schemas)
└── src/
    ├── index.ts        (exports)
    ├── ingest.ts       (BlueskyIngestor class)
    └── runtime.ts      (job handlers)
```

## Implementation Steps

### Step 1: Create package.json
- Name: `@feedeater/module-bluesky`
- Dependencies: `@atproto/api`, `@feedeater/core`, `@feedeater/module-sdk`, `uuid`, `pg`, `nats`, `zod`
- Build script: tsup

### Step 2: Create tsconfig.json
- Extend `../../tsconfig.base.json`
- Output to `dist/`

### Step 3: Create settings.ts
- `identifier` (string, required) - Bluesky handle or email
- `appPassword` (secret, required) - App password (xxxx-xxxx-xxxx-xxxx format)
- `serviceUrl` (string, default "https://bsky.social") - PDS URL
- `enabled` (boolean, default true)
- `lookbackHours` (number, default 24)
- `collectIntervalMinutes` (number, default 5) - for reference in schedules
- `contextPrompt` (string) - AI summary prompt
- `contextPromptFallback` (string) - Fallback prompt

### Step 4: Create module.json
- name: "bluesky"
- namespace: "feedeater.bluesky"
- Jobs:
  - `collect`: Poll timeline, store posts (every 5 min)
  - `updateContexts`: Refresh AI summaries (every 30 min)
- Settings: As defined in Step 3
- Cards: Status card for dashboard

### Step 5: Create src/ingest.ts (BlueskyIngestor class)

**Constructor:**
- Takes settings, db pool, nats connection, string codec, AI options
- Creates BskyAgent instance

**Methods:**
- `ensureSchema()`: Create mod_bsky schema, bsky_posts table, embeddings table
- `login()`: Authenticate with app password, handle session
- `collectAndPersist()`: Fetch timeline, upsert posts, emit messages
- `refreshContexts()`: Generate AI summaries for threads

**Key Design Decisions:**
- Store DIDs as primary identifiers (handles can change)
- AT URI as unique post identifier
- Context key format: `{rootAuthorDid}:{rootPostRkey}` for threads
- Parse facets for mentions/links (optional enrichment)

**Database Schema:**
```sql
CREATE SCHEMA IF NOT EXISTS mod_bsky;

CREATE TABLE mod_bsky.bsky_posts (
  uri TEXT PRIMARY KEY,           -- at://did:plc:xxx/app.bsky.feed.post/rkey
  cid TEXT NOT NULL,              -- Content hash
  author_did TEXT NOT NULL,       -- did:plc:xxx
  author_handle TEXT,             -- alice.bsky.social (can change)
  created_at TIMESTAMPTZ NOT NULL,
  text TEXT,
  reply_root_uri TEXT,            -- Thread root
  reply_parent_uri TEXT,          -- Direct parent
  embed_type TEXT,                -- images, external, record, etc.
  like_count INT DEFAULT 0,
  repost_count INT DEFAULT 0,
  reply_count INT DEFAULT 0,
  payload JSONB NOT NULL,         -- Full post record
  collected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE mod_bsky.bsky_post_embeddings (
  uri TEXT PRIMARY KEY,
  context_key TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  embedding VECTOR(4096)
);
```

### Step 6: Create src/runtime.ts

**Export `createModuleRuntime()`:**
- `moduleName: "bluesky"`
- Handlers for `mod_bsky` queue:
  - `collect`: Parse settings, create ingestor, run collectAndPersist
  - `updateContexts`: Parse settings, create ingestor, run refreshContexts

### Step 7: Create src/index.ts
- Export BlueskyIngestor, settings parser, createModuleRuntime

## Key Implementation Notes

### Authentication
```typescript
const agent = new BskyAgent({ service: settings.serviceUrl });
await agent.login({
  identifier: settings.identifier,
  password: settings.appPassword
});
// agent handles token refresh automatically
```

### Timeline Fetching
```typescript
const { data } = await agent.getTimeline({ limit: 100, cursor });
// Paginate using cursor until we reach lookback time
```

### Context Key Logic
```typescript
// For a post:
const post = item.post;
const reply = post.record.reply;
const rootUri = reply?.root?.uri ?? post.uri; // If not a reply, it's its own root
const contextKey = `${parseAtUri(rootUri).did}:${parseAtUri(rootUri).rkey}`;
```

### Message Normalization
```typescript
const normalized = {
  id: uuidv5(post.uri, UUID_NAMESPACE),
  createdAt: post.record.createdAt,
  source: { module: "bluesky", stream: "timeline" },
  Message: post.record.text,
  contextRef: { ownerModule: "bluesky", sourceKey: contextKey },
  followMePanel: {
    module: "bluesky",
    panelId: "post",
    href: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
    label: "Open on Bluesky"
  },
  From: post.author.displayName ?? post.author.handle,
  tags: {
    source: "bluesky",
    authorDid: post.author.did,
    authorHandle: post.author.handle,
    isReply: Boolean(reply),
    isRepost: isRepost
  }
};
```

## Verification Steps

1. TypeScript compiles without errors (`npm run typecheck`)
2. Module loads in FeedEater worker
3. Settings appear in UI
4. `collect` job runs successfully
5. Posts appear in unified feed
6. `updateContexts` generates summaries

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Token expiry | BskyAgent handles refresh; we just call methods |
| Handle changes | Store DID as primary key, handle as display only |
| Rate limits | 3000 req/5min is very generous; no special handling needed |
| Deleted posts | Use upsert; missing posts just won't appear |

## Timeline

1. Package setup (package.json, tsconfig.json, settings.ts, module.json)
2. Database schema and basic ingestor structure
3. Timeline collection logic
4. Context/summary generation
5. Testing and documentation

Let's go!
