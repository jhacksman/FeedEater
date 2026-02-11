# Kalshi Module — CLAUDE.md

## What This Module Does
Collects prediction market data from the Kalshi Trade API v2 (markets and trades), normalizes them into the FeedEater unified message bus, and generates AI context summaries with embeddings.

## Data Flow
1. `collect` job runs every 5 minutes
2. Fetches open markets from `https://api.elections.kalshi.com/trade-api/v2/markets` with cursor pagination (up to 5 pages)
3. Also fetches individually watched markets by ticker
4. Optionally fetches recent trades per market (if `collectTrades` enabled)
5. Upserts markets and trades into `mod_kalshi` schema
6. Publishes `NormalizedMessage` for each market with price and volume
7. `updateContexts` job (every 30 minutes) generates AI summaries for recent markets

## Kalshi API Details
- Base: `https://api.elections.kalshi.com/trade-api/v2`
- Public market data: No authentication required
- Trading endpoints: Require HMAC-SHA256 authentication (not used by this module)
- Key endpoints:
  - `GET /markets?limit=100&status=open` — list markets with cursor pagination
  - `GET /markets/{ticker}` — single market by ticker
  - `GET /markets/trades?ticker={ticker}&limit=100` — recent trades
- Prices are 0-1 (fractional), multiply by 100 for percentage display

## Context Key Format
`market:{ticker}` — one context per market ticker

## Settings
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| enabled | boolean | false | |
| apiKey | string | (optional) | For authenticated endpoints (future use) |
| apiSecret | string | (optional) | For authenticated endpoints (future use) |
| watchedMarkets | string | "[]" | JSON array of tickers to always fetch |
| collectTrades | boolean | true | Fetch trades per market |
| collectOrderbook | boolean | false | Reserved for future use |
| lookbackHours | number | 24 | Context refresh window |
| contextPrompt | string | (see module.json) | AI summary system prompt |
| contextPromptFallback | string | (see module.json) | Fallback if JSON parse fails |

## Schema (mod_kalshi)
- `markets` — ticker (PK), title, subtitle, last_price, yes_bid, yes_ask, volume_24h, open_interest, status, close_time, payload (jsonb)
- `trades` — id (PK), ticker, count, yes_price, taker_side, created_at, payload (jsonb)
- `market_embeddings` — ticker, context_key, embedding (vector), for semantic search

## Tags Emitted
- `ticker`: Kalshi market ticker
- `eventTicker`: Parent event ticker
- `lastPrice`: Last trade price (0-1)
- `status`: Market status (e.g. "open", "closed")

## Message Format
`{title}: YES {price}% | Vol: {volume}` — e.g. "Fed rate cut in March: YES 42% | Vol: 15,234"

## Conventions
- Cursor pagination: API returns a `cursor` string, pass it as query param for next page
- Prices from Kalshi are already numeric (unlike Polymarket which returns JSON strings)
- `volume_24h` may be 0 for new or illiquid markets — still stored and published
- Trades are deduplicated by `trade_id` (ON CONFLICT DO NOTHING)

## What NOT to Do
- Do not use authenticated endpoints for read-only market data — public API is sufficient
- Do not paginate beyond 5 pages (500 markets) in a single collect cycle
- Do not assume all markets have trades — new markets may have zero trade history
- Do not hardcode market tickers — use `watchedMarkets` setting for specific markets
