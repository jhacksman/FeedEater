# Mastodon Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the Mastodon module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The Mastodon module collects toots (posts) from a user's Mastodon home timeline and organizes them into FeedEater's Context system. Reply threads become their own contexts with AI-generated summaries.

## Why Mastodon is EASY

Mastodon has one of the **best-documented APIs** in social media:
- Official docs: https://docs.joinmastodon.org/api/
- OpenAPI spec available
- Consistent REST conventions
- Predictable rate limiting with headers
- No weird auth quirks (standard OAuth 2.0)

This module should be **simpler** than Slack, Twitter, or Facebook.

## ActivityPub Background

Mastodon is built on **ActivityPub**, an open W3C standard for federated social networking. Key implications:

1. **No central server**: Each instance is independent. User `@alice@mastodon.social` and `@bob@fosstodon.org` are on different servers.
2. **Federation**: Instances exchange content via ActivityPub. When you follow someone on another instance, their posts flow to your instance.
3. **Instance-local IDs**: A toot's `id` is only unique within its originating instance. The `uri` field is globally unique.
4. **Conversation IDs are local**: The `conversation_id` field is assigned by the viewing instance, not the originating instance. Two users on different instances may see different conversation IDs for the same thread.

**For FeedEater**: We primarily use the user's home timeline, which is already aggregated by their instance. We don't need to implement ActivityPub directly — just consume the REST API.

## Architecture

### Data Flow

1. **collect job** (every 5 min): Fetches toots from `GET /api/v1/timelines/home` → stores in `mod_mastodon.mastodon_statuses` → publishes `StatusCreated` events to NATS
2. **updateContexts job** (every 30 min): Finds active threads → uses semantic search to gather relevant toots → generates AI summaries → publishes `ContextUpdated` events

### Context Key Format

`{instanceHost}:{conversationId}` — e.g., `mastodon.social:123456789`

Non-threaded toots use a template-based summary instead of AI generation.

### Key Files (to be created)

- `src/ingest.ts` - Core `MastodonIngestor` class with all collection and context logic
- `src/runtime.ts` - Job handlers that wire up the ingestor
- `module.json` - Job definitions, settings schema, UI cards
- `settings.ts` - TypeScript types for settings (mirrors module.json)

## API Endpoints Reference

### Authentication
```
POST /oauth/token          # Exchange code for access token
GET  /api/v1/accounts/verify_credentials  # Verify token validity
```

### Timelines
```
GET /api/v1/timelines/home          # Home feed (recommended)
GET /api/v1/timelines/public        # Federated timeline (high volume!)
GET /api/v1/timelines/public?local=true  # Local instance only
GET /api/v1/timelines/list/:list_id # Specific list
```

### Statuses (Toots)
```
GET /api/v1/statuses/:id            # Single toot
GET /api/v1/statuses/:id/context    # Thread context (ancestors + descendants)
```

### Pagination
Mastodon uses **Link header pagination**:
```
Link: <https://instance/api/v1/timelines/home?max_id=123>; rel="next",
      <https://instance/api/v1/timelines/home?min_id=456>; rel="prev"
```

Use `max_id`, `since_id`, `min_id`, and `limit` query params for manual pagination.

## Rate Limits

**Default limits** (configurable per-instance):
- **300 requests per 5 minutes** for authenticated requests
- Some instances (especially small/private ones) may have lower limits

**Headers returned**:
```
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 299
X-RateLimit-Reset: 2024-01-15T12:00:00.000Z
```

**Implementation strategy**:
1. Check `X-RateLimit-Remaining` before each batch
2. If remaining < 10, wait until `X-RateLimit-Reset`
3. On 429 response, exponential backoff with jitter

## Conventions

### Settings

All settings come from the FeedEater settings registry, not environment variables. Fetch via `ctx.fetchInternalSettings("mastodon")`.

The `accessToken` is encrypted at rest and only decrypted when fetched.

### Database

- Private schema: `mod_mastodon`
- Tables: `mastodon_statuses`, `mastodon_status_embeddings`
- Use `ensureSchema()` to create tables on first run
- Never access other modules' schemas

### Bus Events

- Emit `StatusCreated` on `feedeater.mastodon.statusCreated`
- Emit `ContextUpdated` on `feedeater.mastodon.contextUpdated`
- Use `subjectFor("mastodon", "eventName")` helper

### Logging

Use the `log()` method which publishes to `feedeater.mastodon.log` for visibility in the FeedEater UI.

