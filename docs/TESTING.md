# FeedEater Testing Guide

This document describes how to verify that FeedEater modules are working correctly and data is flowing through the system.

## Quick Start

```bash
# Run the full smoke test (starts services, enables modules, verifies data flow)
make smoke-test

# If services are already running, run a quick test
make smoke-test-quick

# Tail NATS events in real-time
make tail-events
```

## Smoke Test

The smoke test (`scripts/smoke_test.sh`) performs end-to-end verification:

1. **Starts docker compose** - Builds and starts all services
2. **Waits for health** - Ensures postgres, nats, api, and worker are healthy
3. **Enables modules** - Activates coinbase and polymarket modules via API
4. **Waits for data** - Allows 60 seconds for data collection
5. **Checks Postgres** - Verifies messages are stored in the database
6. **Checks NATS** - Verifies messages are flowing through the message bus
7. **Reports results** - Shows pass/fail for each check

### Usage

```bash
# Full smoke test (default)
./scripts/smoke_test.sh

# Skip starting services (assumes already running)
./scripts/smoke_test.sh --skip-start

# Custom wait time for data collection
./scripts/smoke_test.sh --wait-time 120
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPOSE` | `docker compose` | Docker compose command |
| `WAIT_TIME` | `60` | Seconds to wait for data collection |
| `FEED_INTERNAL_TOKEN` | `dev-internal-token` | API authentication token |

### Expected Output

```
==============================================
       FeedEater Smoke Test
==============================================

[INFO] Starting docker compose...
[INFO] Waiting for services to be healthy...
[PASS] postgres is healthy
[PASS] nats is healthy
[PASS] api is healthy
[PASS] worker is healthy

[INFO] Enabling coinbase module...
[INFO] Enabling polymarket module...

[INFO] Waiting 60s for data collection...

[INFO] Checking Postgres for data...
[INFO] Messages in database: 42
[PASS] Postgres has messages

[INFO] Checking NATS for stream data...
[INFO] NATS total messages: 42
[PASS] NATS has messages

[PASS] API is healthy
[PASS] Modules are enabled

==============================================
              Test Summary
==============================================

Passed: 6
Failed: 0

All tests passed!
```

## Data Flow Verifier

The data flow verifier (`scripts/verify_data_flow.ts`) provides real-time monitoring of NATS events.

### Usage

```bash
# Tail all FeedEater events
make tail-events

# Tail events for a specific module
make tail-coinbase
make tail-polymarket

# Direct usage with options
npx ts-node scripts/verify_data_flow.ts --url nats://localhost:4222
npx ts-node scripts/verify_data_flow.ts --subjects "feedeater.coinbase.*,feedeater.polymarket.*"
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--url` | `nats://localhost:4222` | NATS server URL |
| `--subjects` | `feedeater.*.tradeExecuted,feedeater.*.messageCreated` | Comma-separated subjects |
| `--help` | - | Show help message |

### Expected Output

```
==============================================
     FeedEater Data Flow Verifier
==============================================

NATS URL: nats://localhost:4222
Subjects: feedeater.*.tradeExecuted, feedeater.*.messageCreated

Press Ctrl+C to stop and show statistics.

----------------------------------------------

Connecting to NATS...
Connected to NATS

Subscribing to: feedeater.*.tradeExecuted
Subscribing to: feedeater.*.messageCreated

Listening for events...

[2026-02-15 00:30:15.123] tradeExecuted    | coinbase BTC-USD BUY 0.0500 @ 98500.00 ($4925.00)
[2026-02-15 00:30:15.456] messageCreated   | polymarket: Will BTC reach $100K by March?
[2026-02-15 00:30:16.789] tradeExecuted    | coinbase ETH-USD SELL 1.2000 @ 3450.00 ($4140.00)
```

### Statistics

When you press Ctrl+C, the verifier shows statistics:

```
--- Statistics ---
Total messages: 156
Elapsed time: 120.5s
Rate: 1.29 msg/s
Errors: 0

By module:
  coinbase: 89
  polymarket: 67

By event type:
  tradeExecuted: 102
  messageCreated: 54
```

## Makefile Targets

| Target | Description |
|--------|-------------|
| `make smoke-test` | Run full smoke test (starts services) |
| `make smoke-test-quick` | Run smoke test without starting services |
| `make tail-events` | Tail all NATS events |
| `make tail-<module>` | Tail events for specific module (e.g., `make tail-coinbase`) |

## Troubleshooting

### Services not starting

```bash
# Check service status
make status

# View logs
make logs

# View logs for specific service
make logs-api
make logs-worker
```

### No data in Postgres

1. Check if modules are enabled:
   ```bash
   curl -H "Authorization: Bearer dev-internal-token" http://localhost:4000/api/modules
   ```

2. Check worker logs for errors:
   ```bash
   make logs-worker
   ```

3. Verify API keys are configured (for modules that require them):
   ```bash
   cat .env | grep -E "(COINBASE|POLYMARKET|KALSHI)_API"
   ```

### No NATS messages

1. Check NATS health:
   ```bash
   curl http://localhost:8222/healthz
   ```

2. Check NATS monitoring:
   ```bash
   curl http://localhost:8222/varz
   ```

3. Verify NATS connection in worker:
   ```bash
   make logs-worker | grep -i nats
   ```

### Module not collecting data

1. Check module status:
   ```bash
   curl -H "Authorization: Bearer dev-internal-token" http://localhost:4000/api/modules/<module-name>
   ```

2. Enable the module:
   ```bash
   curl -X POST -H "Authorization: Bearer dev-internal-token" http://localhost:4000/api/modules/<module-name>/enable
   ```

3. Check for module-specific errors in worker logs:
   ```bash
   make logs-worker | grep -i <module-name>
   ```

## CI Integration

To run smoke tests in CI:

```yaml
# GitHub Actions example
jobs:
  smoke-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run smoke test
        run: |
          make smoke-test
        env:
          WAIT_TIME: 90
```

Note: Some modules require API keys to function. For CI, you may want to test only modules that work without authentication (like RSS feeds) or provide test API keys via secrets.
