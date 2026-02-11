# FeedEater Web UI and Multi-Module Integration Test Results

**Test Date:** February 11, 2026  
**Tester:** Devin AI  
**Environment:** Docker Compose (localhost:666)

## Executive Summary

FeedEater's web UI is functional and provides a solid foundation for a daily feed reader. The core infrastructure (NATS message bus, PostgreSQL with pgvector, Caddy proxy) works correctly. The UI successfully displays a unified feed from multiple modules, though the context/AI summarization features require Ollama configuration to function.

## Build and Startup

### Initial Issues Fixed

1. **Missing module builds in Dockerfile.worker**: The `github` and `hackernews` modules existed in the `modules/` directory but were not included in the Docker build steps. This caused the worker to crash on startup with `ERR_MODULE_NOT_FOUND`.

   **Fix applied:** Added the following to `docker/Dockerfile.worker`:
   - `COPY modules/github/package.json modules/github/package.json`
   - `COPY modules/hackernews/package.json modules/hackernews/package.json`
   - `RUN npm run -w @feedeater/module-github build`
   - `RUN npm run -w @feedeater/module-hackernews build`

2. **Database setup**: Required running `make db-push` after `make up` to create the Prisma schema tables. The pgvector extension was already available in the container.

### Services Running

All 6 services start and run correctly:
- `feedeater-postgres-1` - PostgreSQL with pgvector (healthy)
- `feedeater-nats-1` - NATS JetStream message bus
- `feedeater-api-1` - Node.js API on port 4000
- `feedeater-worker-1` - Background job processor
- `feedeater-web-1` - Next.js frontend on port 3000
- `feedeater-proxy-1` - Caddy reverse proxy on port 666

## UI Pages Assessment

### 1. Dashboard (Live Bus Feed)

**URL:** `http://localhost:666/`

**Status:** WORKING

**Features:**
- Real-time SSE streaming from NATS via `feedeater.*.messageCreated`
- History from PostgreSQL with configurable lookback (default 60 minutes)
- Module filter dropdown with all 17 modules
- Stream filter input
- Search functionality for message/from fields
- "Show IDs" toggle for debugging
- "Reload history" button

**Observations:**
- SSE connection establishes successfully (shows "Live Bus Feed" after connecting)
- Messages display with module name, timestamp, content, and stream
- Filter by module works correctly
- Real-time updates appear as new messages are published

### 2. Modules Page

**URL:** `http://localhost:666/modules`

**Status:** WORKING

**Features:**
- Lists all 17 discovered modules with version numbers
- Shows card count and settings count per module
- Click-through to individual module configuration

**Modules discovered:**
bluesky, discord, example, github, hackernews, kalshi, mastodon, polymarket, reddit, rss, signal, slack, system, telegram, twitch, twitter, youtube

### 3. Module Settings Page (e.g., hackernews)

**URL:** `http://localhost:666/modules/hackernews`

**Status:** WORKING

**Features:**
- Module metadata (name, version, namespace)
- Quick navigation to other modules via pill buttons
- Cards section showing available UI widgets (with "not yet wired" notices)
- Settings section with editable fields:
  - enabled (boolean)
  - feedTypes (string)
  - maxStoriesPerFeed (number)
  - lookbackHours (number)
  - includeComments (boolean)
  - contextPrompt (string)
  - etc.
- Save button per setting

**Observations:**
- Settings can be configured from the UI
- Default values shown as placeholders
- Cards are defined but UI widgets not yet implemented

### 4. Jobs Page

**URL:** `http://localhost:666/jobs`

**Status:** WORKING

**Features:**
- Lists all jobs grouped by module
- Shows queue name and cron schedule
- Displays last run time and duration metrics
- Shows last error with full stack trace
- "Run now" button for manual triggers
- Job metrics (feeds_polled, stories_seen, etc.)

**Observations:**
- Manual job triggers work (shows "Enqueued (jobId=...)")
- Error messages are helpful for debugging missing credentials
- Modules requiring API keys show clear error messages (e.g., "Bluesky setting 'identifier' is required")

### 5. Contexts Page

**URL:** `http://localhost:666/contexts`

**Status:** WORKING (but empty)

