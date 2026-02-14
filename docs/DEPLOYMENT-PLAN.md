# FeedEater — Deployment Plan

**Version:** 1.0  
**Updated:** 2026-02-14

## Overview

Deploy the FeedEater stack on the Mac mini (192.168.0.188) as the primary data collection infrastructure. All financial and social data ingestion runs here.

## Target Environment

- **Host:** Mac mini (192.168.0.188), macOS, ARM64
- **Docker:** Docker Desktop for Mac
- **Storage:** Local disk (sufficient for Postgres + NATS)
- **Network:** LAN access to quato (192.168.0.134) for L1/L2 RPC

## Pre-Deployment Checklist

- [ ] Docker + Docker Compose installed and running
- [ ] Generate `FEED_SETTINGS_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- [ ] Generate `FEED_INTERNAL_TOKEN`: random string for worker↔API auth
- [ ] Create `.env` from `docs/ENVIRONMENT.md` template
- [ ] Verify network access to quato RPC endpoints (8545, 8546, 8645, 8646)

## Deployment Steps

### Phase 1: Core Stack
1. `docker compose up -d postgres nats` — start data stores
2. Verify Postgres healthy: `docker compose exec postgres pg_isready`
3. Verify NATS healthy: `curl http://localhost:8222/healthz`
4. `docker compose up -d api worker` — start platform services
5. Verify API: `curl http://localhost:3000/health`
6. `docker compose up -d web` — start dashboard UI

### Phase 2: CEX Modules
7. Enable `coinbase` module via API/settings
8. Enable `kraken` module via API/settings
9. Enable `binance` module via API/settings
10. Verify data flowing: check NATS subjects, check Postgres rows
11. Monitor for 1 hour — confirm stable ingestion

### Phase 3: Prediction Market Modules
12. Configure Kalshi API credentials (encrypted in settings)
13. Enable `kalshi` module
14. Enable `polymarket` module
15. Verify trade data flowing on NATS subjects

### Phase 4: DEX Modules
16. Configure Ethereum L1 RPC: `ws://192.168.0.134:8546` (local node, free)
17. Enable `uniswap` module
18. Configure Infura keys for Arbitrum + Polygon:
    - Arbitrum: Key 1 (`7792954778014ea7a9d6b88268ef912c`)
    - Polygon: Key 2 (`b5ef538a6a4e4b799dad3b097ede45e7`)
    - Remaining keys 3-5 as round-robin failover
19. Enable `arbitrum-dex` module
20. Enable `polygon-dex` module
21. Base/Aerodrome: DEFERRED until Base L2 node synced (currently 6.9%)

### Phase 5: Event Resolution
22. Enable `event-resolver` module
23. Verify cross-venue event mapping
24. Enable `replay` module for historical backfill

## RPC Configuration

| Chain | RPC Endpoint | Source | Rate Limit |
|-------|-------------|--------|------------|
| Ethereum L1 | ws://192.168.0.134:8546 | Local Nethermind | Unlimited |
| Ethereum L1 (HTTP) | http://192.168.0.134:8545 | Local Nethermind | Unlimited |
| Base L2 | ws://192.168.0.134:8646 | Local op-geth | Unlimited (when synced) |
| Arbitrum | Infura Key 1 | Infura | 3M/day |
| Polygon | Infura Key 2 | Infura | 3M/day |
| Failover | Infura Keys 3-5 | Infura | 3M/day each |

## Monitoring

- FeedEater web dashboard: `http://localhost:3001` (or configured port)
- NATS monitoring: `http://localhost:8222/`
- Postgres: `docker compose exec postgres psql -U feedeater -c "SELECT module, count(*) FROM messages GROUP BY module"`
- Health check: `curl http://localhost:3000/health`

## Rollback

If deployment fails at any phase:
1. `docker compose down` — stop everything
2. `docker volume rm feedeater_postgres_data` — nuke Postgres if corrupted
3. Start from Phase 1

## Post-Deployment

Once all modules are ingesting:
- External consumers can subscribe to NATS subjects
- Historical data accumulates in Postgres
- Event resolver maps cross-venue equivalents
- Replay engine available for backtesting on collected data
