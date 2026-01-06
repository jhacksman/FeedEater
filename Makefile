COMPOSE ?= docker compose

.PHONY: up down ps logs build pull restart db-push

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=200

build:
	$(COMPOSE) build

pull:
	$(COMPOSE) pull

restart:
	$(COMPOSE) restart

# Creates/updates platform tables using Prisma (idempotent).
db-push:
	$(COMPOSE) run --rm --workdir /app api npx prisma db push --schema packages/db/prisma/schema.prisma


