# This file contains instructions for AI Agents contributing to the FeedEater project

### Non-negotiables
- **Do not modify** `agentinstructions.md`.
- **Remember this** always re-read `agentinstructions.md` back into context before making changes. 
- **No secrets in git**: all secrets/config via `.env` and module settings; ensure `.env` is gitignored.
- **Docker-first**: everything must run via `docker-compose`.
- **Re-deployable**: changes must be safe to apply repeatedly on an AI-ready Unix server like a DJX Spark (idempotent deploy + migrations).
- **TypeScript strict**: keep strict mode enabled; avoid `any`.
- **Use NATS**: Do not re-introduce BullMQ/Redis/BullBoard
- **Workers are cattle**: All important data which resides on the workers or in NATs must be replicated to the Postgres storage layer and care should be taken to ensure any missing data is read back into NATs/workers at start time. 
- **Fail fast**: unexpected states should throw with clear logs.
- **Settings over Constants**: use of module settings with default values are preferred over the hard-coding of constants for anything that could possibly need to be tinkered with at runtime. 
- **Use the glossary**: Always use the terminology found in the GLOSSARY.md docs file. The creation of new concepts should be rare and limited to major feature or functionality changes, but always make sure to keep the glossary updated. 

## Anatomy of FeedEater 
FeedEater is designed to be maximally modular: each feed/service/protocol being injested as well as each filter and summarization process can be it's own thing but all interoprate off a single shared and normalized message bus. 

Each module gets: 
- It's own Postgres schema for private data persistance
    This is mostly for collectors storing raw extracts from data sources as well as thinker modules storing AI summaries or even vector databases! 
- A standardized settings/environment-variable engine 
    Stores and exposes each module's settings to users via FeedEater's web interface, as well as handling the secure storage and handling of module secrets. 
- Namespace on the event bus
    Modules can leverage the inbuilt NATs bus internally or to interoperate with other modules
- A lightweight job queue 
    A small job queue implemented in NATs allows modules to define jobs which can be scheduled and/or triggered manually by users. Job logs and statuses are all handled and elegently revealed to the user. 
- The ability to read and emit *immutable* unified messages readable by all other modules. 
    - This is an abstration layer ensuring modules can interoprate without any specific compatability for each-other 
- Modules can share and contribute understanding and information on messages by adding tags (key-value pairs) to messages on the unified message bus, even when they did not origionate the message. 
    - Tags are generally used for filtering or to factor into context calculations
- The ability to track a summary of the conversation/thread/topic that a message came from, and have that context evolve as the conversation continues or the module's understanding of the conversation changes. 
    - Modules can report contexts, link messages to contexts, and re-state/update contexts.
- First-class AI support
    - The FeedEater system provides API endpoints for submitting prompts to OLLAMA models by abstracting away API key and network connection strings
    - This is primarally for AI summarization and symantic search of contexts
    
- Ability to write to the unified log queues
    Modules get unified telemetry (operational, warning, error) that is helpfully exposed in real-time to the user via FeedEater's web interface
- Ability to have a dashboard card within FeedEater's web interface
    Modules can output data, show status or live feeds, request human logins... whatever they want within their designated space in FeedEater's web interface

### Platform architecture
- **Event bus**: NATS **JetStream**. Subjects use `feedeater.<module>.<event>`.
- **Jobs**: Worker handles scheduling and processing job runs. NATS job subjects: ```feedeater.jobs.<module>.<queue>.<job>
- **DB**: Postgres with core tables (```bus_messages```, ```bus_context_messages```, ```job_runs```, ```job_states```) are in `public` and private per-module schemas `mod_<name>`.

### Module anatomy (required)
Each module under `modules/<moduleName>/` must provide:
- `module.json` manifest (name/version/namespace/jobs/UI cards)
- typed `settings.ts` (settings + secrets)

Each module MAY
- make external API calls 
- define jobs (scheduled/manual)
    - Jobs may return ```metrics``` (key-value pairs) and have them rendered in table form on the job page.
- read/write normalized messages
- read/write and update contexts
    - Using `ContextUpdated` endpoint
- link messages to contexts
    - Using `contextRef` endpoint
- emit telemetry via the platform logger
- persist private data in its own Postgres schema (optional Prisma schema or SQL migrations)

### Using AI
- The system ensures an OLLAMA model is accessible to all modules and abstracts away networking/auth.
- A single OLLAMA model is set system-wide to ensure the model can be kept in VRAM when hosting on local hardware and that all embeds are compatible across modules. 
- Modules are responsible for building prompts and interperating the responses 
- System endpoints for AI are: 
    - ```/api/internal/ai/summary```
    - ```/api/internal/ai/embedding```

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