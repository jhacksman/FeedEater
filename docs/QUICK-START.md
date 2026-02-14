# FeedEater Quick Start Guide

Get FeedEater running in 5 steps.

## Prerequisites

- Docker and Docker Compose installed
- Git installed
- (Optional) API keys for financial modules you want to enable

## Step 1: Clone the Repository

```bash
git clone https://github.com/jhacksman/feedeater.git
cd feedeater
```

## Step 2: Configure Environment

Copy the example environment file and edit it with your settings:

```bash
cp .env.example .env
```

Generate a secure settings key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Edit `.env` and replace `FEED_SETTINGS_KEY` with the generated value. Also set `FEED_INTERNAL_TOKEN` to a random string.

For financial modules, add your API keys to the appropriate variables (COINBASE_API_KEY, KRAKEN_API_KEY, etc.).

## Step 3: Start Services

```bash
make up
```

This builds and starts all services: postgres (pgvector), nats (jetstream), api, worker, web, and proxy.

Wait for all services to become healthy:

```bash
make status
```

## Step 4: Initialize Database

Run the Prisma migration to create database tables:

```bash
make db-push
```

## Step 5: Access the Web UI

Open your browser to http://localhost:666

The web UI allows you to configure modules, view collected data, and manage feeds.

## Useful Commands

| Command | Description |
|---------|-------------|
| `make up` | Start all services |
| `make down` | Stop all services |
| `make logs` | Follow logs from all services |
| `make status` | Show service status and health |
| `make restart` | Restart all services |
| `make config` | Validate docker-compose.yml |
| `make clean` | Stop and remove all containers and volumes |
| `make logs-api` | Follow logs for API service only |
| `make shell-worker` | Shell into worker container |

## Enabling Financial Modules

FeedEater supports several financial data modules. To enable them, add the corresponding API keys to your `.env` file:

**CEX Modules:**
- Coinbase: `COINBASE_API_KEY`, `COINBASE_API_SECRET`
- Kraken: `KRAKEN_API_KEY`, `KRAKEN_API_SECRET`
- Binance: `BINANCE_API_KEY`, `BINANCE_API_SECRET`

**Prediction Markets:**
- Kalshi: `KALSHI_API_KEY`
- Polymarket: `POLYMARKET_API_KEY`

**DEX Modules:**
- Uniswap: `UNISWAP_RPC_URL` (Ethereum WebSocket RPC, e.g., `wss://mainnet.infura.io/ws/v3/YOUR_KEY`)

After adding keys, restart the services:

```bash
make restart
```

## Troubleshooting

**Services not starting:**
```bash
make logs
```
Check for error messages in the logs.

**Database connection issues:**
```bash
make logs-postgres
```
Ensure postgres is healthy before other services start.

**Health check failures:**
```bash
make health
```
Services may take 30-60 seconds to become healthy after startup.

**Reset everything:**
```bash
make clean
make up
make db-push
```
