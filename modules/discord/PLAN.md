# Discord Module Implementation Plan

## Overview
Implement Discord message collection module following the established Slack module patterns. Uses Bot Token authentication with REST API polling (no Gateway/WebSocket).

## Key Differences from Slack

| Aspect | Slack | Discord |
|--------|-------|---------|
| Auth | Bot Token (xoxb-*) | Bot Token |
| IDs | String timestamps (ts) | Snowflake strings (64-bit) |
| Message fetch | `conversations.history` | `GET /channels/{id}/messages` |
| Threads | Via `thread_ts` | Separate thread channels (types 10-12) |
| Rate limits | Token bucket headers | Complex per-route + per-resource buckets |
| User resolution | `users.info` API | Included in message payload |
| Time format | Epoch float (ts) | ISO8601 strings |

## Files to Create

### 1. `src/ingest.ts` - DiscordIngestor class
Core collection logic:
- `DiscordSettings` type + `parseDiscordSettingsFromInternal()` parser
- `DiscordIngestor` class with:
  - Constructor: settings, db pool, nats, stringcodec, api opts
  - `log()` - publish to `feedeater.discord.log`
  - `ensureSchema()` - create `mod_discord` schema/tables
  - `fetchWithRateLimit()` - handle Discord rate limit headers
  - `fetchGuildChannels()` - list accessible text channels
  - `fetchChannelMessages()` - paginate with `after` param
  - `fetchActiveThreads()` - get active threads in guild
  - `collectAndPersist()` - main collect job logic
  - `refreshContexts()` - AI summary generation
  - `aiGenerate()` / `aiEmbed()` - call internal AI endpoints

### 2. `src/runtime.ts` - Job handlers
```typescript
export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "discord",
    handlers: {
      mod_discord: {
        collect: async ({ ctx }) => { ... },
        updateContexts: async ({ ctx }) => { ... },
      },
    },
  };
}
```

### 3. `src/index.ts` - Exports
```typescript
export { DiscordIngestor, parseDiscordSettingsFromInternal } from "./ingest.js";
export type { DiscordSettings } from "./ingest.js";
export { createModuleRuntime } from "./runtime.js";
```

### 4. `settings.ts` - Zod schemas
```typescript
export const DiscordSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  botToken: z.string().min(1),
  guildIds: z.string().min(1).transform(...), // comma-separated
  channelIds: z.string().optional().transform(...), // optional filter
  lookbackHours: z.number().positive().default(24),
  includeThreads: z.boolean().default(true),
  excludeBots: z.boolean().default(true),
  channelNameMap: z.string().default("{}"),
  contextPrompt: z.string().default(...),
  contextPromptFallback: z.string().default(...),
});
```

### 5. `module.json` - Module manifest
```json
{
  "name": "discord",
  "version": "0.0.1",
  "namespace": "feedeater.discord",
  "runtime": { "entry": "dist/runtime.js" },
  "queues": ["mod_discord"],
  "jobs": [
    { "name": "collect", "queue": "mod_discord", "schedule": "*/5 * * * *" },
    { "name": "updateContexts", "queue": "mod_discord", "schedule": "*/30 * * * *" }
  ],
  "settings": [...],
  "cards": [...]
}
```

### 6. `package.json` - Dependencies
- `@feedeater/core` and `@feedeater/module-sdk`
- `pg`, `nats`, `uuid`, `zod`
- NO discord.js (use raw fetch for lighter weight + rate limit control)

### 7. `tsconfig.json` - Extends base config

### 8. `src/shims.d.ts` - Type shims for dev

## Database Schema (mod_discord)

```sql
-- Messages table
CREATE TABLE mod_discord.discord_messages (
  id TEXT PRIMARY KEY,              -- "discord-{channelId}-{messageId}"
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,         -- Snowflake
  ts TIMESTAMPTZ NOT NULL,
  author_id TEXT,
  author_name TEXT,
  text TEXT,
  thread_id TEXT,                   -- Parent thread/channel if threaded
  is_thread_message BOOLEAN DEFAULT FALSE,
  reference_message_id TEXT,        -- Reply reference
  payload JSONB NOT NULL,
  collected_at TIMESTAMPTZ DEFAULT NOW()
);

-- Embeddings table
CREATE TABLE mod_discord.discord_message_embeddings (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  context_key TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  embedding vector(${embedDim})
);
```

## Discord API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /guilds/{id}/channels` | List guild channels |
| `GET /channels/{id}/messages` | Fetch channel history |
| `GET /guilds/{id}/threads/active` | List active threads |
| `GET /channels/{id}/threads/archived/public` | Archived public threads |

## Rate Limit Strategy

1. Parse headers on every response:
   - `X-RateLimit-Remaining`
   - `X-RateLimit-Reset-After`
   - `X-RateLimit-Bucket`

2. On 429 response:
   - Parse `retry_after` from body
   - Check `global` flag
   - Wait + retry with jitter

3. Pre-emptive slowing:
   - If `Remaining < 2`, delay next request by `Reset-After`

## Context Key Format

`{guildId}:{channelId}` for channel messages
`{guildId}:{channelId}:{threadId}` for thread messages

## Implementation Order

1. ✅ Create PLAN.md (this file)
2. Create package.json, tsconfig.json
3. Create settings.ts with Zod schema
4. Create src/shims.d.ts
5. Create src/ingest.ts (core logic)
6. Create src/runtime.ts (job handlers)
7. Create src/index.ts (exports)
8. Create module.json (manifest)
9. Type check with `pnpm typecheck`
10. Commit and push

## Testing Checklist

- [ ] TypeScript compiles without errors
- [ ] Settings parsing handles all edge cases
- [ ] Rate limit headers are properly parsed
- [ ] 429 responses are handled correctly
- [ ] Snowflake IDs preserved as strings
- [ ] Context keys follow expected format
- [ ] NATS events match expected schemas
