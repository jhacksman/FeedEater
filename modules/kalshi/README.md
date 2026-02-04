# Kalshi Module

Prediction market integration for [Kalshi](https://kalshi.com/).

## Status

**STUB** - This module is a placeholder. The API integration is not yet implemented.

## Overview

This module will collect:
- Market data (prices, volume, open interest)
- Recent trades
- Orderbook snapshots (optional)

Each market becomes a "context" in FeedEater, allowing AI summarization of market activity.

## Settings

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `enabled` | boolean | No | Enable/disable the module (default: false) |
| `apiKey` | secret | No | Kalshi API key (optional for public data) |
| `apiSecret` | secret | No | Kalshi API secret |
| `watchedMarkets` | string | No | JSON array of market tickers to watch |
| `collectTrades` | boolean | No | Collect recent trades (default: true) |
| `collectOrderbook` | boolean | No | Collect orderbook snapshots (default: false) |
| `lookbackHours` | number | No | Hours of history to collect (default: 24) |

## API Reference

- [Kalshi Trading API](https://trading-api.readme.io/reference/getmarkets)
- Base URL: `https://api.elections.kalshi.com/trade-api/v2`

## TODO

- [ ] Implement market fetching via Kalshi API
- [ ] Implement trade collection
- [ ] Implement orderbook snapshots
- [ ] Add authentication support
- [ ] Implement context summaries with AI
