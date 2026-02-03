# Mastodon Module Implementation Plan

## Overview

Implement the Mastodon module for FeedEater following the established Slack module patterns. The module will collect toots from a user's Mastodon home timeline and organize them into the Context system.

## Files to Create

### 1. `package.json`
- Name: `@feedeater/module-mastodon`
- Dependencies: `@feedeater/core`, `@feedeater/module-sdk`, `nats`, `pg`, `uuid`, `zod`
- No external Mastodon client library — using raw fetch for simplicity and control
- Build with tsup like Slack module

### 2. `tsconfig.json`
- Extends `../../tsconfig.base.json`
- Output to `dist/`
- Include `src/**/*.ts` and `settings.ts`

### 3. `settings.ts`
- Zod schema for Mastodon settings
- Settings:
  - `enabled`: boolean (default: true)
  - `instanceUrl`: string (required) — base URL like `https://mastodon.social`
  - `accessToken`: secret (required) — OAuth access token
  - `timelineType`: enum `home|local|public` (default: home)
  - `lookbackHours`: number (default: 24)
  - `includeBoosts`: boolean (default: true)
  - `includeReplies`: boolean (default: true)
  - `excludeSensitive`: boolean (default: false)
  - `contextPrompt`: string (default: AI summary prompt)
  - `contextPromptFallback`: string (default: fallback prompt)

### 4. `module.json`
- Namespace: `feedeater.mastodon`
- Queues: `["mod_mastodon"]`
- Jobs:
  - `collect`: every 5 minutes — fetch toots, store, emit events
  - `updateContexts`: every 30 minutes — refresh AI summaries
- Settings matching Zod schema
- Cards: `mastodonStatus` and `mastodonTimeline`

### 5. `src/ingest.ts`
Core `MastodonIngestor` class:

#### Key Design Decisions
- Use `uri` field for global deduplication (not `id` which is instance-local)
- Parse Link header for pagination
- Handle boosts by storing the original status with boosted_by annotation
- Use `conversation_id` for context grouping (acknowledging it's instance-local)

#### Methods
- `constructor(settings, db, nats, sc, opts)` — initialize with config
- `ensureSchema()` — create `mod_mastodon` schema and tables
- `collectAndPersist()` — main collection loop
- `refreshContexts()` — update AI summaries
- `fetchTimeline()` — GET home/local/public timeline with pagination
- `aiGenerate()` — call AI summary endpoint
- `aiEmbed()` — call AI embedding endpoint
- `publishContextUpdate()` — emit ContextUpdated events
- `log()` — structured logging to NATS

#### Database Tables
- `mod_mastodon.mastodon_statuses` — raw status storage
  - `id` (text PK) — format: `mastodon-{instance}-{uri_hash}`
  - `uri` (text) — globally unique ActivityPub URI
  - `status_id` (text) — instance-local ID
  - `instance_host` (text) — extracted from instance URL
  - `created_at` (timestamptz)
  - `author_id`, `author_handle`, `author_display_name`
  - `content` (text) — HTML content
  - `visibility` (text)
  - `sensitive` (boolean)
  - `spoiler_text` (text)
  - `in_reply_to_id`, `in_reply_to_uri`
  - `conversation_id` (text)
  - `reblog_uri` (text) — if this is a boost, URI of original
  - `boosted_by_handle` (text) — who boosted it
  - `favorites_count`, `reblogs_count`, `replies_count`
  - `payload` (jsonb) — full raw response
  - `collected_at` (timestamptz)

- `mod_mastodon.mastodon_status_embeddings` — vector embeddings
  - `id` (text PK)
  - `context_key` (text)
  - `ts` (timestamptz)
  - `embedding` (vector)

#### Context Key Format
`{instance_host}:{conversation_id}` e.g., `mastodon.social:123456789`

For non-conversation toots: `{instance_host}:standalone:{uri_hash}`

### 6. `src/runtime.ts`
- `createModuleRuntime()` returning ModuleRuntime
- Handlers for `mod_mastodon` queue:
  - `collect`: instantiate ingestor, call collectAndPersist
  - `updateContexts`: instantiate ingestor, call refreshContexts
- Parse system settings for `contextTopK` and `embedDim`

### 7. `src/index.ts`
- Export `MastodonIngestor`, `parseMastodonSettingsFromInternal`, `MastodonSettings` type
- Export `createModuleRuntime`

## Implementation Order

1. Create `package.json` and `tsconfig.json`
2. Create `settings.ts` with Zod schema
3. Create `module.json` manifest
4. Create `src/ingest.ts` with full MastodonIngestor class
5. Create `src/runtime.ts` with job handlers
6. Create `src/index.ts` with exports
7. Build and verify TypeScript compiles
8. Commit and push

## API Patterns

### Fetching Timeline
```typescript
const url = new URL(`/api/v1/timelines/${timelineType}`, instanceUrl);
url.searchParams.set('limit', '40');
if (sinceId) url.searchParams.set('since_id', sinceId);

const res = await fetch(url.toString(), {
  headers: { 'Authorization': `Bearer ${accessToken}` }
});

// Check rate limits
const remaining = parseInt(res.headers.get('X-RateLimit-Remaining') || '300');
if (remaining < 10) {
  const resetAt = res.headers.get('X-RateLimit-Reset');
  // Wait until reset
}

// Parse Link header for next page
const linkHeader = res.headers.get('Link');
// Extract max_id from rel="next" link
```

### Rate Limit Handling
- Check `X-RateLimit-Remaining` before each request
- If remaining < 10, wait until `X-RateLimit-Reset`
- On 429 response: exponential backoff with jitter

### Boost Handling
When `status.reblog` is not null:
- The status is a boost
- `status.reblog` contains the original status
- Store the original with `boosted_by_handle` annotation
- Skip storing the boost wrapper itself

## Testing Strategy

1. TypeScript compilation (`pnpm run typecheck`)
2. Build verification (`pnpm run build`)
3. Manual trigger of collect job in FeedEater UI (future)

## Notes

- No external Mastodon library to minimize dependencies
- Raw fetch gives full control over rate limiting and pagination
- URI-based dedup handles cross-instance content correctly
- Conversation ID grouping may produce instance-local groups (acceptable tradeoff)
