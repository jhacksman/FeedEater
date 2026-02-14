COMPOSE ?= docker compose

.PHONY: up down ps logs build pull restart db-push status health config clean

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


