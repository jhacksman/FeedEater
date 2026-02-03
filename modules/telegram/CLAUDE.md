# Telegram Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the Telegram module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The Telegram module collects messages from a user's Telegram account via MTProto API (using gramjs) and organizes them into FeedEater's Context system. Unlike Bot API, MTProto provides full access to the user's chat list, history, and private conversations.

## Architecture Decisions

### Why MTProto Over Bot API

**Bot API Limitations:**
- Bots can only see messages in chats where they're added
- Cannot access user's chat list (no `getDialogs` equivalent)
- Private chats only work if user initiates conversation with bot
- Channel history requires bot to be admin

**MTProto Advantages:**
- Full access to user's entire chat history
- Can enumerate all dialogs the user has
- Saved Messages accessible
- Reactions, polls, forums all available
- True "personal feed aggregator" capability

**Decision:** Use gramjs (TypeScript MTProto implementation) for all collection.

### Session Management

MTProto requires authenticated sessions that persist across restarts:

```
Session Types:
├── StringSession (recommended)
│   └── Base64-encoded auth key + DC info
│   └── ~300-500 chars, stored in settings
│
└── StoreSession (file-based)
    └── Stores in a folder
    └── NOT portable across containers
```

**Use StringSession** because:
- Portable (just a string in the database)
- Works with Docker/containerized deployments
- Can be encrypted at rest in FeedEater's secrets store
- No filesystem dependencies

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         COLLECT JOB                              │
├─────────────────────────────────────────────────────────────────┤
│  1. Connect to Telegram (restore session)                       │
│  2. Fetch dialog list: client.getDialogs()                      │
│  3. Filter by settings (types, include/exclude lists)           │
│  4. For each dialog:                                            │
│     a. Fetch messages since last_collected_id                   │
│     b. Store in mod_telegram.telegram_messages                  │
│     c. Publish MessageCreated events                            │
│  5. Disconnect cleanly                                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      UPDATE_CONTEXTS JOB                         │
├─────────────────────────────────────────────────────────────────┤
│  1. Find active threads (forum topics, reply chains)            │
│  2. Gather semantically related messages                        │
│  3. Generate AI summaries                                       │
│  4. Publish ContextUpdated events                               │
└─────────────────────────────────────────────────────────────────┘
```

### Context Key Format

```
telegram:{dialogId}:{threadId}

Examples:
- telegram:-1001234567890:0           (main chat, no thread)
- telegram:-1001234567890:12345       (forum topic ID 12345)
- telegram:777000:0                   (Telegram's own notifications)
- telegram:self:0                     (Saved Messages)
```

Telegram IDs can be negative (groups/channels start with -100).

## Key Implementation Details

### Dialog ID Formats

Telegram uses different ID formats internally:

| Entity Type | ID Format | Example |
|-------------|-----------|---------|
| Users | Positive int | `123456789` |
| Basic Groups | Negative int | `-123456789` |
| Supergroups/Channels | -100 prefix | `-1001234567890` |
| Saved Messages | Special | `self` or user's own ID |

gramjs abstracts this, but be aware when storing/comparing.

### Message Pagination

```javascript
// gramjs uses iterators - DON'T fetch all at once
for await (const message of client.iterMessages(dialog, {
  limit: 100,
  offsetId: lastMessageId,
  reverse: true  // oldest first when catching up
})) {
  // process message
}
```

Never `getMessages()` with huge limits. Use iteration with reasonable page sizes.

### Flood Wait Handling

gramjs handles FLOOD_WAIT automatically, but you can configure:

```javascript
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
  floodSleepThreshold: 60,  // Auto-sleep for waits < 60s
});
```

For waits > threshold, gramjs throws `FloodWaitError`. Catch and handle:

```javascript
try {
  await client.getDialogs();
} catch (e) {
  if (e instanceof FloodWaitError) {
    const waitSeconds = e.seconds;
    log(`Flood wait: sleeping ${waitSeconds}s`);
    await sleep(waitSeconds * 1000 * FLOOD_WAIT_MULTIPLIER);
    // retry
  }
}
```

**Critical:** Never ignore FLOOD_WAIT. Telegram will progressively increase wait times and may temporarily restrict the account.

### Connection Lifecycle

```javascript
// GOOD: Connect once, do work, disconnect
async function collectJob() {
  await client.connect();
  try {
    // do all collection work
  } finally {
    await client.disconnect();
  }
}

