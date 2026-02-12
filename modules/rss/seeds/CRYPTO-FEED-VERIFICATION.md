# Crypto/DeFi RSS Feed Verification Results

**Date:** 2026-02-12  
**Branch:** `devin/1770869504-rss-crypto-feeds`

---

## Feed Configuration

7 crypto/DeFi RSS feeds added via `crypto-defi-feeds.sql`:

| Feed | URL | Category | Poll Interval |
|------|-----|----------|---------------|
| CoinDesk | https://www.coindesk.com/arc/outboundfeeds/rss/ | crypto-news | 15 min |
| The Block | https://www.theblock.co/rss.xml | crypto-news | 15 min |
| Blockworks | https://blockworks.co/feed | crypto-news | 15 min |
| Cointelegraph | https://cointelegraph.com/rss | crypto-news | 15 min |
| Rekt News | https://rekt.news/feed.xml | defi-security | 30 min |
| DL News | https://www.dlnews.com/arc/outboundfeeds/rss/ | defi-news | 30 min |
| Ethereum Foundation Blog | https://blog.ethereum.org/feed.xml | protocol-updates | 60 min |

---

## Poll Results

Poll triggered via `POST /api/jobs/run` with `{"module":"rss","job":"poll"}`.

```
feeds_polled:     10   (7 new crypto + 3 existing due for re-poll)
feeds_errored:    1    (Rekt News — HTTP 500 from their server)
feeds_unchanged:  1    (Schneier — 304 Not Modified)
entries_inserted: 848
```

### Per-Feed Entry Counts

| Feed | Entries | Status |
|------|---------|--------|
| CoinDesk | 25 | OK |
| The Block | 19 | OK |
| Blockworks | 50 | OK |
| Cointelegraph | 30 | OK |
| Rekt News | 0 | HTTP 500 (server-side issue) |
| DL News | 100 | OK |
| Ethereum Foundation Blog | 609 | OK |

**6/7 crypto feeds returning data successfully.** Rekt News returns HTTP 500 from their server — not a FeedEater bug.

---

## How to Use

```sql
-- Load feeds into a running FeedEater instance:
\i modules/rss/seeds/crypto-defi-feeds.sql

-- Or via docker:
docker compose exec -T postgres psql -U feedeater -d feedeater < modules/rss/seeds/crypto-defi-feeds.sql

-- Then trigger a poll:
curl -X POST http://localhost:666/api/jobs/run \
  -H "Content-Type: application/json" \
  -d '{"module":"rss","job":"poll"}'
```
