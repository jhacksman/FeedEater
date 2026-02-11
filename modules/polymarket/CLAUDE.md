# Polymarket Module — CLAUDE.md

## What This Module Does
Collects prediction market events and markets from the Polymarket Gamma API, normalizes them into the FeedEater unified message bus, and generates AI context summaries with embeddings.

## Data Flow
1. `collect` job runs every 5 minutes
2. Fetches events from `https://gamma-api.polymarket.com/events` filtered by categories and volume
3. Also fetches individually watched events by slug/ID
4. Each event contains nested markets with outcome prices, volumes, liquidity
5. Upserts events and markets into `mod_polymarket` schema
6. Publishes `NormalizedMessage` for markets above `minVolume` threshold
7. `updateContexts` job (every 30 minutes) generates AI summaries for recent high-volume markets

## Gamma API Details
- Base: `https://gamma-api.polymarket.com`
- No authentication required for public endpoints
- Key endpoint: `GET /events?closed=false&limit=100&order=volume24hr&ascending=false`
- Events contain nested `markets[]` array
- Market prices are JSON strings that need parsing (`outcomePrices`, `outcomes`)
- `volume24hr` is a number, `volume` and `liquidity` are strings

## Context Key Format
`market:{conditionId}` — one context per market condition

## Settings
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| enabled | boolean | false | |
| watchedMarkets | string | "[]" | JSON array of event slugs/IDs to always fetch |
| watchedCategories | string | '["politics","crypto","sports"]' | JSON array of category tags |
| minVolume | number | 10000 | Skip markets below this 24h volume |
| collectComments | boolean | false | Reserved for future use |
| lookbackHours | number | 24 | Context refresh window |
| contextPrompt | string | (see module.json) | AI summary system prompt |
| contextPromptFallback | string | (see module.json) | Fallback if JSON parse fails |

## Schema (mod_polymarket)
- `events` — id (PK), slug, title, description, start_date, end_date, payload (jsonb)
- `markets` — id (PK), event_id, condition_id, question, slug, outcome_prices (jsonb), outcomes (jsonb), volume, volume_24h, liquidity, closed, payload (jsonb)
- `market_embeddings` — market_id, context_key, embedding (vector), for semantic search

## Tags Emitted
- `eventId`: Polymarket event ID
- `marketId`: Polymarket market ID
- `conditionId`: CTF condition ID (unique market identifier)
- `yesPrice`: Current YES price (0-1)
- `volume24h`: 24-hour trading volume
- `closed`: boolean

## Message Format
`{question}: YES {price}% | 24h Vol: ${volume}` — e.g. "Will BTC hit $100k? YES 73% | 24h Vol: $1,234,567"

## Conventions
- `outcomePrices` and `outcomes` are JSON strings from the API — parsed with try/catch
- Volume filtering happens at publish time, not fetch time (all markets stored in DB)
- Events with no markets array are handled gracefully (empty array fallback)
- Category filtering via `tag_slug` query parameter on the events endpoint

## What NOT to Do
- Do not hardcode category filters — use `watchedCategories` setting
- Do not skip storing low-volume markets — only skip publishing them as messages
- Do not assume `outcomePrices` is already parsed — it's a JSON string from the API
- Do not use the CLOB API for read-only data — Gamma API is sufficient and simpler
