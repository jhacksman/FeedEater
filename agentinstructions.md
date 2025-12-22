# This file contains instructions for AI Agents contributing to the FeedEater project

# Anatomy of FeedEater

## Anatomy of a FeedEater module 
FeedEater is designed to be maximally modular: each feed/service/protocol being injested as well as each filter and summarization process can be it's own thing but all interoprate off a single shared and normalized message bus. 

Each module gets: 
- It's own Postgres schema for private data persistance
    This is mostly for collectors storing raw extracts from data sources as well as thinker modules storing AI summaries or even vector databases for RAG. 
- A standardized settings/environment-variable engine 
    Stores and exposes each module's settings to users via FeedEater's web interface, as well as handling the secure storage and handling of module secrets. 
- Namespace on the event bus
    Modules can leverage the inbuilt event bus internally or to interoperate with other modules
- A robust job queue 
    Modules can define jobs which can be scheduled and/or triggered by events on the bus. 
    FeedEater's web interface exposes job history and status as well as allowing users to trigger, enable, disable, etc.. jobs
- The ability to read, write, and tag messages on the unified message bus
    - This is an abstration layer ensuring modules can interoprate without any specific compatability for each-other 
    - Modules can also add tags (key-value pairs) to messages on the unified message bus to assist with understanding and decision-making even on messages they did not origionate. 
- The ability to make AI calls 
    FeedEater's install includes a private OLAMA and ComfyUI instance for AI processing/filtering/etc. 
- Ability to write to the unified log queues
    Modules get unified telemetry (operational, warning, error) that is helpfully exposed in real-time to the user via FeedEater's web interface. 
- Ability to have a dashboard card within FeedEater's web interface
    Modules can output data, show status or live feeds, request human logins... whatever they want within their designated space in FeedEater's web interface

### Non-negotiables
- **Do not modify** `agentinstructions.md`.
- **No secrets in git**: all secrets/config via `.env` and module settings; ensure `.env` is gitignored.
- **Docker-first**: everything must run via `docker-compose`.
- **Re-deployable**: changes must be safe to apply repeatedly on an AI-ready Unix server like a DJX Spark (idempotent deploy + migrations).
- **TypeScript strict**: keep strict mode enabled; avoid `any`.
- **Fail fast**: unexpected states should throw with clear logs.

### Platform architecture
- **Event bus**: NATS **JetStream**. Subjects use `feedeater.<module>.<event>`.
- **Job queue**: **BullMQ** on Redis. Prefer one queue per module `mod:<moduleName>`.
- **Job UI**: **BullBoard** mounted in the API at `/bullboard` and embedded in the Next.js UI via iframe.
- **DB**: Postgres with core tables in `public` and private per-module schemas `mod_<name>`.

### Module anatomy (required)
Each module under `modules/<moduleName>/` must provide:
- `module.json` manifest (name/version/namespace/jobs/UI cards)
- typed `settings.ts` (settings + secrets)
- jobs (scheduled/event/manual)
- ability to read/write/tag normalized messages
- telemetry via the platform logger
- private persistence in its own Postgres schema (optional Prisma schema or SQL migrations)

### Interop contract
- Modules must not directly call each other or write in each-other’s schemas.
- Modules may read each-other's schemas
- All cross-module communication happens via:
  - normalized message envelopes on the bus
  - tags (key/value) for enrichment and routing

### Deployment requirements
- Must be deployable with **Make and/or Ansible**.
- Production runs fully under `docker-compose` behind a reverse proxy so the UI is a **single pane of glass**.
- Any server configuration changes must be represented in Ansible playbooks/roles.