# FeedEater — Data Quality Monitoring Design

**Version:** 1.0
**Updated:** 2026-02-18

## Problem

FeedEater collects data from 30+ modules across CEX, DEX, prediction markets, and social feeds. All data flows through NATS JetStream and is archived to Postgres. Today there is no automated detection when:

- A module stops publishing (stale feed)
- Trade volume drops anomalously vs. historical baseline (gap anomaly)
- A module is erroring silently (job failures accumulate in `job_runs` but nobody looks)

Operators discover problems manually — usually after downstream consumers notice missing data. This design adds a monitoring layer that detects these conditions and surfaces alerts.

## Goals

1. **Stale feed detection** — alert when a module hasn't published to NATS in X minutes
2. **Gap anomaly detection** — alert when event throughput drops significantly vs. rolling average
3. **Collector health dashboard** — per-module status, last event time, events/min, error rate
4. **Alerting** — surface problems via NATS alert subject + optional Telegram webhook

## Non-Goals

- Data content validation (schema correctness, field-level checks)
- Cross-module correlation (e.g., "Coinbase is publishing but Kraken isn't")
- Auto-remediation (restart modules, clear queues)
- Historical backfill detection

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     NATS JetStream                          │
│  feedeater.*.messageCreated   feedeater.*.tradeExecuted     │
│  feedeater.*.log              feedeater.worker.log          │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
               ▼                          ▼
┌──────────────────────┐    ┌──────────────────────────────┐
│  monitor module      │    │  Postgres                    │
│  (new NATS consumer) │    │  bus_messages                │
│                      │    │  job_runs / job_states        │
│  - staleness checker │    │  monitor_module_snapshots     │
│  - gap detector      │    │  monitor_alerts              │
│  - snapshot writer   │    └──────────────────────────────┘
│  - alert emitter     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Alert channels                          │
│  1. feedeater.monitor.alert (NATS)       │
│  2. Telegram webhook (optional)          │
│  3. Dashboard API endpoint               │
└──────────────────────────────────────────┘
```

The monitor runs as a FeedEater module (`modules/monitor/`) following the standard module pattern. It uses a BullMQ repeatable job to run health checks on a configurable interval (default: every 60 seconds).

## Detailed Design

### 1. Stale Feed Detection

**How it works:**

The monitor queries `bus_messages` for each known module to find the most recent event timestamp:

```sql
SELECT "sourceModule", MAX("createdAt") AS last_event_at
FROM bus_messages
GROUP BY "sourceModule"
```

It also queries `job_states` for last successful run times:

```sql
SELECT module, job, "lastRunAt", "lastSuccessAt", "lastErrorAt", "lastError"
FROM job_states
```

For each module, it compares `last_event_at` against `now() - staleness_threshold`. The threshold is configurable per module via settings, with a global default.

**Default thresholds:**

| Module type | Default staleness threshold |
|---|---|
| CEX (coinbase, kraken, binance, gemini, okx, bybit, bitstamp) | 5 minutes |
| DEX (uniswap, arbitrum-dex, polygon-dex) | 15 minutes |
| Prediction markets (kalshi, polymarket) | 30 minutes |
| Social (reddit, twitter, hackernews, etc.) | 60 minutes |
| System / internal | 120 minutes |

**Alert payload:**

```typescript
interface StaleFeedAlert {
  type: "stale_feed";
  module: string;
  lastEventAt: string;       // ISO timestamp
  thresholdMinutes: number;
  staleSinceMinutes: number;  // how long it's been stale
  severity: "warning" | "critical";
}
```

Severity escalation:
- `warning` — stale for 1× threshold
- `critical` — stale for 3× threshold

### 2. Gap Anomaly Detection

**How it works:**

The monitor maintains a rolling window of event counts per module. On each check cycle, it queries recent event throughput:

```sql
SELECT
  "sourceModule",
  date_trunc('minute', "createdAt") AS minute,
  COUNT(*) AS event_count
