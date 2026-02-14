# FeedEater — Module Status

**Updated:** 2026-02-14

## Financial Modules

### CEX
| Module | Source | Tests | Deployed | Notes |
|--------|--------|-------|----------|-------|
| `coinbase` | PR #26 | ✅ Pass | ❌ | Ready to deploy |
| `kraken` | PR #26 | ✅ Pass | ❌ | Ready to deploy |
| `binance` | PR #26 | ✅ Pass | ❌ | Ready to deploy |

### DEX
| Module | Chain | Source | Deployed | Notes |
|--------|-------|--------|----------|-------|
| `uniswap` | Ethereum L1 | Existing | ❌ | Needs L1 WS RPC config |
| `arbitrum-dex` | Arbitrum | Existing | ❌ | Needs Infura key config |
| `polygon-dex` | Polygon | Existing | ❌ | Needs Infura key config |
| Base/Aerodrome | Base | ❌ Not built | ❌ | Blocked on Base L2 sync (6.9%) |

### Prediction Markets
| Module | Source | Deployed | Notes |
|--------|--------|----------|-------|
| `kalshi` | Existing | ❌ | Needs API credentials |
| `polymarket` | Existing | ❌ | Ready |

### Cross-Venue
| Module | Purpose | Deployed | Notes |
|--------|---------|----------|-------|
| `event-resolver` | Maps equivalent events across venues | ❌ | Depends on venue modules running |
| `replay` | Historical replay + lead-lag analysis | ❌ | Depends on accumulated data |

## Social Modules
All built, none deployed. Lower priority than financial modules.

## Priority Order
1. Core stack (Postgres, NATS, API, worker, web)
2. CEX modules (coinbase, kraken, binance)
3. Prediction markets (kalshi, polymarket)
4. DEX — L1 (uniswap via local node)
5. DEX — L2 (arbitrum, polygon via Infura)
6. Event resolver
7. Replay engine
8. Base/Aerodrome (when L2 synced)

## Cleanup Required
- [ ] Remove `aromer-strategy` module — violates separation principle. FeedEater has no knowledge of downstream consumers.
- [ ] Remove `market-maker-sim` module if it references external consumers
