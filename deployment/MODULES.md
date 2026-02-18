# FeedEater — Enabled Modules & Deployment Status

Last updated: 2025-02-18

## Mac Mini Deployment (192.168.0.134)

The Mac mini runs a local Base L2 node at `ws://192.168.0.134:8646` (HTTP: `http://192.168.0.134:8646`).
Docker Compose orchestrates all FeedEater services including module-init which auto-enables modules on startup.

## Currently Enabled Modules

| Module | Type | RPC / API Requirement | Default Endpoint | Mac Mini Status |
|--------|------|-----------------------|-------------------|-----------------|
| `kalshi` | Prediction Market | HTTPS REST API | `https://api.elections.kalshi.com` | Enabled via init-modules.sh; optional API key/secret |
| `polymarket` | Prediction Market | HTTPS REST API | `https://clob.polymarket.com` | Enabled via init-modules.sh; public data, no key required |
| `uniswap-base` | DEX (Base L2) | WebSocket RPC | `ws://192.168.0.134:8646` | Enabled via init-modules.sh; uses local Base node |
| `aerodrome-base` | DEX (Base L2) | WebSocket RPC | `ws://192.168.0.134:8646` | Enabled via init-modules.sh; uses local Base node |

## Module Details

### uniswap-base

- **PR**: #66 (merged)
- **Chain**: Base L2 (chain ID 8453)
- **Protocol**: Uniswap V3
- **RPC env var**: `UNISWAP_BASE_RPC_URL`
- **docker-compose.yml**: Passed to both `api` and `worker` services (line 63, 103)
- **init-modules.sh**: Enabled at line 58-62; sets `enabled=true` and `rpcUrl` from env
- **.env.example**: `UNISWAP_BASE_RPC_URL=ws://192.168.0.134:8646` (line 67)
- **Watched pools**:
  - `0xd0b53D9277642d899DF5C87A3966A349A798F224` — WETH/USDC 0.05%
  - `0x6c561B446416E1A00E8E93E221854d6eA4171372` — WETH/USDC 0.3%
- **Jobs**: `stream` (every 1m), `collectSwaps` (every 5m)
- **NATS subjects**: `feedeater.uniswap-base.tradeExecuted`, `feedeater.uniswap-base.messageCreated`

### aerodrome-base

- **PR**: #68 (merged)
- **Chain**: Base L2 (chain ID 8453)
- **Protocol**: Aerodrome (Solidly-fork AMM)
- **RPC env var**: `AERODROME_BASE_RPC_URL`
- **docker-compose.yml**: Passed to both `api` and `worker` services (line 64, 104)
- **init-modules.sh**: Enabled at line 52-56; sets `enabled=true` and `rpcUrl` from env
- **.env.example**: `AERODROME_BASE_RPC_URL=ws://192.168.0.134:8646` (line 72)
- **Watched pools**:
  - `0xcDAC0d6c6C59727a65F871236188350531885C43` — WETH/USDC volatile
  - `0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d` — USDC/USDbC stable
  - `0x44Ecc644449fC3a9858d2007CaA8CFAa4C561f91` — WETH/cbETH
- **Jobs**: `stream` (every 1m), `collectSwaps` (every 5m)
- **NATS subjects**: `feedeater.aerodrome-base.tradeExecuted`, `feedeater.aerodrome-base.messageCreated`

### kalshi

- **PR**: Pre-existing
- **Type**: HTTPS REST polling
- **API env vars**: `KALSHI_API_KEY`, `KALSHI_API_SECRET` (optional — public data works without)
- **init-modules.sh**: Enabled at line 39-46
- **Jobs**: Market discovery, trade polling

### polymarket

- **PR**: Pre-existing
- **Type**: HTTPS REST polling
- **API env var**: `POLYMARKET_API_KEY` (optional — public data works without)
- **init-modules.sh**: Enabled at line 48-50; also sets `collectAllTrades=true`
- **Jobs**: Market discovery, trade polling

## Deployment Verification

Run the health-check script to verify modules are configured:

```bash
./scripts/check-modules.sh
```

This checks:
1. Docker Compose config has RPC URLs for both Base modules
2. init-modules.sh enables all four modules
3. .env.example documents all required env vars
4. Running containers (if deployment is active) include expected services

## Base L2 Sync Status

> **uniswap-base** and **aerodrome-base** require the Base L2 node (`ws://192.168.0.134:8646`) — expected to be fully synced by **2026-02-18 ~9 AM PT**.

Until the node is fully synced, these modules will connect but may return stale or incomplete data. The `check-modules.sh --live` health check will still pass as long as the WebSocket is reachable; it does not verify chain sync progress.

## Deployment

Run the Mac mini deployment script to pull, restart, and verify:

```bash
./scripts/deploy-mac-mini.sh
```

This performs:
1. `git pull origin main`
2. `docker-compose pull`
3. `docker-compose up -d --remove-orphans`
4. 10s startup wait
5. `./scripts/check-modules.sh --live` health verification

## RPC Requirements Summary

| Endpoint | Protocol | Used By | Network |
|----------|----------|---------|---------|
| `ws://192.168.0.134:8646` | WebSocket JSON-RPC | uniswap-base, aerodrome-base | Base L2 (8453) |
| `https://api.elections.kalshi.com` | HTTPS REST | kalshi | Internet |
| `https://clob.polymarket.com` | HTTPS REST | polymarket | Internet |