FROM bus_messages
WHERE "createdAt" >= now() - INTERVAL '60 minutes'
GROUP BY "sourceModule", date_trunc('minute', "createdAt")
ORDER BY "sourceModule", minute
```

For each module, it computes:
- **Current rate:** events in the last 5 minutes (configurable)
- **Rolling average:** average events per 5-minute window over the last 60 minutes
- **Drop ratio:** `current_rate / rolling_average`

If `drop_ratio < drop_threshold` (default: 0.2, meaning 80%+ drop), an alert fires.

**Alert payload:**

```typescript
interface GapAnomalyAlert {
  type: "gap_anomaly";
  module: string;
  currentRate: number;         // events in current window
  rollingAverage: number;      // events in average window
  dropRatio: number;           // 0.0 - 1.0
  windowMinutes: number;
  severity: "warning" | "critical";
}
```

Severity:
- `warning` — drop ratio < 0.2 (80% drop)
- `critical` — drop ratio < 0.05 (95% drop) or current rate is 0

**Edge cases:**
- Modules with < 10 events in the rolling window are excluded (not enough data to detect anomalies)
- New modules (< 2 hours of data) are excluded from gap detection
- Overnight/weekend drops for social modules are not anomalous — the threshold accounts for this via per-module configuration

### 3. JetStream Consumer Lag

**How it works:**

The NATS monitoring port (`:8222`) exposes JetStream consumer info. The monitor queries it via HTTP:

```
GET http://nats:8222/jsz?consumers=true
```

This returns consumer lag (number of undelivered messages) for each durable consumer. The archiver consumer (`feedeater_archiver`) is the primary one to watch.

```typescript
interface ConsumerLagSnapshot {
  stream: string;
  consumer: string;
  numPending: number;        // undelivered messages
  numAckPending: number;     // delivered but unacked
  lastDelivered: string;     // sequence info
}
```

**Alert condition:**
- `numPending > lag_threshold` (default: 1000 messages)
- `numAckPending > ack_threshold` (default: 100 messages)

**Alert payload:**

```typescript
interface ConsumerLagAlert {
  type: "consumer_lag";
  stream: string;
  consumer: string;
  numPending: number;
  numAckPending: number;
  severity: "warning" | "critical";
}
```

### 4. Collector Health Dashboard

**Postgres schema — snapshots table:**

```sql
CREATE TABLE IF NOT EXISTS mod_monitor.module_snapshots (
  id serial PRIMARY KEY,
  module text NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT now(),

  -- Event metrics
  last_event_at timestamptz,
  events_last_1m int NOT NULL DEFAULT 0,
  events_last_5m int NOT NULL DEFAULT 0,
  events_last_60m int NOT NULL DEFAULT 0,

  -- Job metrics
  last_job_success_at timestamptz,
  last_job_error_at timestamptz,
  last_job_error text,
  jobs_succeeded_24h int NOT NULL DEFAULT 0,
  jobs_failed_24h int NOT NULL DEFAULT 0,

  -- Derived
  status text NOT NULL DEFAULT 'unknown',  -- 'healthy', 'warning', 'critical', 'unknown'
  events_per_minute numeric(10,2) NOT NULL DEFAULT 0,
  error_rate numeric(5,4) NOT NULL DEFAULT 0  -- 0.0000 - 1.0000
);

CREATE INDEX idx_module_snapshots_module_time
  ON mod_monitor.module_snapshots (module, snapshot_at DESC);
