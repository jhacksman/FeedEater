# Twitch Module Implementation Plan

## Overview
Implement a FeedEater module for Twitch that collects streams, VODs, and clips via the Helix REST API. Following the Slack module patterns and leveraging existing project conventions.

## Architecture Decisions

### Phase 1: REST API Polling (This Implementation)
- **Followed Streams**: Fetch live streams from followed channels
- **VODs**: Fetch past broadcasts, highlights, uploads
- **Clips**: Fetch user-created clips
- No EventSub WebSocket in v1 (add later for real-time)

### Token Management
- Store user access token and refresh token
- Validate token on startup
- Refresh proactively when needed (~4hr expiry)
- Handle 401 errors gracefully

### Rate Limiting
- 800 points/min budget for app tokens
- Check `Ratelimit-Remaining` header
- Back off on 429 with `Ratelimit-Reset`

### Context Keys
- Stream: `stream:{broadcasterId}` — for ongoing stream context
- VOD: `vod:{videoId}` — for individual video context
- Clip: `clip:{clipId}` — for individual clip context

## Files to Create

### 1. `src/ingest.ts` — TwitchIngestor Class
Core ingestor following Slack patterns:

```typescript
- TwitchSettings type
- parseTwitchSettingsFromInternal() — parse raw settings
- TwitchIngestor class:
  - constructor(settings, db, nats, sc, opts)
  - ensureSchema() — create mod_twitch tables
  - validateToken() — check if token is valid
  - refreshAccessToken() — refresh expired token
  - fetchFollowedStreams() — GET /streams/followed
  - fetchVideos() — GET /videos (VODs)
  - fetchClips() — GET /clips
  - collectAndPersist() — main collect job logic
  - refreshContexts() — AI summary generation
  - publishContextUpdate() — emit context events
  - log() — emit to NATS log topic
```

### 2. `src/runtime.ts` — Job Handlers
```typescript
- createModuleRuntime() returns ModuleRuntime
- handlers.mod_twitch.collect — collect streams/vods/clips
- handlers.mod_twitch.updateContexts — refresh AI summaries
```

### 3. `src/index.ts` — Exports
```typescript
export { TwitchIngestor, parseTwitchSettingsFromInternal } from "./ingest.js";
export type { TwitchSettings } from "./ingest.js";
export { createModuleRuntime } from "./runtime.js";
```

### 4. `settings.ts` — Zod Schemas
```typescript
TwitchSettingsSchema with:
- enabled: boolean
- clientId: string (required)
- clientSecret: string (secret, required)
- userAccessToken: string (secret, required)
- refreshToken: string (secret, optional)
- userId: string (required, numeric Twitch user ID)
- collectVods: boolean (default true)
- collectClips: boolean (default true)
- lookbackHours: number (default 168 = 1 week)
- contextPrompt: string
- contextPromptFallback: string
```

### 5. `module.json` — Module Manifest
```json
{
  "name": "twitch",
  "version": "0.0.1",
  "namespace": "feedeater.twitch",
  "runtime": { "entry": "dist/runtime.js" },
  "queues": ["mod_twitch"],
  "jobs": [
    { "name": "collect", "queue": "mod_twitch", "schedule": "*/5 * * * *" },
    { "name": "updateContexts", "queue": "mod_twitch", "schedule": "*/30 * * * *" }
  ],
  "settings": [...],
  "cards": [...]
}
```

### 6. `package.json` — Dependencies
```json
{
  "name": "@feedeater/module-twitch",
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

### 7. `tsconfig.json` — TypeScript Config
Extend base config, output to dist/

## Database Schema

```sql
CREATE SCHEMA IF NOT EXISTS mod_twitch;

-- Live stream snapshots
CREATE TABLE mod_twitch.twitch_streams (
  id TEXT PRIMARY KEY, -- composite: twitch-stream-{userId}-{startedAt}
  user_id TEXT NOT NULL,
  user_login TEXT NOT NULL,
  user_name TEXT NOT NULL,
  game_id TEXT,
  game_name TEXT,
  title TEXT,
  viewer_count INTEGER,
  started_at TIMESTAMPTZ NOT NULL,
  thumbnail_url TEXT,
  is_live BOOLEAN NOT NULL DEFAULT true,
  payload JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- VODs (past broadcasts, highlights, uploads)
CREATE TABLE mod_twitch.twitch_videos (
  id TEXT PRIMARY KEY, -- video ID from Twitch
  user_id TEXT NOT NULL,
  user_login TEXT NOT NULL,
  user_name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  duration TEXT, -- "1h2m3s" format
  view_count INTEGER,
  video_type TEXT, -- archive, highlight, upload
  thumbnail_url TEXT,
  payload JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clips
CREATE TABLE mod_twitch.twitch_clips (
  id TEXT PRIMARY KEY, -- clip ID from Twitch
  broadcaster_id TEXT NOT NULL,
  broadcaster_name TEXT NOT NULL,
  creator_id TEXT,
  creator_name TEXT,
  video_id TEXT,
  game_id TEXT,
  title TEXT,
  view_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  thumbnail_url TEXT,
  duration REAL,
  vod_offset INTEGER,
  payload JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Embeddings for context search
CREATE TABLE mod_twitch.twitch_embeddings (
  id TEXT PRIMARY KEY,
  context_key TEXT NOT NULL,
  content_type TEXT NOT NULL, -- stream, video, clip
  ts TIMESTAMPTZ NOT NULL,
  embedding vector(4096)
);
```

## Bus Events

Emit to NATS subjects:
- `feedeater.twitch.streamOnline` — Stream goes live
- `feedeater.twitch.streamOffline` — Stream ends
- `feedeater.twitch.videoCreated` — New VOD
- `feedeater.twitch.clipCreated` — New clip
- `feedeater.twitch.messageCreated` — Normalized message
- `feedeater.twitch.contextUpdated` — Context summary update
- `feedeater.twitch.log` — Telemetry

## API Endpoints Used

### Authentication
- `GET https://id.twitch.tv/oauth2/validate` — Validate token
- `POST https://id.twitch.tv/oauth2/token` — Refresh token

### Data Collection
- `GET https://api.twitch.tv/helix/streams/followed` — Followed live streams
- `GET https://api.twitch.tv/helix/videos` — VODs by user ID
- `GET https://api.twitch.tv/helix/clips` — Clips by broadcaster ID
- `GET https://api.twitch.tv/helix/users` — Resolve user IDs

## Implementation Order

1. Create directory structure and configs (package.json, tsconfig.json, module.json)
2. Create settings.ts with Zod schemas
3. Create src/ingest.ts with TwitchIngestor class
4. Create src/runtime.ts with job handlers
5. Create src/index.ts with exports
6. Test TypeScript compilation
7. Update CLAUDE.md with lessons learned
8. Commit and push

## Testing Strategy

1. TypeScript compilation check (`pnpm typecheck`)
2. Verify imports work correctly
3. Test patterns match Slack module

## Git Strategy

- Commit after each major file creation
- Final commit with full module
- Push when complete
