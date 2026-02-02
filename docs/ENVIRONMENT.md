## Environment variables

FeedEater is configured entirely via environment variables (typically through a `.env` file used by `docker compose`).

### Required
- `DATABASE_URL`: Postgres connection string
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
NATS_URL=nats://nats:4222
FEED_SETTINGS_KEY=<generated>
FEED_INTERNAL_TOKEN=<random_string>
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_SUMMARY_MODEL=llama3.1:8b
OLLAMA_EMBED_MODEL=llama3.1:8b
OLLAMA_EMBED_DIM=4096
```

### Optional
- `OLLAMA_BASE_URL`: External Ollama base URL (omit to disable).
- `OLLAMA_SUMMARY_MODEL`: Ollama model name for context summaries.
- `OLLAMA_EMBED_MODEL`: Ollama model name for embeddings.
- `OLLAMA_EMBED_DIM`: Embedding vector size (must match Ollama embedding length).

### System settings (optional)
- `ollama_embed_dim`: Overrides embedding dimension for platform Context embeddings (stored in settings table).
- `ollama_base_url`: System-wide Ollama base URL (preferred over env).
- `ollama_summary_model`: System-wide summary model name.
- `ollama_embed_model`: System-wide embedding model name.
- `context_top_k`: System-wide top-K message retrieval for context updates.
- `dashboard_show_ids`: Show message/context IDs in the dashboard when true.


