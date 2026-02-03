# Bluesky Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the Bluesky module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The Bluesky module collects posts from Bluesky (via the AT Protocol) and organizes them into FeedEater's unified message system. Threads become contexts with AI-generated summaries.

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                           BLUESKY NETWORK                           │
├─────────────────────────────────────────────────────────────────────┤
│  PDS (bsky.social)  ◄──►  AppView (api.bsky.app)  ◄──►  Relay      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ getTimeline / getFeed
                     ┌─────────────────┐
                     │   collect job   │
                     │   (polling)     │
                     └────────┬────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
     │ mod_bsky    │  │ NATS Event  │  │ Embeddings  │
     │ .bsky_posts │  │ MessageCreated│ │ (optional) │
     └─────────────┘  └─────────────┘  └─────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ updateContexts  │
                     │ job (AI summary)│
                     └─────────────────┘
```

### AT Protocol Core Concepts

**DIDs (Decentralized Identifiers)**
- Permanent, cryptographically secure account IDs
- Two types: `did:plc:xxx` (most common) and `did:web:domain.com`
- Never change, even if handle changes
- Used as canonical identifier in all data references

**Handles**
- Human-readable names (DNS-based)
- Format: `alice.bsky.social` or custom domain `alice.com`
- Can change — always resolve to DID for storage

**AT URIs**
- Format: `at://{did}/{collection}/{rkey}`
- Example: `at://did:plc:xxx/app.bsky.feed.post/3k43tv4rft22g`
- Components:
  - `did` — account identifier
  - `collection` — Lexicon type (e.g., `app.bsky.feed.post`)
  - `rkey` — record key (unique within collection)

**CIDs (Content Identifiers)**
- Hash of record content
- Used to verify data integrity
- Required for strong references (replies, quotes)

### Record Types We Care About

| Lexicon | Description |
|---------|-------------|
| `app.bsky.feed.post` | Posts (text, embeds, facets) |
| `app.bsky.feed.repost` | Reposts (references another post) |
| `app.bsky.feed.like` | Likes (references a post) |
| `app.bsky.graph.follow` | Follows (references an actor) |
| `app.bsky.actor.profile` | User profiles |

### Context Key Format

