# Twitch Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the Twitch module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The Twitch module collects streams, VODs, clips, and chat from Twitch. It uses:
- **REST API (Helix)** for polling data (followed streams, videos, clips)
- **EventSub WebSocket** for real-time events (stream online/offline, chat)
- Organizes everything into FeedEater's Context system with AI summaries

## Architecture Decisions

### REST vs EventSub: When to Use Each

| Use Case | Approach | Reason |
|----------|----------|--------|
| Followed streams list | REST polling | Need full list, EventSub only notifies changes |
| VODs and clips | REST polling | No EventSub events for these |
| Stream goes live | EventSub `stream.online` | Real-time notification |
| Stream ends | EventSub `stream.offline` | Real-time notification |
| Chat messages | EventSub `channel.chat.message` | Real-time, rich metadata |
| Channel follows | EventSub `channel.follow` | Real-time (if authorized) |

**Rule of thumb**: Use EventSub for anything that needs real-time response. Use REST for bulk fetching and data that doesn't have EventSub events.

### WebSocket vs Webhooks

**Always use WebSocket** for FeedEater unless there's a specific reason not to:

1. **No public endpoint needed** — FeedEater may run behind NAT
2. **Simpler setup** — No SSL certs, no callback URL verification
3. **Lower latency** — Direct push vs HTTP round-trip
4. **Same events** — All EventSub events work on both transports

Webhooks make sense only for:
- High-scale deployments needing horizontal scaling (use Conduits)
- Serverless/edge functions that can't maintain WebSocket

### Chat: EventSub, Not IRC

**Do NOT use IRC for new code.** Twitch's recommended approach is now:

- **Receive chat**: EventSub `channel.chat.message` event
- **Send chat**: REST API `Send Chat Message` endpoint

Benefits over IRC:
- Structured JSON (no IRC parsing)
- Full message metadata (badges, emotes, bits)
- Bot badge automatically applied (with app access token)
- No JOIN limits beyond EventSub subscription limits
- Works with shared chat sessions

IRC downsides:
- Requires IRC protocol handling
- Lower rate limits for JOINs (20/10s vs 300 subscriptions)
- No bot badge unless verified
- Some features don't work (shared chat)

### Token Management

Twitch tokens expire. The module must:

1. **Store refresh token** alongside access token
2. **Validate token** on startup (`GET https://id.twitch.tv/oauth2/validate`)
3. **Refresh proactively** before expiration (tokens last ~4 hours)
4. **Handle revocation** gracefully (user disconnected app, password change)

```typescript
// Token refresh flow
POST https://id.twitch.tv/oauth2/token
  grant_type=refresh_token
  &refresh_token=YOUR_REFRESH_TOKEN
  &client_id=YOUR_CLIENT_ID
  &client_secret=YOUR_CLIENT_SECRET
```

### EventSub Connection Lifecycle

```
Connect → Welcome (get session_id) → Subscribe to events → Process notifications
                                                              ↓
                                                         Keepalive timeout?
                                                              ↓
                                                         Reconnect
```

Critical state machine:
1. `connected` — Normal operation
2. `reconnecting` — Received reconnect message, connecting to new URL
3. `disconnected` — Lost connection, need full resubscribe

**Important**: After reconnect message, keep OLD connection until NEW welcome received. This ensures no missed events.

## Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Twitch API     │     │  FeedEater       │     │  NATS Bus       │
│  (REST/WS)      │────▶│  Twitch Module   │────▶│                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  mod_twitch.*    │
                        │  (Postgres)      │
                        └──────────────────┘
```

### Database Schema (Private)

- `mod_twitch.twitch_streams` — Stream snapshots (live status, viewers, game)
- `mod_twitch.twitch_videos` — VODs, highlights, uploads
- `mod_twitch.twitch_clips` — User-created clips
- `mod_twitch.twitch_chat_messages` — Chat messages (if chat enabled)
- `mod_twitch.twitch_chat_embeddings` — Vector embeddings for semantic search

### Bus Events

- Emit `StreamOnline` on `feedeater.twitch.streamOnline`
- Emit `StreamOffline` on `feedeater.twitch.streamOffline`
- Emit `VideoCreated` on `feedeater.twitch.videoCreated`
- Emit `ClipCreated` on `feedeater.twitch.clipCreated`
- Emit `ChatMessage` on `feedeater.twitch.chatMessage`
- Emit `ContextUpdated` on `feedeater.twitch.contextUpdated`

## Rate Limits

### API (Helix)

| Limit | Value | Notes |
|-------|-------|-------|
| Points/min (app token) | 800 | Shared across all users of app |
| Points/min (user token) | Per-user bucket | Isolated per user |
| Default cost | 1 point/request | Some endpoints cost more |
| Pagination limit | 100 items/page | Use `after` cursor |

**Always check headers**:
- `Ratelimit-Limit` — Bucket fill rate
- `Ratelimit-Remaining` — Points left
- `Ratelimit-Reset` — Unix timestamp when bucket refills

**On 429**: Back off until `Ratelimit-Reset`.

### EventSub WebSocket

| Limit | Value |
|-------|-------|
| Connections per user token | 3 |
| Subscriptions per connection | 300 |
| Max total cost | 10,000 |
| Welcome-to-subscribe timeout | 10 seconds |
| Keepalive default | 10 seconds |
| Keepalive max | 600 seconds |

**Subscription costs**: Most are 1, some are 0 (like `user.authorization.grant`).

### Chat Send

| Condition | Limit |
|-----------|-------|
| Normal user | 20 msgs/30s, 1 msg/s/channel |
| Broadcaster/mod/VIP | 100 msgs/30s |
| Verified bot | 7500 msgs/30s |

## Conventions

### Settings

All configuration via FeedEater settings registry. Fetch via `ctx.fetchInternalSettings("twitch")`.

Secrets (`clientSecret`, `userAccessToken`, `refreshToken`) are encrypted at rest.

### IDs Are Strings

All Twitch IDs are opaque strings. Never parse or manipulate them. Store as `TEXT`, not `INTEGER`.

### Timestamps

- REST API: RFC3339 with milliseconds (`2024-01-15T10:30:00.000Z`)
- EventSub: RFC3339 with **nanoseconds** (`2024-01-15T10:30:00.000000000Z`)

Normalize to ISO 8601 when storing.

### Deduplication

EventSub may send duplicate notifications. Track `message_id` and skip if already processed:

```typescript
const processed = new Set<string>();