// BAD: Don't leave connections open between job runs
// Sessions are resumable - reconnection is cheap
```

### Handling Deleted Messages

Messages can be deleted. Handle gracefully:

```javascript
// Some messages in a range might be deleted
const messages = await client.getMessages(dialog, { ids: [1, 2, 3, 4, 5] });
// messages may have fewer items than requested
// or items may be undefined/null
```

## What NOT To Do

### Session Security

- **Don't log session strings** — They provide full account access
- **Don't hardcode credentials** — Use FeedEater's settings registry
- **Don't store sessions in files** — Use StringSession in encrypted settings
- **Don't share api_id/api_hash** — They identify your application

### Rate Limits

- **Don't fetch all history at once** — Use incremental collection with `offsetId`
- **Don't ignore FLOOD_WAIT** — Wait the full duration (or longer)
- **Don't parallelize aggressively** — Telegram tracks request patterns
- **Don't hammer getDialogs** — Cache dialog list, refresh periodically

### Data Handling

- **Don't assume message content exists** — Media-only messages have empty `message`
- **Don't assume linear IDs** — Message IDs can have gaps (deleted messages)
- **Don't assume users have usernames** — Many users have no @username
- **Don't trust timestamps blindly** — Users can backdate messages in some contexts

### Session Management

- **Don't create new sessions per request** — Reuse the authenticated session
- **Don't panic on SESSION_EXPIRED** — Implement re-auth flow
- **Don't forget to disconnect** — gramjs keeps connections open

## Telegram-Specific Quirks

### Entity Resolution

gramjs caches entities (users, chats). If you need fresh data:

```javascript
// Force refresh entity info
const entity = await client.getEntity(dialogId);
```

But don't do this for every message — use cached data.

### Media Handling

Media is complex. Basic approach:

```javascript
if (message.media) {
  if (message.media.photo) {
    // Photo - can download
  } else if (message.media.document) {
    // Document - check mime type
    const mimeType = message.media.document.mimeType;
  } else if (message.media.poll) {
    // Poll - has question and options
  }
  // ... many more types
}
```

For FeedEater, consider NOT downloading media initially — just store metadata and fetch on demand.

### Forum Topics

Supergroups with topics enabled are like mini-forums:

```javascript
if (dialog.forum) {
  // This chat has topics
  const topics = await client.invoke(
    new Api.channels.GetForumTopics({ channel: dialog })
  );
  // Each topic is effectively a separate conversation
}
```

Map topics to FeedEater contexts.

### Saved Messages Topics

As of 2024, Saved Messages supports topics too. Check for:
- `dialog.id === client.session.userId` (it's Saved Messages)
- Topics within Saved Messages

## Testing Locally

1. Get API credentials from my.telegram.org
2. Run gramjs auth script to generate session string
3. Add credentials to FeedEater module settings
4. Trigger manual `collect` job
5. Verify messages appear in feed
6. Check for FLOOD_WAIT in logs

## Error Recovery

### AUTH_KEY_UNREGISTERED / SESSION_REVOKED

Session was invalidated. Common causes:
- User terminated session from Telegram app
- Account security action
- Server-side session cleanup (inactive sessions)

**Recovery:** Delete stored session, re-authenticate user.

### FLOOD_WAIT_X

Too many requests. 

**Recovery:**
1. Wait X seconds (multiply by safety factor)
2. Reduce request frequency
3. If persistent, increase interval between collection jobs

### CONNECTION_NOT_INITED

Tried to make requests without proper connection.

**Recovery:** Ensure `client.connect()` completes before any API calls.

### TIMEOUT

Request timed out.

**Recovery:** Retry with exponential backoff. May indicate network issues or Telegram outage.

## Lessons Learned

### From Telethon/gramjs Community

1. **Rate limits are per-account, not per-API-key** — Running multiple clients on same account doesn't help
2. **getDialogs is expensive** — Cache results, only refresh periodically
3. **iterMessages is efficient** — Uses generators, doesn't load all into memory
4. **Session strings are DC-aware** — They know which datacenter to connect to

### From Similar Projects

1. **Batch message fetching is tricky** — Some messages may be unavailable
2. **User privacy settings affect visibility** — Some users hide forwarded-from info
3. **Channels can have linked discussion groups** — Handle the relationship
4. **Reactions are per-message, not per-chat** — Need to track individually

## Implementation Lessons (2025-01)

### gramjs Type System
1. **Dialog types differ** — `telegram/tl/custom/dialog` (Dialog wrapper class) is NOT `Api.Dialog` (raw TL type). The wrapper has `.entity`, `.archived`, etc. as properties.
2. **BigInteger handling** — gramjs uses `big-integer` library, not native BigInt. Use `bigInt()` constructor and `bigInt.zero` for values.
3. **Import paths** — Use `.js` extensions in imports for ES module compatibility: `telegram/sessions/index.js`, `telegram/errors/index.js`.
4. **Entity resolution** — Dialog IDs need reconstruction: channels are `-100{id}`, groups are `-{id}`, users are positive.

### Module SDK Compatibility
1. **Use SDK types** — `DbLike`, `NatsLike`, `StringCodecLike` from `@feedeater/module-sdk` instead of concrete `Pool`/`NatsConnection` types.
2. **Query result typing** — Cast query results explicitly: `(await db.query(...)) as { rows: Array<{...}> }`.

### Rate Limiting
1. **FLOOD_WAIT is automatic** — gramjs auto-sleeps for waits under `floodSleepThreshold`. Only catch `FloodWaitError` for waits above threshold.
2. **Safety multiplier** — Always multiply FLOOD_WAIT by 1.5x or more to avoid repeated violations.

### Context Key Format
```
telegram:{dialogId}:{threadId}
```
- threadId is 0 for non-forum chats
- Use `buildContextKey()` helper from settings.ts

## Future Improvements

- [ ] Real-time updates via persistent connection (UpdateHandler)
- [ ] Media download and storage
- [ ] Reaction tracking
- [ ] Poll/quiz result tracking
- [ ] Voice message transcription
- [ ] Sticker/emoji logging
- [ ] Story collection
- [ ] Support for multiple accounts