`{authorDid}:{postRkey}` for top-level posts
`{rootAuthorDid}:{rootRkey}` for threads (all replies share root's context)

## Conventions

### Settings

All settings via FeedEater settings registry, not environment variables:
```typescript
const settings = await ctx.fetchInternalSettings("bluesky");
const { identifier, appPassword, serviceUrl } = settings;
```

Secrets (`appPassword`) are encrypted at rest.

### Database Schema

- Private schema: `mod_bsky`
- Tables:
  - `bsky_posts` — raw post data
  - `bsky_post_embeddings` — vector embeddings
  - `bsky_sessions` — cached session tokens (encrypted)
- Use `ensureSchema()` to create tables on first run
- Never access other modules' schemas

### Bus Events

```typescript
// Emit on new post collected
emit("feedeater.bluesky.messageCreated", { ... });

// Emit on thread summary updated  
emit("feedeater.bluesky.contextUpdated", { ... });

// Use helper
subjectFor("bluesky", "messageCreated");
```

### Session Management

```typescript
// Use BskyAgent from @atproto/api
const agent = new BskyAgent({ service: settings.serviceUrl });

// Login returns accessJwt (short-lived) + refreshJwt (longer-lived)
await agent.login({
  identifier: settings.identifier,
  password: settings.appPassword
});

// Agent handles token refresh automatically
// But persist refreshJwt to survive restarts
```

### Deduplication

Posts are identified by AT URI. Use upsert logic:
```sql
INSERT INTO bsky_posts (uri, cid, author_did, ...)
ON CONFLICT (uri) DO UPDATE SET cid = EXCLUDED.cid, ...
WHERE bsky_posts.cid != EXCLUDED.cid;  -- Only if content changed
```

Check `xmax = 0` to detect true inserts vs updates (PostgreSQL).

## What NOT To Do

### Authentication
- **Don't store raw passwords** — Always use app passwords
- **Don't hardcode credentials** — Use settings registry
- **Don't ignore token expiry** — Refresh sessions proactively
- **Don't create sessions on every request** — Cache and reuse

### API Usage
- **Don't exceed rate limits** — 3000 req/5min per IP
- **Don't poll too frequently** — Respect `collectIntervalMinutes`
- **Don't fetch unlimited history** — Use `lookbackHours` setting
- **Don't ignore cursors** — Paginate properly for large fetches

### Data Handling
- **Don't store handles as primary keys** — They change; use DIDs
- **Don't assume post exists** — Deletions happen
- **Don't trust facet byte indices blindly** — They're UTF-8 byte offsets, not char offsets
- **Don't skip CID verification for sensitive operations** — Quote posts and replies need both URI and CID

### Thread Handling
- **Don't flatten threads incorrectly** — Track both `parent` and `root` refs
- **Don't re-fetch entire threads on every run** — Only fetch updates

## API Quirks Discovered in Research

### Session/Auth Quirks
1. **AccessJwt expires in ~2 hours**, not minutes as some docs suggest
2. **RefreshJwt lasts ~60 days** but can be invalidated by password change
3. **App passwords** format `xxxx-xxxx-xxxx-xxxx` — clients can validate format to prevent accidental primary password use
4. **OAuth is NOT recommended for headless/bot use cases** — use app passwords

### Timeline/Feed Quirks
1. **`getTimeline` returns reverse chronological** — newest first
2. **Cursor pagination is opaque** — don't parse it, just pass it back
3. **Max 100 posts per request** — setting `limit > 100` is ignored
4. **Feed generators are user-created** — availability not guaranteed
5. **`Accept-Language` header** affects which posts feed generators return

### Post Structure Quirks
1. **Facets use byte indices, not character indices** — Must encode to UTF-8 to calculate offsets
2. **Mentions resolve to DIDs** — Handle in text, DID in facet
3. **No edit history** — Posts are immutable; "edits" are delete + recreate
4. **Embeds are typed** — `app.bsky.embed.images`, `app.bsky.embed.external`, `app.bsky.embed.record`
5. **Timestamps are ISO 8601** — Use trailing `Z`, not `+00:00`

### Threading Quirks
1. **`reply.root` and `reply.parent` both required** — For any reply
2. **If parent is deleted, thread breaks** — Can't fetch full context
3. **Root can equal parent** — For direct replies to OP
4. **Quote posts aren't replies** — They use `embed.record`, not `reply`

### DID/Identity Quirks
1. **Handle resolution is two-step** — DNS TXT `_atproto.{handle}` → DID → DID Document
2. **DID Documents contain PDS endpoint** — Don't assume `bsky.social`
3. **`did:plc` is dominant** — `did:web` is rare, self-hosters only
4. **Handles can be any domain** — Verification is bidirectional

### Rate Limit Quirks
1. **429 responses include `RateLimit-Reset` header** — Respect it
2. **Write limits use point system** — CREATE=3, UPDATE=2, DELETE=1
3. **IP-based for reads, account-based for writes** — Different buckets
4. **AppView (public.api.bsky.app) is cached** — Use for public reads

## Real-Time Alternatives (Future)

### Firehose
- Full network stream: `wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos`
- Binary CBOR format, requires CAR file parsing
- All events from all accounts — very high volume
- Good for: feed generators, labelers, full network analysis

### Jetstream (Recommended for future)
- Simplified JSON stream: `wss://jetstream2.us-east.bsky.network/subscribe`
- Can filter by collection: `?wantedCollections=app.bsky.feed.post`
- Much lower bandwidth, easier to parse
- Tradeoff: **No cryptographic verification** — trust the operator
- Good for: real-time notifications, lightweight integrations

```typescript
// Jetstream example
const ws = new WebSocket(
  'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post'
);
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Process post event
};
```

## Testing Locally

1. Set up FeedEater's docker-compose environment
2. Configure Bluesky settings in UI:
   - Identifier: your handle (e.g., `yourname.bsky.social`)
   - App Password: create one in Bluesky settings
3. Trigger manual `collect` job from UI
4. Check logs panel for errors
5. Verify posts appear in the unified feed

## Key Libraries

```json
{
  "@atproto/api": "^0.13.x",  // Official SDK
  "@atproto/syntax": "^0.3.x" // AT URI/DID parsing
}
```

### BskyAgent Pattern
```typescript
import { BskyAgent } from '@atproto/api';

const agent = new BskyAgent({ service: 'https://bsky.social' });
await agent.login({ identifier, password: appPassword });

// Fetch timeline
const { data } = await agent.getTimeline({ limit: 100 });
for (const item of data.feed) {
  const post = item.post;
  // post.uri, post.cid, post.record, post.author, etc.
}
```

## Lessons Learned

### From Research Phase
- OAuth is complex (PKCE, PAR, DPoP required) — app passwords are simpler for server-side
- Bluesky's architecture separates PDS (data home) from AppView (aggregation)
- Rate limits are generous for read-only use cases
- Jetstream is the future for real-time — polling is fine for MVP

### From Implementation (February 2025)

**Type Safety with module-sdk**
- Use `DbLike`, `NatsLike`, `StringCodecLike` from `@feedeater/module-sdk` — NOT the concrete types from `pg` or `nats`
- `DbLike.query()` returns `Promise<unknown>`, so cast results explicitly: `(await db.query(...)) as { rows: Array<...> }`
- This pattern matches Slack module and ensures compatibility with the FeedEater worker

**AT Protocol SDK Gotchas**
- `BskyAgent.getTimeline()` has `exactOptionalPropertyTypes` issues — use conditional object: `cursor ? { limit, cursor } : { limit }`
- The regex for parsing AT URIs can return undefined captures — always check before using

**Context Key Format**
- For threads: `{rootDid}:{rootRkey}` — all replies share the same context
- For standalone posts: `{authorDid}:{postRkey}` — post is its own context
- Use `parseAtUri()` helper to extract components from AT URIs

**Timeline Collection Strategy**
- Cursor pagination works well — fetch pages until cutoff time is reached
- Safety limit pages (50 max) to prevent runaway fetches
- `getTimeline` returns newest-first, so cutoff check works naturally

**Embedding Errors are Non-Fatal**
- Wrap embedding calls in try/catch and continue without embeddings
- Better to store posts without embeddings than fail entire job
- Same pattern applies to AI summary generation in `refreshContexts`

**Database Schema Design**
- Store both `author_did` (permanent) and `author_handle` (display, can change)
- `reply_root_uri` and `reply_parent_uri` for thread tracking
- `is_repost` flag to distinguish original posts from reposts

## Future Improvements

- [ ] Migrate from polling to Jetstream WebSocket
- [ ] Support multiple accounts
- [ ] Collect notifications (mentions, likes received)
- [ ] Track list memberships
- [ ] Integrate moderation labels
- [ ] Handle account migrations (DID stays same, PDS changes)