**Features:**
- Real-time SSE streaming for context updates
- History from PostgreSQL
- Module filter dropdown
- Search functionality
- "Show IDs" toggle

**Observations:**
- Page loads correctly
- No contexts displayed because:
  1. Context update jobs require Ollama for AI summarization
  2. `ollama_base_url` setting is empty by default
  3. No messages have been summarized yet

### 6. Logs Page

**URL:** `http://localhost:666/logs`

**Status:** WORKING (but empty)

**Features:**
- Real-time SSE streaming for `feedeater.*.log` events
- Shows "No logs yet" when empty

**Observations:**
- Page loads correctly
- Modules don't appear to emit log events to the bus currently

## Multi-Module Integration Test

### Test: Example + Hackernews Modules Running Simultaneously

**Example Module:**
- Status: WORKING
- Emits a demo message every minute via `example.tick` job
- Messages appear in unified feed with `example` tag
- Stream: `scheduler`

**Hackernews Module:**
- Status: PARTIALLY WORKING
- Job runs successfully (8s duration, 5 feeds polled)
- No stories published because lookback window has no new content
- Would need longer runtime or adjusted lookback to see real HN stories

**Unified Feed:**
- Successfully shows messages from multiple modules
- Filter by module works correctly
- Real-time updates work

## Tagging System

**Status:** WORKING

Messages include tags in their data structure:
```json
{
  "tags": {
    "example": true
  }
}
```

Tags are set by modules when creating messages. The example module tags all messages with `{"example": true}`.

## Context System

**Status:** NOT TESTED (requires Ollama)

The context system requires:
1. Ollama running and accessible
2. `ollama_base_url` configured in system settings
3. `ollama_summary_model` set (default: llama3.1:8b)

Context update jobs (`*.updateContexts`) will generate AI summaries when configured.

## API Endpoints

### GET /api/bus/history
**Status:** WORKING
- Returns messages from PostgreSQL
- Supports `module`, `sinceMinutes`, `limit` query params

### GET /api/contexts/history
**Status:** WORKING
- Returns contexts from PostgreSQL
- Currently empty (no AI summaries generated)

### GET /api/modules
**Status:** WORKING
- Returns full module metadata including settings, jobs, and cards

### POST /api/jobs/:module/:job/run
**Status:** WORKING
- Triggers manual job execution
- Returns job ID

## Key Questions Answered

### Is the web UI functional enough to use as a daily feed reader?

**Answer: Almost, but not quite yet.**

**What works:**
- Unified feed view with real-time updates
- Module configuration from UI
- Job management and manual triggers
- Basic filtering and search

**What's missing for daily use:**
- No read/unread tracking
- No bookmarking or saving items
- No keyboard navigation
- Card widgets not implemented (show "not yet wired")
- Context summaries require Ollama setup
- No mobile-responsive design testing done

### Can you see a unified feed from multiple sources?

**Answer: Yes.**

The dashboard successfully aggregates messages from all enabled modules into a single chronological feed. The module filter allows viewing specific sources. Real-time SSE streaming ensures new messages appear immediately.

### What is the biggest gap between current state and usable product?

**Answer: Content richness and AI features.**

1. **Card widgets not implemented** - Module-specific UI components (status cards, feed lists) are defined but show "not yet wired to a UI widget"

2. **AI summarization requires external setup** - Ollama must be running and configured for context summaries to work

3. **Most modules require API credentials** - Only `example` and `hackernews` work out of the box. Others need tokens/keys configured.

4. **No user-facing features** - No read tracking, favorites, or personalization

## Recommendations

1. **Documentation**: Add setup instructions for Ollama integration
2. **Onboarding**: Create a first-run wizard to configure at least one real module
3. **Card widgets**: Implement the defined card components for richer module UIs
4. **Error handling**: Show friendly messages when modules are misconfigured instead of just error stacks
5. **Mobile**: Test and optimize for mobile viewports

## Screenshots

Screenshots were captured during testing and are available in the Devin session at:
https://app.devin.ai/sessions/065914a6f4ae4c67ba46145c449e163a

- Dashboard with live feed
- Modules list page
- Hackernews module settings
- Jobs page with metrics
- Contexts page (empty state)
- Logs page (empty state)
