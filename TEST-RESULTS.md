# FeedEater Smoke Test Results

**Date:** 2026-02-11  
**Tester:** Devin (automated smoke test)  
**Focus:** HackerNews module and platform-level verification

## Executive Summary

The FeedEater platform starts successfully after Dockerfile fixes. All 6 containers come up healthy. The web UI is accessible and functional. However, the HackerNews module has a critical bug where it reports `stories_seen: 0` despite the HN API being accessible and returning valid data.

## What Worked

### Docker Compose Startup
- All 6 containers start and reach healthy state after Dockerfile fixes
- Containers: postgres (pgvector:pg16), nats (2.10-alpine), api, worker, web, proxy (caddy)
- Database schema initializes correctly via `make db-push`
- pgvector extension creates successfully

### Web UI (localhost:666)
- Dashboard loads and displays correctly
- Modules page shows all 17 discovered modules
- Jobs page shows job status and allows manual triggering
- Contexts page accessible
- Logs page accessible (SSE streaming from NATS)

### Module Discovery
- Worker discovers all 17 modules: bluesky, discord, example, github, hackernews, kalshi, mastodon, polymarket, reddit, rss, signal, slack, system, telegram, twitch, twitter, youtube
- Module runtimes load correctly
- Job scheduling works (cron triggers fire)

### Example Module
- Example module works correctly
- Produces messages every minute
- Messages appear in bus_messages table (8 messages observed)

### NATS Message Bus
- JetStream stream `feedeater_bus` created successfully
- Message archiving works
- Job events publish correctly

## What Broke

### 1. Dockerfile Configuration (FIXED)

**Issue:** Dockerfiles were missing hackernews and github modules in build steps.

**Error:**
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/modules/github/dist/runtime.js'
```

**Root Cause:** `docker/Dockerfile.worker` and `docker/Dockerfile.api` did not include COPY statements for all module package.json files, causing npm workspace resolution to fail.

**Fix Applied:** Updated both Dockerfiles to include all 17 modules:
- Added COPY statements for all module package.json files
- Added build commands for hackernews and github modules in Dockerfile.worker

### 2. Database Schema Not Initialized (FIXED)

**Issue:** API container crashed on first startup due to missing database tables.

**Error:**
```
PrismaClientKnownRequestError: The table 'public.Setting' does not exist in the current database.
```

**Fix:** Run `make db-push` after `make up` to push Prisma schema to database.

### 3. pgvector Extension Not Created (FIXED)

**Issue:** `make db-push` failed due to missing pgvector extension.

**Error:**
```
ERROR: type "vector" does not exist
```

**Fix:** Run `docker compose exec postgres psql -U feedeater -d feedeater -c "CREATE EXTENSION IF NOT EXISTS vector;"`

### 4. HackerNews Module Returns 0 Stories (BUG - NOT FIXED)

**Issue:** The hackernews.collect job runs successfully but returns `stories_seen: 0` and `stories_published: 0`.

**Observed Behavior:**
```json
{"durationMs": 8769, "feeds_polled": 5, "stories_seen": 0, "stories_published": 0}
```

**Investigation Results:**
- HN API is accessible from worker container (verified with wget)
- API returns valid story IDs (500 stories from topstories.json)
- Stories pass the 24-hour lookback filter
- Simulation of the exact fetch logic inside worker container shows 79 stories would be inserted
- mod_hackernews.stories table exists but has 0 rows
- No errors logged to worker stdout or NATS

**Suspected Cause:** There appears to be a silent failure in the actual module execution that doesn't occur in the simulation. Possible causes:
1. Database connection pool issue in the module context
2. Transaction handling issue
3. Error being caught and swallowed without logging
4. Issue with how the module runtime is being invoked

**Impact:** HackerNews stories are not being collected, so no HN content appears in the feed.

### 5. Other Modules Require Configuration

The following modules fail with expected configuration errors (not bugs):
- bluesky: `Error: Bluesky setting "identifier" is required`
- discord: `Error: Discord setting "botToken" is required`
- github: `Error: GitHub setting "accessToken" is required`
- mastodon: `Error: Mastodon setting "instanceUrl" is required`
- reddit: `Error: Reddit setting "clientId" is required`
- slack: `Error: Slack setting "botToken" is required`
- telegram: `Error: Telegram setting "apiId" is required`
- twitch: `Error: Twitch setting "clientId" is required`

These are expected behaviors - modules require API credentials to function.

## What the Feed Looks Like

Currently, the feed only shows messages from the example module (demo messages every minute). No HackerNews stories appear due to the bug described above.

**bus_messages table:**
```
 sourceModule | count 
--------------+-------
 example      |     8
```

## Test Suite

No test files found in the repository (no `*.test.ts` or `*.spec.ts` files). The `npm run typecheck` command fails locally because TypeScript is not installed outside Docker containers.

## Recommendations

1. **Critical:** Investigate and fix the HackerNews module bug where stories_seen is always 0
2. **High:** Add better error logging in module execution to surface silent failures
3. **Medium:** Document the required startup sequence (`make up` then `make db-push`)
4. **Medium:** Consider auto-creating pgvector extension in the database initialization
5. **Low:** Add unit tests for module ingest logic

## Files Changed

1. `docker/Dockerfile.api` - Added all module package.json COPY statements
2. `docker/Dockerfile.worker` - Added all module package.json COPY statements and build commands for hackernews/github

## Reproduction Steps

```bash
# Clone and start
git clone https://github.com/jhacksman/FeedEater.git
cd FeedEater
make up

# Initialize database (required after first start)
docker compose exec postgres psql -U feedeater -d feedeater -c "CREATE EXTENSION IF NOT EXISTS vector;"
make db-push

# Verify containers
docker compose ps

# Access web UI
open http://localhost:666

# Trigger HackerNews collect job
# Go to Jobs page, find hackernews.collect, click "Run now"

# Check results
docker compose exec postgres psql -U feedeater -d feedeater -c "SELECT COUNT(*) FROM mod_hackernews.stories;"
# Expected: some rows, Actual: 0
```
