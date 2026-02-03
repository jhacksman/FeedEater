# Slack Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the Slack module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The Slack module collects messages from Slack workspaces and organizes them into FeedEater's Context system. Threads become their own contexts with AI-generated summaries.

## Architecture

### Data Flow

1. **collect job** (every 5 min): Fetches messages from Slack API -> stores in `mod_slack.slack_messages` -> publishes `MessageCreated` events to NATS
2. **updateContexts job** (every 30 min): Finds active threads -> uses semantic search to gather relevant messages -> generates AI summaries -> publishes `ContextUpdated` events

### Context Key Format

`{channelId}:{threadTs}` - e.g., `C01ABC123DE:1234567890.123456`

Non-threaded messages use a template-based summary instead of AI generation.

### Key Files

- `src/ingest.ts` - Core `SlackIngestor` class with all collection and context logic
- `src/runtime.ts` - Job handlers that wire up the ingestor
- `module.json` - Job definitions, settings schema, UI cards
- `settings.ts` - TypeScript types for settings (mirrors module.json)

## Conventions

### Settings

All settings come from the FeedEater settings registry, not environment variables. The module fetches them via `ctx.fetchInternalSettings("slack")`.

Secrets (like `botToken`) are encrypted at rest and only decrypted when fetched via the internal API.

### Database

- Private schema: `mod_slack`
- Tables: `slack_messages`, `slack_message_embeddings`
- Use `ensureSchema()` to create tables on first run
- Never access other modules' schemas

### Bus Events

- Emit `MessageCreated` on `feedeater.slack.messageCreated`
- Emit `ContextUpdated` on `feedeater.slack.contextUpdated`
- Use `subjectFor("slack", "eventName")` helper

### Logging

Use the `log()` method which publishes to `feedeater.slack.log` for visibility in the FeedEater UI.

## What NOT To Do

- **Don't hardcode tokens** - Use the settings registry
- **Don't skip deduplication** - The `collectAndPersist` method checks `(xmax = 0)` to detect true inserts vs updates
- **Don't assume channel access** - The bot must be invited to private channels
- **Don't fetch too much history** - Respect `lookbackHours` setting to avoid API rate limits
- **Don't block on embedding failures** - Log and continue; embeddings are nice-to-have

## Lessons Learned

### Slack API Quirks

- Channel IDs are not channel names (e.g., `C01ABC123DE` not `#general`)
- Thread timestamps (`thread_ts`) identify threads, not individual messages
- Bot tokens start with `xoxb-`, user tokens with `xoxp-`
- Rate limits are per-workspace, not per-channel

### Context Summarization

- Prior summaries are used as query vectors to find semantically relevant messages
- Fallback to recency-based selection if embeddings fail
- JSON parsing of AI responses can fail; always have a plaintext fallback
- Truncate prompts to ~8000 chars to avoid context window issues

### Embedding Dimensions

- Default is 4096 (Ollama's nomic-embed-text)
- Changing dimensions requires recreating the embeddings table
- IVFFlat indexes only work for dims <= 2000

## Testing Locally

1. Set up FeedEater's docker-compose environment
2. Configure Slack settings in the UI (bot token, channel IDs)
3. Trigger a manual `collect` job from the UI
4. Check logs panel for errors
5. Verify messages appear in the feed

## Future Improvements

- [ ] Support for Slack Connect channels
- [ ] Reaction tracking (likes/emoji)
- [ ] File/attachment handling
- [ ] Real-time Socket Mode instead of polling
- [ ] Better topic detection within long threads
