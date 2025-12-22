## FeedEater architecture (skeleton)

### Core concepts
- **Modules are plugins** under `modules/`. They should be independently deployable/disableable and should not tightly couple to other modules.
- **Interop is via the bus**: NATS JetStream subjects follow `feedeater.<module>.<event>`.
- **Messages are normalized**: everything ingested becomes a `NormalizedMessage` payload with optional content and a `tags` bag.
- **Tags are the primary enrichment mechanism**: modules add key/value tags to messages to assist filtering, routing, and summarization.

### Non-negotiable interop contract
- **No cross-module database access**: modules must not read or write any other module’s Postgres schema.
- **No direct module-to-module imports/calls**: if a module needs something, it should be expressed as bus events and/or tags.

### Runtime dependencies
- Postgres: platform tables + per-module private schemas
- NATS JetStream: event bus
- Redis + BullMQ: job queue


