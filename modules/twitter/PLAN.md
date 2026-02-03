# Twitter Module Implementation Plan

Following the Boris Cherny Method: PLAN → EXECUTE → VERIFY → DOCUMENT

## Overview

Implement X/Twitter module for FeedEater using `bird` CLI with browser cookie authentication.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    collect job (every 15 min)                   │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  bird CLI (via child_process.exec)                              │
│  - Reads browser cookies (Chrome/Firefox/Safari)                │
│  - Commands: bird home, bird list-timeline, bird mentions       │
│  - JSON output with --json flag                                 │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  Tweet Parser                                                   │
│  - Normalize bird JSON output                                   │
│  - Extract: id, text, author, conversationId, metrics           │
│  - Handle quoted tweets, retweets                               │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  mod_twitter.tweets (Postgres)                                  │
│  - Store raw + normalized tweet data                            │
│  - Dedupe by tweet_id                                           │
│  - Upsert to handle metric updates                              │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  NATS: feedeater.twitter.messageCreated                         │
│  - Publish normalized message envelopes                         │
│  - Include contextRef for thread grouping                       │
└─────────────────────────────────────────────────────────────────┘
```

## Files to Create

### 1. `src/ingest.ts` — TwitterIngestor class

Key responsibilities:
- Execute bird CLI commands with appropriate flags
- Parse JSON output into normalized Tweet objects
- Store tweets in Postgres (mod_twitter schema)
- Emit MessageCreated events to NATS
- Generate embeddings for semantic search
- Handle rate limit backoff

Key methods:
- `execBird(command, args)` — run bird CLI with error handling
- `collectHome(count)` — fetch home timeline (For You / Following)
- `collectList(listId, count)` — fetch list timeline
- `collectMentions(count)` — fetch mentions (optional)
- `collectAndPersist()` — main job handler
- `refreshContexts()` — update AI summaries
- `ensureSchema()` — create mod_twitter tables

Settings parsed:
- `enabled` — module on/off
- `feedSources` — JSON array of feed configs (home/list/mentions)
- `cookieSource` — chrome-profile / firefox-profile name
- `pollIntervalMinutes` — how often to poll (default 15)
- `tweetsPerRequest` — max tweets per request (default 50)
- `lookbackHours` — for context refresh (default 24)
- `contextPrompt` / `contextPromptFallback` — AI summary prompts

### 2. `src/runtime.ts` — Job handlers

Two jobs following Slack pattern:
- `collect` — calls `collectAndPersist()`
- `updateContexts` — calls `refreshContexts()`

### 3. `src/index.ts` — Exports

Export:
- `TwitterIngestor`
- `parseTwitterSettingsFromInternal()`
- `createModuleRuntime()`

### 4. `settings.ts` — Zod schemas

```typescript
TwitterSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  feedSources: z.string().default('[]'), // JSON array
  cookieSource: z.string().optional(), // e.g. "chrome:Profile 1" or "firefox:default-release"
  tweetsPerRequest: z.number().default(50),
  lookbackHours: z.number().default(24),
  contextPrompt: z.string().default('...'),
  contextPromptFallback: z.string().default('...'),
})
```

### 5. `module.json` — Module manifest

Jobs:
- `collect` — every 15 minutes
- `updateContexts` — every 30 minutes

Settings:
- enabled, feedSources, cookieSource, tweetsPerRequest, lookbackHours
- contextPrompt, contextPromptFallback

Cards:
- twitterStatus — collector status
- twitterFeeds — configured feed sources

### 6. `package.json` — Dependencies

```json
{
  "dependencies": {
    "@feedeater/core": "0.0.1",
    "@feedeater/module-sdk": "0.0.1",
    "nats": "^2.29.3",
    "pg": "^8.16.3",
    "uuid": "^11.1.0",
    "zod": "^3.25.76"
  }
}
```

No external Twitter SDK needed — we shell out to bird CLI.

### 7. `tsconfig.json` — TypeScript config

Extends base config, output to dist/.

## Database Schema

```sql
CREATE SCHEMA IF NOT EXISTS mod_twitter;

CREATE TABLE mod_twitter.tweets (
  id text PRIMARY KEY,              -- tweet id
  conversation_id text,             -- for thread grouping
  author_id text NOT NULL,
  author_username text NOT NULL,
  author_name text,
  text text,
  created_at timestamptz NOT NULL,
  reply_count int,
  retweet_count int,
  like_count int,
  quote_count int,
  view_count int,
  is_retweet boolean DEFAULT false,
  is_quote boolean DEFAULT false,
  quoted_tweet_id text,
  retweeted_tweet_id text,
  feed_source text,                 -- 'home' | 'list:123' | 'mentions'
  payload jsonb NOT NULL,
  collected_at timestamptz DEFAULT now()
);

CREATE TABLE mod_twitter.tweet_embeddings (
  id text PRIMARY KEY,
  context_key text NOT NULL,
  ts timestamptz NOT NULL,
  embedding vector(4096)
);
```

## Context Key Format

Following CLAUDE.md spec:
- Thread: `thread:{conversation_id}`
- Quote chain: `quote:{original_tweet_id}`
- User daily: `user:{user_id}:{YYYY-MM-DD}`

For simplicity, start with thread contexts only.

## Rate Limit Strategy

Per CLAUDE.md guidance:
1. 15-30 min polling intervals (configurable)
2. Max 50 tweets per request (no --all flag!)
3. Sequential feed fetching with 5s delays
4. Exponential backoff on empty responses
5. 15min wait on 429 errors

## Implementation Order

1. ✅ Write PLAN.md (this file)
2. Create basic file structure (package.json, tsconfig.json, module.json)
3. Implement settings.ts with Zod schemas
4. Implement src/ingest.ts (core logic)
5. Implement src/runtime.ts (job handlers)
6. Implement src/index.ts (exports)
7. Verify TypeScript compiles
8. Test locally (if bird CLI works)
9. Commit and push
10. Update CLAUDE.md with lessons learned

## Notes

- bird CLI path: `/opt/homebrew/bin/bird`
- bird outputs JSON array on success
- Safari cookies require special permissions (may fail)
- Chrome/Firefox profiles are more reliable
- Cookie source format: `--chrome-profile "Profile 1"` or `--firefox-profile default-release`
