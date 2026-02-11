# FeedEater Prediction Market Module Verification Results

**Date:** 2026-02-11  
**Tested by:** Devin AI  
**Modules:** Kalshi, Polymarket

## Executive Summary

| Module | Status | Live Data | Blocking Issues |
|--------|--------|-----------|-----------------|
| Kalshi | Working | Yes | None |
| Polymarket | Blocked | No | 2 code bugs |

**Key Question:** Can we get live prediction market data flowing through FeedEater right now?

**Answer:** Kalshi module works and collects live data. Polymarket module has code bugs that prevent data collection.

## Kalshi Module

### API Requirements

- **API Base:** `https://api.elections.kalshi.com/trade-api/v2`
- **Authentication:** Optional for public market data
- **API Key/Secret:** Not required for basic market collection
- **Rate Limits:** Not documented, but 100 markets per page with pagination works

### Settings

| Setting | Type | Default | Required |
|---------|------|---------|----------|
| enabled | boolean | false | Yes |
| apiKey | string | undefined | No (optional for trading) |
| apiSecret | string | undefined | No (optional for trading) |
| watchedMarkets | JSON array | [] | No |
| collectTrades | boolean | true | No |
| collectOrderbook | boolean | false | No |
| lookbackHours | number | 24 | No |

### Test Results

```
Job: collect
Status: SUCCESS
Duration: 38549ms
Metrics:
  - markets_updated: 500
  - trades_collected: 30
  - messages_published: 500
```

### Data Quality

The Kalshi module successfully collects and publishes:
- Market titles (e.g., "yes Texas Tech wins by over 8.5 Points...")
- Current prices (last_price as decimal 0-1)
- 24-hour volume
- Market status (active/closed)
- Event tickers for grouping related markets

Sample message format:
```
{market.title}: YES {price}% | Vol: {volume_24h}
```

### Database Schema

Tables created in `mod_kalshi` schema:
- `markets` - Market data with ticker, title, prices, volume, status
- `trades` - Individual trade records
- `market_embeddings` - AI-generated embeddings for context

## Polymarket Module

### API Requirements

- **API Base:** `https://gamma-api.polymarket.com` (public Gamma API)
- **Authentication:** None required
- **Rate Limits:** Not documented

### Settings

| Setting | Type | Default | Required |
|---------|------|---------|----------|
| enabled | boolean | false | Yes |
| watchedMarkets | JSON array | [] | No |
| watchedCategories | JSON array | ["politics", "crypto", "sports"] | No |
| minVolume | number | 10000 | No |
| collectComments | boolean | false | No |
| lookbackHours | number | 24 | No |

### Test Results

```
Job: collect
Status: ERROR
Error: TypeError: Invalid UUID
```

### Blocking Issues

#### Issue 1: Invalid UUID Namespace (CRITICAL)

**Location:** `modules/polymarket/src/ingest.ts:18`

```typescript
const UUID_NAMESPACE = "c3d5e7f9-2b4c-6d8e-0f1a-3b5c7d9e1f2a";
```

**Problem:** The UUID namespace has invalid variant bits. Position 19 is "0" but should be "8", "9", "a", or "b" per RFC 4122. The uuid library's v5() function throws "Invalid UUID" when trying to generate message IDs.

**Impact:** Module crashes when processing any events.

**Fix Required:** Replace with a valid UUID namespace, e.g.:
```typescript
const UUID_NAMESPACE = "c3d5e7f9-2b4c-6d8e-8f1a-3b5c7d9e1f2a";
//                                        ^ change 0 to 8
```

#### Issue 2: tag_slug API Parameter (MEDIUM)

**Location:** `modules/polymarket/src/ingest.ts:224`

```typescript
params.set("tag_slug", categories.join(","));
```

**Problem:** The Polymarket Gamma API does not support comma-separated values for the `tag_slug` parameter. When multiple categories are provided (e.g., "politics,crypto,sports"), the API returns 0 results.

**Impact:** Default configuration returns no events. The issue was masked by Issue 1 because when categories return 0 events, the UUID generation code never runs.

**Workaround:** Set `watchedCategories` to `[]` (empty array) to fetch all events without filtering.

**Fix Required:** Either:
1. Make separate API calls for each category and merge results
2. Remove the tag_slug parameter entirely and filter client-side
3. Use a single category at a time

### API Verification

The Polymarket Gamma API itself works correctly:

```bash
# Returns data
curl "https://gamma-api.polymarket.com/events?closed=false&limit=5"

# Returns 0 results (bug)
curl "https://gamma-api.polymarket.com/events?tag_slug=politics,crypto,sports"
```

## Infrastructure Issues Fixed

### Dockerfile.worker Missing Modules

**Problem:** Worker container crashed on startup with:
```
Error: Cannot find module '/app/modules/github/dist/runtime.js'
```

**Cause:** `docker/Dockerfile.worker` was missing COPY and RUN build steps for `github` and `hackernews` modules.

**Fix Applied:** Added missing modules to Dockerfile.worker:
```dockerfile
# Added to deps stage
COPY modules/github/package.json modules/github/package.json
COPY modules/hackernews/package.json modules/hackernews/package.json

# Added to build stage
RUN npm run -w @feedeater/module-github build
RUN npm run -w @feedeater/module-hackernews build
```

### Database Initialization

**Problem:** API returned 502 Bad Gateway on startup.

**Cause:** PostgreSQL pgvector extension not created and Prisma schema not applied.

**Fix Applied:**
```bash
docker compose exec postgres psql -U feedeater -d feedeater -c "CREATE EXTENSION IF NOT EXISTS vector;"
make db-push
```

## Recommendations

1. **Fix Polymarket UUID namespace** - Single character change to make the module functional
2. **Fix Polymarket tag_slug handling** - Either iterate over categories or remove filtering
3. **Add Kalshi API credentials** - For trading functionality (not required for data collection)
4. **Consider adding health checks** - Module-level health endpoints to detect issues faster

## Test Environment

- Docker Compose with containers: worker, api, web, postgres, nats, proxy
- PostgreSQL with pgvector extension
- NATS message bus
- All 17 modules discovered by worker

## Conclusion

The Kalshi module is production-ready for collecting live prediction market data. The Polymarket module requires two code fixes before it can collect data. Both issues are straightforward to fix but were not addressed per the "DO NOT refactor" instruction.
