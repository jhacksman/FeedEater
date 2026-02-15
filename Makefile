COMPOSE ?= docker compose

.PHONY: up down ps logs build pull restart db-push status health config clean smoke-test smoke-test-quick tail-events enable-modules tail-trades

# Start all services (build if needed)
up:
	$(COMPOSE) up -d --build

# Stop all services
down:
	$(COMPOSE) down

# Show running containers
ps:
	$(COMPOSE) ps

# Follow logs from all services
logs:
	$(COMPOSE) logs -f --tail=200

# Build all images
build:
	$(COMPOSE) build

# Pull latest base images
pull:
	$(COMPOSE) pull

# Restart all services
restart:
	$(COMPOSE) restart

# Creates/updates platform tables using Prisma (idempotent).
db-push:
	$(COMPOSE) run --rm --workdir /app api npx prisma db push --schema packages/db/prisma/schema.prisma

# Show service status with health
status:
	@echo "=== FeedEater Service Status ==="
	@$(COMPOSE) ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
	@echo ""
	@echo "=== Health Checks ==="
	@$(COMPOSE) ps --format "{{.Name}}: {{.Status}}" | grep -E "(healthy|unhealthy|starting)" || echo "No health status available"

# Check health of all services
health:
	@echo "Checking service health..."
	@$(COMPOSE) ps --format "{{.Name}}\t{{.Status}}"

# Validate docker-compose.yml
config:
	$(COMPOSE) config

# Stop and remove all containers, networks, volumes
clean:
	$(COMPOSE) down -v --remove-orphans

# View logs for specific service (usage: make logs-api, make logs-worker, etc.)
logs-%:
	$(COMPOSE) logs -f --tail=200 $*

# Restart specific service (usage: make restart-api, make restart-worker, etc.)
restart-%:
	$(COMPOSE) restart $*

# Shell into specific service (usage: make shell-api, make shell-worker, etc.)
shell-%:
	$(COMPOSE) exec $* sh

# Run smoke test to verify data flows through the system
smoke-test:
	@echo "Running FeedEater smoke test..."
	./scripts/smoke_test.sh

# Run smoke test without starting services (assumes already running)
smoke-test-quick:
	@echo "Running FeedEater smoke test (skip start)..."
	./scripts/smoke_test.sh --skip-start --wait-time 30

# Tail NATS events in real-time
tail-events:
	@echo "Tailing FeedEater NATS events..."
	@echo "Press Ctrl+C to stop."
	npx ts-node scripts/verify_data_flow.ts

# Tail events for specific module (usage: make tail-coinbase, make tail-polymarket)
tail-%:
	@echo "Tailing FeedEater NATS events for $*..."
	npx ts-node scripts/verify_data_flow.ts --subjects "feedeater.$*.*"

# Enable all financial modules via FeedEater API
enable-modules:
	@echo "Enabling all financial modules..."
	npx tsx scripts/enable_modules.ts

# Tail tradeExecuted + messageCreated events (60s summary)
tail-trades:
	@echo "Tailing trade events (60s)..."
	npx tsx scripts/tail_trades.ts