```

**Snapshot collection (every 60s):**

For each discovered module, the monitor computes a snapshot by querying:

1. `bus_messages` — event counts and last event time
2. `job_runs` — success/failure counts in last 24h
3. `job_states` — last success/error timestamps

**Status derivation:**

```
healthy   — last event within threshold AND error rate < 5%
warning   — last event within 2× threshold OR error rate 5-20%
critical  — last event beyond 2× threshold OR error rate > 20%
unknown   — no events ever recorded
```

**Dashboard API endpoint:**

The monitor exposes its data via a new API route (added to `apps/api`):

```
GET /api/monitor/health
```

Response:

```json
{
  "modules": [
    {
      "module": "coinbase",
      "status": "healthy",
      "lastEventAt": "2026-02-18T06:55:00Z",
      "eventsPerMinute": 12.5,
      "eventsLast5m": 63,
      "eventsLast60m": 750,
      "lastJobSuccessAt": "2026-02-18T06:54:00Z",
      "lastJobErrorAt": null,
      "errorRate": 0.0,
      "jobsSucceeded24h": 1440,
      "jobsFailed24h": 0
    }
  ],
  "alerts": [
    {
      "type": "stale_feed",
      "module": "polygon-dex",
      "lastEventAt": "2026-02-18T05:30:00Z",
      "thresholdMinutes": 15,
      "staleSinceMinutes": 85,
      "severity": "critical"
    }
  ],
  "consumerLag": {
    "feedeater_archiver": { "numPending": 0, "numAckPending": 0 },
    "feedeater_archiver_tags": { "numPending": 0, "numAckPending": 0 }
  },
  "checkedAt": "2026-02-18T06:56:00Z"
}
```

**Retention:** Snapshots older than 7 days are pruned by a weekly cleanup job.

### 5. Alert Channels

Alerts are emitted to multiple channels simultaneously.

#### 5a. NATS Alert Subject

All alerts publish to `feedeater.monitor.alert`:

```typescript
nc.publish(
  "feedeater.monitor.alert",
  sc.encode(JSON.stringify({
    type: alert.type,
    module: alert.module,
    severity: alert.severity,
    message: formatAlertMessage(alert),
    timestamp: new Date().toISOString(),
    payload: alert,
  }))
);
```

Any downstream consumer can subscribe to `feedeater.monitor.alert` to receive all alerts, or `feedeater.monitor.>` for all monitor events.

#### 5b. Telegram Webhook (Optional)

If `MONITOR_TELEGRAM_BOT_TOKEN` and `MONITOR_TELEGRAM_CHAT_ID` are set, the monitor sends formatted alerts via Telegram Bot API:

```
POST https://api.telegram.org/bot{token}/sendMessage
{
  "chat_id": "{chat_id}",
  "text": "🔴 CRITICAL: coinbase feed stale for 15 minutes (threshold: 5m)",
  "parse_mode": "Markdown"
}
```

**Deduplication:** The monitor tracks alert state per module. It only sends Telegram alerts on state transitions (healthy → warning, warning → critical, critical → healthy). It does not spam on every check cycle.

**Rate limiting:** Maximum 1 Telegram message per module per 5 minutes.

#### 5c. NATS Log Subject

All alert activity is also logged to `feedeater.monitor.log` following the standard log format used by the worker:

```json
{
  "level": "warn",
  "module": "monitor",
  "source": "staleness-checker",
  "at": "2026-02-18T06:56:00Z",
  "message": "stale feed detected: coinbase (15m since last event, threshold 5m)",
  "meta": { "module": "coinbase", "staleSinceMinutes": 15 }
}
```

## Module Structure

```
modules/monitor/
├── module.json
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── settings.ts
└── src/
    ├── index.ts
    ├── runtime.ts
    ├── ingest.ts            # MonitorIngestor class
    ├── staleness.ts         # stale feed checker
    ├── gap-detector.ts      # volume anomaly detector
    ├── consumer-lag.ts      # JetStream lag checker
    ├── alerts.ts            # alert formatting + dispatch
    └── __tests__/
        └── monitor.test.ts
```

### module.json

```json
{
  "name": "monitor",
  "version": "0.0.1",
  "description": "Data quality monitoring — stale feeds, gap anomalies, collector health",
  "runtime": { "entry": "dist/runtime.js" },
  "queues": [
    {
      "name": "mod_monitor",
      "durable": "mod_monitor",
      "ack_wait_seconds": 60,
      "max_deliver": 3
    }
  ],
  "jobs": [
    {
      "name": "healthCheck",
      "queue": "mod_monitor",
      "schedule": "*/1 * * * *",
      "description": "Run health checks every 60 seconds"
    },
    {
      "name": "pruneSnapshots",
      "queue": "mod_monitor",
      "schedule": "0 3 * * 0",
      "description": "Prune snapshots older than 7 days weekly"
    }
  ],
  "settings": [
    { "key": "enabled", "type": "boolean", "default": "true" },
    { "key": "check_interval_seconds", "type": "number", "default": "60" },
    { "key": "default_staleness_minutes", "type": "number", "default": "30" },
    { "key": "staleness_overrides", "type": "string", "default": "{}" },
    { "key": "gap_drop_threshold", "type": "number", "default": "0.2" },
    { "key": "gap_window_minutes", "type": "number", "default": "5" },
    { "key": "gap_rolling_window_minutes", "type": "number", "default": "60" },
    { "key": "consumer_lag_threshold", "type": "number", "default": "1000" },
    { "key": "nats_monitoring_url", "type": "string", "default": "http://nats:8222" },
    { "key": "telegram_bot_token", "type": "string", "default": "" },
    { "key": "telegram_chat_id", "type": "string", "default": "" },
    { "key": "snapshot_retention_days", "type": "number", "default": "7" }
  ]
}
```

### Settings

`staleness_overrides` is a JSON map of module name → threshold minutes:

```json
{
  "coinbase": 5,
  "kraken": 5,
  "binance": 5,
  "gemini": 5,
  "okx": 5,
  "bybit": 5,
  "bitstamp": 5,
  "uniswap": 15,
  "arbitrum-dex": 15,
  "polygon-dex": 15,
  "kalshi": 30,
  "polymarket": 30,
  "reddit": 60,
  "twitter": 60,
  "hackernews": 60,
  "discord": 60,
  "telegram": 60,
  "bluesky": 60,
  "mastodon": 60,
  "rss": 60,
  "youtube": 120,
  "github": 120,
  "twitch": 120,
  "slack": 120,
  "signal": 120
}
```

## Key Queries

### Events per minute (last 60 minutes, per module)

```sql
SELECT
  "sourceModule",
  COUNT(*) / 60.0 AS events_per_minute,
  MAX("createdAt") AS last_event_at
