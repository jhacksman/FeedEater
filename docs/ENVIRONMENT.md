## Environment variables

FeedEater is configured entirely via environment variables (typically through a `.env` file used by `docker compose`).

### Required
- `DATABASE_URL`: Postgres connection string
- `REDIS_URL`: Redis connection string (BullMQ backend)
- `NATS_URL`: NATS connection string
- `FEED_SETTINGS_KEY`: **32-byte key**, base64-encoded, used to encrypt secrets at rest
- `FEED_INTERNAL_TOKEN`: internal bearer token used by the worker to fetch decrypted module secrets from the API

Generate `FEED_SETTINGS_KEY` like:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Common compose defaults

```bash
POSTGRES_USER=feedeater
POSTGRES_PASSWORD=feedeater
POSTGRES_DB=feedeater
DATABASE_URL=postgresql://feedeater:feedeater@postgres:5432/feedeater
REDIS_URL=redis://redis:6379
NATS_URL=nats://nats:4222
FEED_SETTINGS_KEY=<generated>
FEED_INTERNAL_TOKEN=<random_string>
```


