# Prediction Market Data API (v1)

Public API for accessing prediction market data collected by FeedEater.

**Base URL:** `http://localhost:4000/api/v1/data/predictions`

## Venues

- **Kalshi** — CFTC-regulated event contracts
- **Polymarket** — Crypto-native prediction market on Polygon

## Endpoints

### Overview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/stats` | Cross-venue statistics |
| GET | `/kalshi/markets` | List Kalshi markets |
| GET | `/kalshi/markets/:ticker` | Kalshi market detail + recent trades |
| GET | `/kalshi/trades` | Kalshi trade history |
| GET | `/polymarket/markets` | List Polymarket markets |
| GET | `/polymarket/markets/:id` | Polymarket market detail + recent trades |
| GET | `/polymarket/trades` | Polymarket trade history |

### Common Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | 100 | Results per page (1-1000) |
| `offset` | int | 0 | Pagination offset |
| `since` | ISO 8601 | — | Filter: trades after this time |
| `until` | ISO 8601 | — | Filter: trades before this time |

### GET /stats

Returns aggregate statistics across all venues.

```json
{
  "venues": {
    "kalshi": {
      "markets": { "total_markets": 14583, "active_markets": 8234, "last_updated": "..." },
      "trades": { "total_trades": 1245, "earliest_trade": "...", "latest_trade": "..." }
    },
    "polymarket": { "..." }
  },
  "generatedAt": "2026-02-15T10:00:00.000Z"
}
```

### GET /kalshi/markets

Query parameters: `q` (search), `status` (filter by status), `limit`, `offset`.

### GET /kalshi/trades

Query parameters: `ticker`, `since`, `until`, `limit`, `offset`.

### GET /polymarket/markets

Query parameters: `q` (search), `closed` (true/false), `limit`, `offset`.

### GET /polymarket/trades

Query parameters: `market_id`, `whale` (true = whale trades only), `since`, `until`, `limit`, `offset`.

## Response Format

All responses use camelCase keys and include venue identification:

```json
{
  "venue": "kalshi",
  "total": 14583,
  "limit": 100,
  "offset": 0,
  "data": [...]
}
```

## Future Additions

- API key authentication + rate limiting
- WebSocket streaming for real-time trades
- OHLCV candle aggregation
- Cross-venue market correlation
- OpenAPI spec
