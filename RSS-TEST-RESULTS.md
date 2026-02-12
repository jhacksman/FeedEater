# RSS Module End-to-End Test Results

**Date:** 2026-02-11  
**Branch:** `devin/1770846022-rss-verification`  
**Tester:** Devin (automated)

---

## 1. Environment Setup

### Containers

All containers started successfully via `docker compose up -d --build`:

| Container | Image | Status |
|-----------|-------|--------|
| postgres | pgvector/pgvector:pg16 | Healthy |
| nats | nats:2.10-alpine | Running |
| api | feedeater-api | Running (port 4000) |
| worker | feedeater-worker | Running |
| web | feedeater-web | Running (port 3000) |
| proxy | caddy:2-alpine | Running (port 666) |

### Fix Applied

**Dockerfile.worker** was missing COPY and build steps for `github` and `hackernews` modules. The worker discovers all 17 modules in `/app/modules/` but only 15 were included in the Docker build. Added:

- `COPY modules/github/package.json modules/github/package.json`
- `COPY modules/hackernews/package.json modules/hackernews/package.json`
- `RUN npm run -w @feedeater/module-github build`
- `RUN npm run -w @feedeater/module-hackernews build`

After fix, worker successfully discovered all 17 modules:
```
bluesky, discord, example, github, hackernews, kalshi, mastodon,
polymarket, reddit, rss, signal, slack, system, telegram, twitch,
twitter, youtube
```

### Database Initialization

- Ran `CREATE EXTENSION IF NOT EXISTS vector` for pgvector
- Ran `make db-push` to apply Prisma schema
- RSS module schema (`mod_rss.*`) created automatically by `ensureSchema()` on first poll job

---

## 2. Feed Configuration

Inserted 5 test feeds into `mod_rss.feeds`:

| Feed | URL | Entries |
|------|-----|---------|
| Hacker News: Front Page | https://hnrss.org/frontpage | 20 |
| Ars Technica - All content | https://feeds.arstechnica.com/arstechnica/index | 20 |
| Krebs on Security | https://krebsonsecurity.com/feed/ | 10 |
| The Register | https://www.theregister.com/headlines.atom | 50 |
| Schneier on Security | https://www.schneier.com/feed/atom/ | 10 |

**Total entries on first poll:** 110

---

## 3. Poll Job Results

### First Poll (with feeds configured)

```
Job ID:   f10c3295-30dc-481a-81b3-df0026483167
Status:   success
Duration: 1313ms
Metrics:
  feeds_polled:     5
  feeds_errored:    0
  feeds_unchanged:  0
  entries_inserted: 110
```

All 5 feeds polled successfully with zero errors. 110 entries inserted into `mod_rss.entries` and 110 normalized messages published to `bus_messages`.

### Message Normalization

Each message in `bus_messages` contains a properly normalized `rawJson` with:

- `id` (UUID v5, deterministic)
- `source.module` = "rss"
- `source.stream` = feed UUID
- `Message` = entry content (HTML)
- `from` = feed title
- `followMe` = entry URL
- `followMePanel.href` = entry URL, `.label` = "Read Article", `.module` = "rss"
- `contextRef.ownerModule` = "rss"
- `contextRef.sourceKey` = "feed:{feedId}"
- `createdAt` = entry publish date
- `isDigest` = false
- `isDirectMention` = false
- `isSystemMessage` = false

---

## 4. Deduplication Verification

### Test 1: Immediate re-poll (poll scheduling)

Triggered poll again immediately after first poll. Result:

```
feeds_polled:     0
entries_inserted: 0
```

The `poll_state.next_poll_at` prevents re-polling feeds before their scheduled time. No duplicates created.

- bus_messages count before: 110
- bus_messages count after: 110

### Test 2: Forced re-poll (entry-level dedup)

Reset `next_poll_at` to force all feeds to re-poll, then triggered poll:

```
feeds_polled:     5
feeds_errored:    0
feeds_unchanged:  1  (Schneier returned 304 Not Modified)
entries_inserted: 2  (genuinely new entries published since first poll)
```

- bus_messages count before: 110
- bus_messages count after: 112 (only 2 genuinely new entries)

Entry-level deduplication confirmed working via `UNIQUE(feed_id, guid)` constraint on `mod_rss.entries`.

---

## 5. Cleanup Job Results

```
Job ID:   8443f0e4-45ba-4142-86d1-559629115a6d
Status:   success
Duration: 22ms
Metrics:
  entries_deleted:    0
  embeddings_deleted: 0
```

Zero entries deleted because all entries are within the 90-day retention period (default `retentionDays` setting). This is expected behavior for freshly collected entries.

---

## 6. Context Creation

### Context References in Messages

All 112 messages contain proper `contextRef` with `feed:{feedId}` keys:

| Context Key | Messages |
|-------------|----------|
| feed:96e55fd9-... (The Register) | 50 |
| feed:80b4275e-... (Hacker News) | 22 |
| feed:fa5fe032-... (Ars Technica) | 20 |
| feed:c97c4dad-... (Krebs) | 10 |
| feed:fbb60db8-... (Schneier) | 10 |

### updateContexts Job

```
Job ID:   171e8ca5-e359-4431-a224-41f7432cb85f
Status:   success
Duration: 47ms
Metrics:
  contexts_updated:    0
  ai_summaries:        0
  embeddings_inserted: 0
```

The `updateContexts` job completed successfully but produced 0 AI summaries. This is expected because the AI summary generation requires an Ollama endpoint (configured via system settings `ollama_base_url`), which is not available in this test environment. The context reference linkage in messages works correctly regardless.

### bus_context_messages

Empty (0 rows) because `bus_contexts` rows are only created when `updateContexts` successfully generates AI summaries and publishes `ContextUpdated` events.

---

## 7. Poll State

All 5 feeds have healthy poll state:

| Feed | Has ETag | Last Modified | Consecutive Errors | 304s |
|------|----------|---------------|-------------------|------|
| Ars Technica | No | Wed, 11 Feb 2026 20:15:00 GMT | 0 | 0 |
| Hacker News | No | Wed, 11 Feb 2026 21:23:39 GMT | 0 | 0 |
| Krebs on Security | No | Tue, 20 Jan 2026 18:19:13 GMT | 0 | 0 |
| Schneier on Security | Yes | Wed, 11 Feb 2026 18:24:30 GMT | 0 | 1 |
| The Register | No | Wed, 11 Feb 2026 21:55:43 GMT | 0 | 0 |

Schneier correctly returned 304 on the forced re-poll (has ETag, 1 consecutive 304).

---

## 8. Summary

| Test | Result |
|------|--------|
| Containers running | PASS |
| Worker discovers all modules | PASS |
| Schema auto-creation | PASS |
| Feed configuration (5 feeds) | PASS |
| Poll job (all feeds fetched) | PASS |
| Message normalization | PASS |
| Entries per feed (all > 0) | PASS |
| Poll scheduling (next_poll_at) | PASS |
| Entry-level deduplication | PASS |
| Conditional GET (ETag/Last-Modified) | PASS |
| 304 Not Modified handling | PASS |
| Cleanup job execution | PASS |
| Context ref in messages | PASS |
| updateContexts job execution | PASS |
| Zero errors across all jobs | PASS |

### Issues Found

1. **Dockerfile.worker missing modules** (FIXED): `github` and `hackernews` modules were not included in the Docker build process, causing worker crash on startup.

2. **AI context summaries not available** (NOT A BUG): The `updateContexts` job requires an Ollama endpoint for AI-generated summaries. Without it, contexts are not populated in `bus_contexts`. The contextRef linkage in messages works correctly regardless.
