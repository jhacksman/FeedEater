# Polymarket Module

Prediction market integration for [Polymarket](https://polymarket.com/).

## Status

**STUB** - This module is a placeholder. The API integration is not yet implemented.

## Overview

This module will collect:
- Event data (questions, categories, dates)
- Market data (prices, volume, liquidity)
- Trading activity
- Comments/discussion (optional)

Each market becomes a "context" in FeedEater, allowing AI summarization of market activity.

## Settings

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `enabled` | boolean | No | Enable/disable the module (default: false) |
| `watchedMarkets` | string | No | JSON array of condition IDs to watch |
| `watchedCategories` | string | No | JSON array of categories (default: politics, crypto, sports) |
| `minVolume` | number | No | Minimum 24h volume to include (default: 10000) |
| `collectComments` | boolean | No | Collect market comments (default: false) |
| `lookbackHours` | number | No | Hours of history to collect (default: 24) |

## API Reference

- [Polymarket Gamma API](https://gamma-api.polymarket.com) - Event and market data
- [Polymarket CLOB API](https://clob.polymarket.com) - Order book and trading data

## TODO

- [ ] Implement event/market fetching via Gamma API
- [ ] Implement CLOB API integration for real-time prices
- [ ] Add category filtering
- [ ] Implement comment collection
- [ ] Implement context summaries with AI
