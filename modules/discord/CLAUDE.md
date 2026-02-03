# Discord Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the Discord module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The Discord module collects messages from Discord servers (guilds) and organizes them into FeedEater's Context system. Threads and forum posts become their own contexts with AI-generated summaries.

## Architecture Decisions

### Why Bot Token (Not OAuth2)?

The OAuth2 `messages.read` scope **only works for local RPC** (Discord desktop client integration), NOT for reading message history via REST API. This is a common misconception.

For background message collection, bot tokens are the only viable option:
- Bot tokens provide full read access to channels the bot can see
- No token refresh required (unlike OAuth access tokens)
- Simpler implementation, no OAuth flow needed

### Why REST Polling (Not Gateway)?

Gateway provides real-time events but adds significant complexity:
- Requires persistent WebSocket connection
- Must handle heartbeat (every ~45 seconds)
- Must handle reconnection and session resumption
- Must handle sharding for large bot deployments
- No message history backfill via Gateway

REST polling is simpler and sufficient for FeedEater's use case:
- Stateless HTTP requests
- Can fetch message history on first run
- Lower resource usage (no persistent connection)
- Easier error recovery

**Future enhancement:** Consider Gateway for real-time mode if users need sub-minute latency.

### Data Flow

1. **collect job** (every 5 min): 
   - GET `/guilds/{id}/channels` → list accessible channels
   - For each channel: GET `/channels/{id}/messages?after={lastMsgId}&limit=100`
   - Store in `mod_discord.discord_messages`
   - Publish `MessageCreated` events to NATS

2. **updateContexts job** (every 30 min):
   - Find active threads from recent messages
   - Semantic search for relevant messages
   - Generate AI summaries
   - Publish `ContextUpdated` events

### Context Key Format

`{guildId}:{channelId}:{threadId}` — e.g., `123456789012345678:234567890123456789:345678901234567890`

For non-threaded messages: `{guildId}:{channelId}`

## Rate Limits (CRITICAL)

Discord's rate limiting is complex. **Failure to handle properly will get your bot/IP banned.**

### Rate Limit Categories

| Category | Details |
|----------|---------|
| **Per-Route** | Each endpoint has its own bucket. E.g., `/channels/{id}/messages` has a different bucket than `/channels/{id}` |
| **Per-Resource** | Some buckets are per-resource (e.g., per-channel). Hitting limit on channel A doesn't affect channel B |
| **Global** | 50 requests/second across ALL endpoints. Exceeding triggers global cooldown |
| **Cloudflare** | Too many 401/403/429 responses → IP banned by Cloudflare (not Discord) |

### Rate Limit Headers

Every response includes:
```
X-RateLimit-Limit: 5              # Max requests in bucket
X-RateLimit-Remaining: 4          # Requests left
X-RateLimit-Reset: 1234567890.5   # Unix timestamp (seconds) when bucket resets
X-RateLimit-Reset-After: 1.0      # Seconds until reset (more reliable)
X-RateLimit-Bucket: abc123        # Bucket identifier (hash)
X-RateLimit-Global: true          # Only present if global limit hit
```

### 429 Response Handling

When you get a 429:
```json
{
  "message": "You are being rate limited.",
  "retry_after": 1.234,            // Seconds to wait
  "global": false                  // true if global limit
}
```

**Implementation:**
1. Parse `retry_after` from body
2. If `global: true`, pause ALL requests
3. Wait `retry_after` seconds + small jitter
4. Retry the request
5. If repeated 429s, implement exponential backoff

### Rate Limit Best Practices

1. **Pre-emptive limiting:** Track `X-RateLimit-Remaining` and slow down before hitting 0
2. **Bucket caching:** Cache bucket IDs to predict limits for similar requests
3. **Request queuing:** Queue requests per-bucket, process sequentially
4. **Stagger requests:** Don't fire 50 requests simultaneously at startup

## Intents and Privileged Intents

Intents control which Gateway events your bot receives. Even for REST-only bots, you need to configure intents in the Developer Portal for some features.

### Standard Intents (No Approval Needed)
- `GUILDS` (1 << 0) - Guild create/update/delete, channels, roles
- `GUILD_MESSAGES` (1 << 9) - Messages in guild channels (metadata only without MESSAGE_CONTENT)
- `DIRECT_MESSAGES` (1 << 12) - DM messages (if bot accepts DMs)

### Privileged Intents (Require Portal Toggle)

⚠️ For bots in 100+ servers, these require verification AND explicit approval.

| Intent | Flag | What It Enables |
|--------|------|-----------------|
| `GUILD_MEMBERS` | 1 << 1 | Member join/leave/update events, member list |
| `GUILD_PRESENCES` | 1 << 8 | User presence (online/idle/dnd/offline) |
| `MESSAGE_CONTENT` | 1 << 15 | Actual message text, embeds, attachments, components |

### MESSAGE_CONTENT Intent (CRITICAL)

**As of September 1, 2022:** Bots can only read message content if:
1. The bot has MESSAGE_CONTENT intent enabled in Developer Portal
2. The message is in a DM with the bot, OR
3. The message @mentions the bot, OR
4. The message is a reply to the bot's message

Without this intent, `message.content` will be empty string for most messages!

**To enable:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application → Bot
3. Scroll to "Privileged Gateway Intents"
4. Toggle ON "MESSAGE CONTENT INTENT"

## Key Files (When Implemented)