FROM bus_messages
WHERE "createdAt" >= now() - INTERVAL '60 minutes'
GROUP BY "sourceModule"
```

### Job error rate (last 24 hours, per module)

```sql
SELECT
  module,
  COUNT(*) FILTER (WHERE status = 'success') AS succeeded,
  COUNT(*) FILTER (WHERE status = 'error') AS failed,
  COUNT(*) FILTER (WHERE status = 'error')::numeric / NULLIF(COUNT(*), 0) AS error_rate
FROM job_runs
WHERE "createdAt" >= now() - INTERVAL '24 hours'
GROUP BY module
```

### JetStream consumer lag (via NATS monitoring HTTP)

```
GET http://nats:8222/jsz?consumers=true&acc=$G
```

Response includes `num_pending` and `num_ack_pending` per consumer.

## Health Check Flow (per cycle)

```
1. Query bus_messages for last event per module
2. Query job_states for last success/error per module
3. Query job_runs for 24h success/failure counts
4. Fetch JetStream consumer info from NATS monitoring port
5. For each module:
   a. Compute staleness → emit alert if stale
   b. Compute event rate vs rolling avg → emit alert if anomalous
   c. Compute error rate
   d. Derive status (healthy/warning/critical)
   e. Write snapshot to mod_monitor.module_snapshots
6. Check JetStream consumer lag → emit alert if lagging
7. Emit all alerts to NATS subject
8. Send Telegram alerts for state transitions
9. Return metrics: { modules_checked, alerts_fired, snapshots_written }
```

## Alert Deduplication

The monitor maintains in-memory state for alert deduplication:

```typescript
type AlertState = Map<string, {
  type: string;
  severity: "warning" | "critical";
  firstSeen: Date;
  lastAlerted: Date;
}>;
```

Key: `${alert.type}:${alert.module}`

Rules:
- **New alert** — fire immediately
- **Same severity** — re-alert only if `lastAlerted` was > 15 minutes ago
- **Escalation** (warning → critical) — fire immediately
- **Resolution** (any → healthy) — fire recovery alert, remove from state

Telegram dedup is stricter: max 1 message per module per 5 minutes.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONITOR_TELEGRAM_BOT_TOKEN` | No | (empty) | Telegram Bot API token |
| `MONITOR_TELEGRAM_CHAT_ID` | No | (empty) | Telegram chat ID for alerts |
| `NATS_MONITORING_URL` | No | `http://nats:8222` | NATS monitoring HTTP endpoint |

## Observability

The monitor itself publishes to:
- `feedeater.monitor.log` — structured logs (same format as `feedeater.worker.log`)
- `feedeater.monitor.alert` — alert payloads
- `feedeater.monitor.snapshot` — periodic health summaries

The monitor's own jobs appear in `job_runs` and `job_states` like any other module, so the monitor is self-monitoring (if it stops running, its own `job_states.lastSuccessAt` goes stale).

## Migration Path

1. **Phase 1:** Deploy monitor module with stale feed + gap detection. NATS alerts only.
2. **Phase 2:** Add Telegram integration. Wire up dashboard API endpoint.
3. **Phase 3:** Add JetStream consumer lag monitoring. Tune thresholds based on production data.

## Open Questions

1. **Should the dashboard be a separate web page or integrate into the existing FeedEater web UI?** The API endpoint approach allows either — the existing Next.js app (`apps/web`) could add a `/monitor` page that polls `/api/monitor/health`.

2. **Should alert thresholds be configurable per-module via the settings UI, or is the `staleness_overrides` JSON blob sufficient?** A dedicated UI would be friendlier but adds frontend scope.

3. **PagerDuty / Slack webhook support?** Telegram is simple and low-friction for a self-hosted system. PagerDuty or Slack could be added later as additional alert channels without changing the core design.

4. **Should the monitor track per-symbol granularity for CEX modules?** Currently it monitors at the module level. A CEX module publishes trades for many symbols — a single symbol going silent wouldn't trigger a module-level stale alert. Per-symbol monitoring is possible by parsing `bus_messages.tagsJson` but adds significant query cost.