function handleNotification(msg: EventSubNotification) {
  if (processed.has(msg.metadata.message_id)) return;
  processed.add(msg.metadata.message_id);
  // Process...
}
```

Clear the set periodically (messages older than 10 min won't be resent).

## What NOT To Do

### Authentication

- **Don't hardcode tokens** — Use settings registry
- **Don't ignore refresh tokens** — Tokens expire in ~4 hours
- **Don't use IRC for new code** — EventSub is the way
- **Don't assume scopes** — Validate on startup

### EventSub

- **Don't send messages to WebSocket** — Server will disconnect (except pong)
- **Don't ignore keepalive timeout** — Reconnect if no message within timeout
- **Don't close old connection on reconnect message** — Wait for new welcome
- **Don't skip message_id dedup** — You will get duplicates
- **Don't exceed 10s to first subscription** — Connection will close

### API

- **Don't ignore rate limits** — Check headers, back off on 429
- **Don't fetch without pagination** — Max 100 items/page
- **Don't poll what EventSub provides** — Use events for real-time data
- **Don't trust usernames** — Always use numeric user IDs

### Chat

- **Don't assume chat access** — Requires broadcaster auth or mod status
- **Don't spam chat** — Respect rate limits, get banned otherwise
- **Don't parse IRC** — Use EventSub channel.chat.message

### Data

- **Don't store more than needed** — VODs/clips can be huge, store metadata only
- **Don't assume video availability** — Streamers delete VODs, clips expire
- **Don't fetch full chat history** — No API for it, only live via EventSub

## Lessons Learned

### EventSub Quirks

- Welcome message comes immediately, but you have only 10s to subscribe
- Keepalive resets on ANY message (notification or keepalive)
- Reconnect URL is temporary — use it immediately
- Close code 4003 means you forgot to subscribe
- Close code 4001 means you accidentally sent data

### API Quirks

- `Get Followed Streams` requires user token (not app token)
- `Get Streams` can filter by user_id, but `Get Followed Streams` cannot
- Clip URLs expire — store clip ID and fetch URL when needed
- Game names change — store game_id and fetch name when displaying
- User display names have capitalization, login names are lowercase

### Chat Quirks

- `channel.chat.message` includes emotes as text positions, not replaced
- Bot badge only appears with app access token + channel:bot scope
- Shared chat sessions duplicate messages across channels (have source_channel)
- Bits messages include amount and tier info

### Token Quirks

- App tokens last indefinitely but can be revoked
- User tokens last ~4 hours (but time varies)
- Refresh tokens last until user revokes
- Invalid token returns 401 with `WWW-Authenticate: OAuth realm="TwitchTV"`

## Testing Locally

1. Register a Twitch app at dev.twitch.tv
2. Get OAuth tokens (use Twitch's token generator for testing)
3. Configure settings in FeedEater UI
4. Trigger manual `collect` job
5. Check logs for EventSub connection status
6. Verify data appears in feed

### Twitch CLI

Twitch provides a CLI for testing:
```bash
twitch event trigger stream.online --transport=websocket
twitch event verify-subscription stream.online -F http://localhost:3000/webhook
```

Useful for testing EventSub handlers without waiting for real events.

## Libraries (If Needed)

Prefer native implementation for control, but these exist:

| Library | Purpose | Notes |
|---------|---------|-------|
| `@twurple/api` | REST API wrapper | Full Helix coverage |
| `@twurple/eventsub-ws` | EventSub WebSocket | Handles reconnection |
| `@twurple/chat` | Chat (EventSub) | Higher-level chat abstraction |

For FeedEater, native fetch + WebSocket is probably fine. Libraries add overhead and hide important details (like rate limit headers).

## Future Improvements

- [ ] Auto-refresh tokens before expiration
- [ ] Support multiple Twitch accounts
- [ ] Conduit support for horizontal scaling
- [ ] Clip download/archival
- [ ] Stream recording integration
- [ ] Emote rendering in summaries
- [ ] Prediction/poll tracking via EventSub