- `src/ingest.ts` - Core `DiscordIngestor` class with collection logic
- `src/runtime.ts` - Job handlers wiring up the ingestor
- `src/ratelimit.ts` - Rate limit bucket tracking and request queuing
- `module.json` - Job definitions, settings schema, UI cards
- `settings.ts` - TypeScript types for settings

## Conventions (Follow FeedEater Patterns)

### Settings

All settings via FeedEater settings registry, NOT environment variables.
```typescript
const settings = await ctx.fetchInternalSettings("discord");
const token = settings.botToken; // Decrypted at runtime
```

### Database

- Private schema: `mod_discord`
- Tables: `discord_messages`, `discord_message_embeddings`
- Use `ensureSchema()` for table creation
- Never access other modules' schemas

### Bus Events

- Emit `MessageCreated` on `feedeater.discord.messageCreated`
- Emit `ContextUpdated` on `feedeater.discord.contextUpdated`
- Use `subjectFor("discord", "eventName")` helper

### Logging

Use `log()` method which publishes to `feedeater.discord.log` for UI visibility.

## What NOT To Do

### Authentication
- **Don't use OAuth2 for message collection** - `messages.read` scope doesn't work via REST API
- **Don't hardcode tokens** - Use settings registry
- **Don't log tokens** - Even partial tokens are sensitive

### Rate Limits
- **Don't ignore rate limit headers** - You will get banned
- **Don't retry 429s immediately** - Always wait `retry_after`
- **Don't spam invalid requests** - Cache channel validity, don't retry 403s
- **Don't fire parallel requests blindly** - Use request queuing per bucket

### Intents
- **Don't forget MESSAGE_CONTENT intent** - Messages will be empty without it
- **Don't enable unnecessary privileged intents** - May block verification for large bots

### API Usage
- **Don't fetch entire message history** - Respect `lookbackHours`, use `after` parameter
- **Don't poll too frequently** - 5 minute minimum recommended
- **Don't fetch all channels blindly** - Allow `channelIds` filter

### Data Handling
- **Don't store raw tokens in messages table** - Only store message data
- **Don't assume message.content exists** - Check for empty string (intent not enabled)
- **Don't skip deduplication** - Messages can be edited, track `edited_timestamp`

## Discord API Quirks

### IDs are Snowflakes
Discord IDs are 64-bit integers represented as strings in JSON. In JavaScript/TypeScript, use strings to avoid precision loss:
```typescript
// WRONG: Number loses precision for IDs > 2^53
const channelId = 123456789012345678;

// RIGHT: Keep as string
const channelId = "123456789012345678";
```

### Message Timestamps
- `timestamp` - ISO8601 when message was sent
- `edited_timestamp` - ISO8601 when last edited, or `null`

### Channel Types
```typescript
enum ChannelType {
  GUILD_TEXT = 0,           // Regular text channel
  DM = 1,                   // Direct message
  GUILD_VOICE = 2,          // Voice channel (has text chat)
  GROUP_DM = 3,             // Group DM
  GUILD_CATEGORY = 4,       // Category (folder)
  GUILD_ANNOUNCEMENT = 5,   // Announcement channel
  ANNOUNCEMENT_THREAD = 10, // Thread in announcement channel
  PUBLIC_THREAD = 11,       // Public thread
  PRIVATE_THREAD = 12,      // Private thread
  GUILD_STAGE_VOICE = 13,   // Stage channel
  GUILD_DIRECTORY = 14,     // Hub directory
  GUILD_FORUM = 15,         // Forum channel
  GUILD_MEDIA = 16,         // Media channel
}
```

For message collection, focus on: 0, 2, 5, 10, 11, 12, 15, 16

### Thread Discovery
Threads aren't returned by `/guilds/{id}/channels`. To find active threads:
```
GET /guilds/{guild.id}/threads/active
GET /channels/{channel.id}/threads/archived/public
GET /channels/{channel.id}/threads/archived/private
```

### Message Fetch Limits
- Maximum 100 messages per request
- Use `before`, `after`, or `around` for pagination
- `after` is most efficient for incremental collection

## Recommended Libraries

### discord.js (Node.js)
```typescript
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';

// REST only (no Gateway connection)
const rest = new REST({ version: '10' }).setToken(token);
const messages = await rest.get(Routes.channelMessages(channelId), {
  query: { limit: 100, after: lastMessageId }
});
```

### @discordjs/rest (Lighter weight)
If you don't need Gateway, `@discordjs/rest` is smaller:
```typescript
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
```

### Raw fetch (Simplest)
For maximum control:
```typescript
const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`, {
  headers: { Authorization: `Bot ${token}` }
});
```

## Testing Locally

1. Create a test Discord server
2. Create a bot application and invite it
3. Enable MESSAGE_CONTENT intent
4. Configure FeedEater with bot token and guild ID
5. Post test messages in server
6. Trigger manual `collect` job
7. Verify messages appear in feed

## Future Improvements

- [ ] Gateway mode for real-time collection
- [ ] Reaction tracking
- [ ] Attachment/embed indexing
- [ ] Slash command for on-demand summaries
- [ ] Webhook support for specific channel monitoring
- [ ] Forum post auto-summarization
- [ ] Voice channel transcript support (if Discord adds)

## Lessons Learned

*(To be updated as implementation progresses)*

### Research Phase
- OAuth2 `messages.read` scope is for local RPC only - bot tokens are required for API message access
- MESSAGE_CONTENT intent is required since Sept 2022 - without it, message.content is empty
- Rate limits are per-bucket (route + resource), not just per-endpoint
- Discord.js handles rate limits automatically, but custom implementations need careful bucket tracking
