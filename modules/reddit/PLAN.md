# Reddit Module Implementation Plan

**Date:** 2025-02-03
**Status:** In Progress

## Overview

Implement the Reddit module for FeedEater following the Slack module patterns. The module will collect posts from Reddit's `/best` personalized home feed and organize them into FeedEater's Context system.

## Architecture

```
Reddit API (oauth.reddit.com)
          │
          ▼ OAuth 2.0 (password grant via snoowrap)
          │
┌─────────┴──────────────────────────────────────────────────┐
│              collect job (every 10 min)                     │
│  ┌────────────┐   ┌────────────┐   ┌────────────────────┐  │
│  │ Fetch /best│──▶│ Deduplicate│──▶│ Store in mod_reddit│  │
│  │ pagination │   │ by post ID │   │ Emit MessageCreated│  │
│  └────────────┘   └────────────┘   └────────────────────┘  │
└────────────────────────────────────────────────────────────┘
          │
          ▼ MessageCreated event on feedeater.reddit.messageCreated
          │
┌─────────┴──────────────────────────────────────────────────┐
│           updateContexts job (every 30 min)                 │
│  ┌────────────┐   ┌────────────┐   ┌────────────────────┐  │
│  │ Find active│──▶│ Semantic   │──▶│ AI summary         │  │
│  │ threads    │   │ search     │   │ Emit ContextUpdated│  │
│  └────────────┘   └────────────┘   └────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

## Files to Create

### 1. `package.json`
- Dependencies: snoowrap, @feedeater/core, @feedeater/module-sdk, nats, pg, uuid, zod
- Build script using tsup

### 2. `tsconfig.json`
- Extend from ../../tsconfig.base.json
- Output to dist/

### 3. `settings.ts`
- Zod schema for Reddit settings
- Keys: enabled, clientId, clientSecret, username, password, userAgent, feedTypes, lookbackHours, postsPerFeed, minScore, excludeNSFW, rateLimitDelay, contextPrompt, contextPromptFallback

### 4. `module.json`
- Name: reddit
- Namespace: feedeater.reddit
- Queue: mod_reddit
- Jobs: collect (*/10 * * * *), updateContexts (*/30 * * * *)
- Settings definitions matching settings.ts
- Cards: redditStatus, redditFeeds

### 5. `src/ingest.ts` - RedditIngestor class
Core methods:
- `constructor()` - Initialize snoowrap client
- `log()` - Publish to feedeater.reddit.log
- `ensureSchema()` - Create mod_reddit schema and tables
- `fetchBestFeed()` - Get /best with cursor pagination
- `collectAndPersist()` - Main collection loop (dedup, store, emit)
- `refreshContexts()` - Update AI summaries for active threads
- `aiGenerate()` - Call /api/internal/ai/summary
- `aiEmbed()` - Call /api/internal/ai/embedding
- `publishContextUpdate()` - Emit ContextUpdated event

Database tables:
- `mod_reddit.reddit_posts` - Raw post data
- `mod_reddit.reddit_post_embeddings` - Vector embeddings
- `mod_reddit.pagination_state` - Cursor tracking per feed

### 6. `src/runtime.ts`
- `createModuleRuntime()` function
- Handlers for mod_reddit queue:
  - `collect` - Instantiate ingestor, run collectAndPersist()
  - `updateContexts` - Run refreshContexts()

### 7. `src/index.ts`
- Export RedditIngestor, parseRedditSettingsFromInternal, createModuleRuntime

## Key Implementation Details

### Authentication (snoowrap)
```typescript
const reddit = new Snoowrap({
  userAgent: settings.userAgent,
  clientId: settings.clientId,
  clientSecret: settings.clientSecret,
  username: settings.username,
  password: settings.password,
});
reddit.config({
  requestDelay: settings.rateLimitDelay,
  continueAfterRatelimitError: true,
});
```

### Pagination Strategy
- Use `after` token from snoowrap Listing
- Store in `pagination_state` table
- On collect: fetch from stored cursor, update cursor after batch
- Reset cursor if lookback period exceeded

### Context Key Format
- Post context: `{subreddit}:{postId}`
- Example: `programming:abc123`

### Deduplication
- Check existing by `reddit-{subreddit}-{postId}` source ID
- Only emit MessageCreated for new posts
- Upsert post data (score, num_comments can change)

### Handling Edge Cases
- Deleted content: Skip posts where author is [deleted]
- NSFW: Respect excludeNSFW setting (check over_18)
- Empty selftext: Use title as message body
- Score threshold: Respect minScore setting

### NormalizedMessage Mapping
```typescript
{
  id: uuidv5(`reddit-${subreddit}-${postId}`, NAMESPACE),
  createdAt: new Date(created_utc * 1000).toISOString(),
  source: { module: "reddit", stream: subreddit },
  realtime: false,
  Message: selftext || title,
  contextRef: { ownerModule: "reddit", sourceKey: `${subreddit}:${postId}` },
  followMePanel: {
    module: "reddit",
    panelId: "post",
    href: `https://reddit.com${permalink}`,
    label: "Open on Reddit",
  },
  From: author,
  likes: score,
  tags: {
    source: "reddit",
    subreddit,
    author,
    isNSFW: over_18,
    isSelfPost: is_self,
    commentCount: num_comments,
  },
}
```

## Verification Steps

1. TypeScript compiles without errors (`npm run build`)
2. Types are correct (no `any` escapes)
3. Module can be loaded by worker
4. Database schema creates successfully
5. API authentication works
6. Posts are collected and stored
7. MessageCreated events are emitted
8. Context summaries are generated

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| snoowrap has types issues | Use `@types/snoowrap` or declare module shims |
| Rate limit exceeded | Configure requestDelay, use exponential backoff |
| Token refresh failures | snoowrap handles automatically for script apps |
| Large feeds timeout | Limit postsPerFeed, paginate in batches |

## Order of Implementation

1. ✅ Read existing docs and patterns
2. ⬜ Create package.json, tsconfig.json
3. ⬜ Create settings.ts
4. ⬜ Create module.json
5. ⬜ Create src/ingest.ts (core logic)
6. ⬜ Create src/runtime.ts (job handlers)
7. ⬜ Create src/index.ts (exports)
8. ⬜ Verify TypeScript compiles
9. ⬜ Commit and push
10. ⬜ Update CLAUDE.md with lessons learned