## What NOT To Do

- **Don't hardcode tokens** — Use the settings registry
- **Don't ignore rate limits** — Check headers and back off appropriately
- **Don't use `id` as global identifier** — Use `uri` for cross-instance uniqueness
- **Don't assume conversation_id is stable** — It's instance-local, may vary
- **Don't fetch federated timeline without filters** — Way too much volume
- **Don't parse HTML content directly** — Use the `content` field, it's already sanitized HTML

## Data Model Notes

### Status (Toot) Object

Key fields to store:
```typescript
interface MastodonStatus {
  id: string;              // Instance-local ID
  uri: string;             // Globally unique URI (use for dedup!)
  created_at: string;      // ISO 8601
  content: string;         // HTML content
  visibility: 'public' | 'unlisted' | 'private' | 'direct';
  sensitive: boolean;      // Content warning flag
  spoiler_text: string;    // CW text
  reblog: Status | null;   // If this is a boost, the original
  account: Account;        // Author info
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  conversation_id: string; // Instance-local conversation grouping
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  media_attachments: MediaAttachment[];
  poll: Poll | null;
}
```

### Handling Boosts (Reblogs)

When `reblog` is not null, the status is a boost. The `reblog` field contains the original status. Options:
1. Store both the boost and the original
2. Store only the original with a "boosted by" annotation
3. Skip boosts if `includeBoosts` setting is false

**Recommendation**: Store the original status, annotate with who boosted it and when.

## Federation Edge Cases

### Content Delays
When you follow someone on a remote instance, their posts must federate to your instance. This can take seconds to minutes. Don't assume real-time delivery.

### Missing Context
If someone on your instance replies to a toot from a remote user you don't follow, you might see the reply without the parent. The `/api/v1/statuses/:id/context` endpoint helps, but may also have incomplete data.

### Instance Shutdowns
If an instance goes offline, posts from that instance become inaccessible. Store enough data locally to preserve context.

### Deleted Content
Users can delete toots. The API will return 404 for deleted content. Handle gracefully.

### Content Warnings (CW)
Mastodon has a strong CW culture. The `sensitive` field and `spoiler_text` provide context. Consider whether to:
- Show CW text in summaries
- Exclude sensitive content based on settings
- Include CW context in AI prompts

## Implementation Recommendations

### Phase 1: Basic Collection
1. Implement OAuth token verification on startup
2. Fetch home timeline with pagination
3. Deduplicate by `uri` (not `id`)
4. Store in `mod_mastodon.mastodon_statuses`
5. Emit `StatusCreated` events

### Phase 2: Context Building
1. Group by `conversation_id`
2. For multi-toot conversations, fetch full thread via `/statuses/:id/context`
3. Generate AI summaries
4. Emit `ContextUpdated` events

### Phase 3: Enhancements
- List support (monitor specific lists)
- Notification integration
- Media attachment handling
- Poll result tracking

## Existing Libraries (Reference Only)

Don't use these directly (FeedEater is TypeScript, direct REST is fine), but useful for understanding API patterns:

- **megalodon** (TypeScript) — Multi-platform Mastodon/Pleroma/Misskey client
- **masto.js** (TypeScript) — Mastodon-specific, well-typed
- **mastodon.py** (Python) — Reference for API behavior

## Testing Locally

1. Set up FeedEater's docker-compose environment
2. Get a Mastodon account (mastodon.social is free)
3. Register an app and get an access token
4. Configure settings in the FeedEater UI
5. Trigger a manual `collect` job
6. Check logs for errors
7. Verify toots appear in the feed

## Comparison to Other Modules

| Aspect | Mastodon | Slack | Twitter |
|--------|----------|-------|---------|
| Auth complexity | Easy (OAuth 2.0) | Easy (bot token) | Hard (OAuth 1.0a, app approval) |
| API docs | Excellent | Good | Mediocre |
| Rate limits | Generous, clear | Generous | Restrictive, complex |
| Pagination | Link headers | Cursor-based | Cursor-based |
| Real-time option | WebSocket streaming | Socket Mode | None (API v2) |
| Multi-account | Per-instance config | Per-workspace | Complex |

**Bottom line**: Mastodon should be one of the **easiest** modules to implement. Good API, good docs, standard patterns.

## Lessons Learned

*(To be updated as implementation progresses)*

### Initial Setup
- TBD after implementation begins

### API Quirks
- TBD

### Context Summarization
- TBD
