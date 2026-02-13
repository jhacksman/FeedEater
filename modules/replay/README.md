# Replay Module

Historical replay engine for FeedEater. Replays collected data from all modules at accelerated speed, measuring cross-venue lead-lag timing for backtesting strategies.

## Features

- **Multi-source replay**: Replays events from Kalshi trades, Kalshi markets, and Polymarket markets in chronological order
- **Configurable speed**: Replay at 1x, 10x, 100x or any custom multiplier
- **NATS publishing**: Publishes replayed events to dedicated replay channels for downstream consumers (e.g., AROMER strategy module)
- **Lead-lag analysis**: Measures which venue leads when the same underlying moves
- **Summary statistics**: Latency distributions, correlation matrices, lead-lag rankings

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | false | Enable/disable the module |
| `replaySpeed` | number | 10 | Replay speed multiplier |
| `startTime` | string | "" | ISO timestamp to start replay (empty = 24h ago) |
| `endTime` | string | "" | ISO timestamp to end replay (empty = now) |
| `includeKalshi` | boolean | true | Include Kalshi trades/markets |
| `includePolymarket` | boolean | true | Include Polymarket markets |
| `replayChannelPrefix` | string | "replay" | NATS channel prefix for replayed events |

## Jobs

### `startReplay`

Starts a historical replay session. Events are published to NATS channels in the format:
- `feedeater.replay.kalshi.trade`
- `feedeater.replay.kalshi.market_update`
- `feedeater.replay.polymarket.market_update`

Returns metrics including:
- Total events replayed
- Events by source
- Replay duration vs real-time duration
- Lead-lag analysis results
- Latency distribution (p50, p90, p99, mean)

### `analyzeLeadLag`

Analyzes cross-venue lead-lag relationships without running a full replay. Useful for quick analysis of historical data.

Returns:
- Lead-lag pairs with lag in milliseconds
- Correlation coefficients
- Sample counts
- Historical session statistics

## Database Schema

The module creates tables in the `mod_replay` schema:

- `sessions`: Tracks replay sessions with start/end times, speed, and stats
- `lead_lag_analysis`: Stores lead-lag analysis results per session

## Usage

1. Enable the module in settings
2. Configure time range and speed
3. Trigger `startReplay` job
4. Subscribe to `feedeater.replay.*` NATS channels for replayed events
5. Use `analyzeLeadLag` for quick lead-lag analysis

## Lead-Lag Interpretation

- Positive lag (e.g., +500ms): First venue leads second venue
- Negative lag (e.g., -500ms): Second venue leads first venue
- Correlation near 1.0: Strong positive relationship
- Correlation near 0: No relationship
