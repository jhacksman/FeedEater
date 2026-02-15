# FeedEater — Design Document

**Version:** 1.0  
**Updated:** 2026-02-14

## Purpose

FeedEater is a self-hosted, modular data collection and normalization engine. It ingests data from any external venue — financial exchanges, prediction markets, DEXs, social feeds, news — normalizes it into a unified schema, and publishes it on a NATS JetStream bus for any downstream consumer.

FeedEater does not trade. FeedEater does not analyze. FeedEater does not make decisions. It collects, normalizes, stores, and publishes. That's it.

## Design Principles

1. **Modules are independent plugins.** Each module handles one data source. No module knows about any other module. No cross-module imports, no shared state, no coupled logic.

2. **The bus is the API.** All inter-module and external communication happens via NATS JetStream subjects (`feedeater.<module>.<event>`). Consumers subscribe to the subjects they care about.

3. **Messages are normalized.** Every data source produces `NormalizedMessage` payloads with consistent schema, timestamps, tags, and metadata regardless of origin.

4. **FeedEater is venue-agnostic.** It doesn't care what the data means. A Kalshi trade, a Uniswap swap, and a Reddit post all flow through the same pipeline. Meaning is assigned by consumers, not by FeedEater.

5. **No downstream coupling.** FeedEater has zero knowledge of what consumes its data. It publishes to NATS. Who subscribes is not its concern.

6. **Secrets are encrypted at rest.** Module API keys and credentials are stored encrypted in Postgres using `FEED_SETTINGS_KEY`.

## Module Categories

### Financial — CEX
| Module | Venue | Data | Status |
|--------|-------|------|--------|
| `coinbase` | Coinbase | Trades, candles, orderbook snapshots | ✅ Built (PR #26) |
| `kraken` | Kraken | Trades, candles, orderbook snapshots | ✅ Built (PR #26) |
| `binance` | Binance | Trades, candles, orderbook snapshots | ✅ Built (PR #26) |

### Financial — DEX
| Module | Chain | Venue | Data | Status |
|--------|-------|-------|------|--------|
| `uniswap` | Ethereum L1 | Uniswap V2/V3 | Swap events, pool state | ✅ Built |
| `arbitrum-dex` | Arbitrum | Uniswap V3 + GMX | Swaps, positions | ✅ Built |
| `polygon-dex` | Polygon | QuickSwap | Swaps | ✅ Built |

### Financial — Prediction Markets
| Module | Venue | Data | Status |
|--------|-------|------|--------|
| `kalshi` | Kalshi | Trades, orderbook, settlements | ✅ Built |
| `polymarket` | Polymarket | Trades, orderbook | ✅ Built |

### Financial — Cross-Venue
| Module | Purpose | Status |
|--------|---------|--------|
| `event-resolver` | Maps equivalent events across venues (e.g., same underlying across Kalshi + Polymarket + CEX) | ✅ Built |
| `replay` | Historical data replay engine with lead-lag analysis | ✅ Built |

### Social / News
| Module | Status |
|--------|--------|
| `reddit` | ✅ Built |
| `twitter` | ✅ Built |
| `hackernews` | ✅ Built |
| `discord` | ✅ Built |
| `telegram` | ✅ Built |
| `bluesky` | ✅ Built |
| `mastodon` | ✅ Built |
| `rss` | ✅ Built |
| `youtube` | ✅ Built |
| `github` | ✅ Built |
| `twitch` | ✅ Built |
| `slack` | ✅ Built |
| `signal` | ✅ Built |

## NATS Subject Schema

All modules publish to: `feedeater.<module>.<event>`

Standard events:
- `messageCreated` — new normalized message ingested
- `messageUpdated` — existing message updated (e.g., settlement resolved)
- `contextUpdated` — context summary refreshed

Financial modules additionally publish:
- `tradeExecuted` — individual trade/swap event
- `orderbookSnapshot` — periodic orderbook state
- `candleClosed` — OHLCV candle completed

## Stack

- **Runtime:** Node.js + TypeScript
- **Database:** Postgres (pgvector-enabled)
- **Bus:** NATS JetStream
- **Container:** Docker Compose
- **Deploy:** Ansible playbook (`ansible/`)

## Deployment Requirements

- Docker + Docker Compose
- Postgres 15+ with pgvector
- NATS 2.10+ with JetStream enabled
- Environment variables per `docs/ENVIRONMENT.md`

## Module Development

See `modules/example/` for the module template. Each module:
1. Implements `runtime.ts` (lifecycle: start, stop, health check)
2. Implements `ingest.ts` (data collection logic)
3. Publishes `NormalizedMessage` to its NATS subject
4. Manages its own Postgres schema (no cross-module DB access)
5. Declares dependencies in its `package.json`

## What FeedEater Is NOT

- **Not a trading system.** It does not execute trades, manage positions, or calculate P&L.
- **Not an analytics engine.** It does not compute signals, correlations, or predictions.
- **Not a decision maker.** It does not decide what to buy, sell, or hold.
- It is a data plane. Period.

## BullMQ Restoration (Issue #47)

### Discovery (Feb 14 2026)

The upstream FeedEater used BullMQ + Redis for job dispatch. Our fork stripped it out and replaced it with hand-rolled setTimeout cron + serial NATS loops. This is why issue #46 exists — WebSocket jobs block everything because there's no concurrency model.

### Plan

Restore BullMQ + Redis. Keep our module runtimes, NATS archiver, and module code untouched. Only the dispatcher layer changes.

### What Sparks Had (commit 7482caf)
- `bullmq` + `ioredis` dependencies
- Redis service in docker-compose
- `Queue` per module, `Worker` per queue with concurrency
- BullMQ repeatable jobs for cron schedules
- NATS → BullMQ bridge for event-triggered jobs

### What We Broke
- Removed Redis entirely
- Replaced BullMQ with `scheduleCronJob()` using setTimeout chains
- Serial `for await` loops — one job at a time
- No concurrency, no job persistence, no retry logic

### Fix Scope
- Add Redis to docker-compose.yml
- Restore bullmq + ioredis deps
- Revert worker/src/index.ts dispatcher to BullMQ pattern
- Preserve: module runtimes, NATS archiver, all module code
