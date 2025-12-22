## example module

This module exists as a minimal reference implementation.

### What it does
- Schedules a BullMQ job (`tick`) every minute
- Publishes `feedeater.example.messageCreated` with a `NormalizedMessage` payload
- Consumes that event and enqueues `processMessage`

### Settings
- `enabled` (boolean): enable/disable the module
- `demoSecret` (secret string): stored encrypted-at-rest by FeedEater


