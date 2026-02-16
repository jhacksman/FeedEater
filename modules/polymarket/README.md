# Polymarket Module

Prediction market integration for [Polymarket](https://polymarket.com/).

## Status

**Implemented** — Full data collection via Gamma API, Data API, and CLOB WebSocket.

## Overview

This module collects:
- **Event data** — questions, categories, dates via [Gamma API](https://gamma-api.polymarket.com)
- **Market data** — prices, volume, liquidity, outcomes
- **Trading activity** — real-time trades via CLOB WebSocket + historical via [Data API](https://data-api.polymarket.com)
- **Orderbook snapshots** — periodic snapshots with mid-price and spread
- **AI context summaries** — market summaries and embeddings via `refreshContexts`

No authentication required — all Polymarket APIs are public read-only.

## Jobs

| Job | Description |
|-----|-------------|
| `collect` | Fetch events and markets from Gamma API, persist to Postgres |
| `stream` | WebSocket connection to CLOB for real-time trades and orderbook |
| `collectTrades` | REST polling of historical trades from Data API |
| `updateContexts` | Generate AI summaries and embeddings for active markets |

## NATS Subjects

| Subject | Description |
|---------|-------------|
| `feedeater.polymarket.tradeExecuted` | Every trade event |
| `feedeater.polymarket.messageCreated` | Whale trade alerts (above whaleThreshold) |
| `feedeater.polymarket.orderbookSnapshot` | Periodic orderbook snapshots |

## Postgres Schema

All tables under `mod_polymarket`:
- `events` — Polymarket events
- `markets` — Individual markets within events
- `trades` — Trade history
- `orderbook_snapshots` — Periodic orderbook snapshots
- `market_embeddings` — AI-generated embeddings

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | false | Enable/disable the module |
| `watchedMarkets` | string | `[]` | JSON array of condition IDs to watch |
| `watchedCategories` | string | `["politics","crypto","sports"]` | JSON array of categories |
| `minVolume` | number | 10000 | Minimum 24h volume to include |
| `collectComments` | boolean | false | Collect market comments |
| `collectAllTrades` | boolean | true | Collect all trades (not just whales) |
| `whaleThreshold` | number | 50000 | USD threshold for whale alerts |
| `orderbookEnabled` | boolean | true | Enable orderbook snapshots |
| `orderbookIntervalMs` | number | 60000 | Orderbook snapshot interval |
| `lookbackHours` | number | 24 | Hours of history to collect |

## API Reference

- [Polymarket Gamma API](https://gamma-api.polymarket.com) — Event and market data
- [Polymarket Data API](https://data-api.polymarket.com) — Trade history
- [Polymarket CLOB WebSocket](wss://ws-subscriptions-clob.polymarket.com/ws/) — Real-time orderbook and trades
