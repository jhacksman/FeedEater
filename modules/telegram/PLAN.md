# Telegram Module Implementation Plan

## Overview
Implement FeedEater's Telegram module using MTProto via gramjs for full access to user's chat history.

## Phase 1: Project Setup

### 1.1 Create package.json
- Dependencies: `telegram` (gramjs), `big-integer`, `nats`, `pg`, `uuid`, `zod`
- Dev dependencies: `@types/node`, `@types/pg`, `tsup`, `typescript`
- Build script using tsup (same as Slack)

### 1.2 Create tsconfig.json
- Extend from `../../tsconfig.base.json`
- Include src/**/*.ts and settings.ts

### 1.3 Create src directory structure
```
src/
├── index.ts      # Exports
├── ingest.ts     # TelegramIngestor class
└── runtime.ts    # Job handlers
```

## Phase 2: TelegramIngestor (src/ingest.ts)

### 2.1 Settings Parser
- `parseTelegramSettingsFromInternal()` - Parse raw settings to typed `TelegramSettings`
- Validate required fields: apiId, apiHash, sessionString

### 2.2 TelegramIngestor Class
Constructor params:
- settings: TelegramSettings
- db: Pool (Postgres)
- nats: NatsConnection
- sc: StringCodec
- opts: { apiBaseUrl, internalToken, contextTopK, embedDim }

#### Core Methods:

**`ensureSchema()`**
- Create mod_telegram schema
- Create telegram_messages table (id, dialog_id, message_id, ts, author_id, author_name, text, reply_to_msg_id, thread_id, payload, collected_at)
- Create telegram_message_embeddings table (id, dialog_id, context_key, ts, embedding)
- Create indexes

**`connect()`**
- Create TelegramClient with StringSession
- Connect with retry logic
- Handle AUTH_KEY_UNREGISTERED gracefully

**`disconnect()`**
- Clean disconnect from Telegram

**`fetchDialogs()`**
- Use client.getDialogs()
- Filter by settings (dialog types, include/exclude lists, archived)
- Cache dialog metadata

**`fetchMessagesForDialog(dialogId, sinceId)`**
- Use client.iterMessages() with offsetId
- Handle pagination properly
- Respect minMessageLength setting
- Return normalized message array

**`collectAndPersist()`**
- Connect to Telegram
- Fetch filtered dialogs
- For each dialog, fetch messages since last collected
- Upsert into telegram_messages
- Publish MessageCreated events for new messages
- Generate and store embeddings
- Disconnect
- Return metrics

**`refreshContexts(lookbackHours)`**
- Find distinct contexts in recent messages
- For forum topics: treat each topic as separate context
- For regular chats: group by dialog
- Query similar messages using embeddings
- Generate AI summaries
- Publish ContextUpdated events
- Return metrics

### 2.3 Helper Methods
- `log()` - Publish to feedeater.telegram.log
- `aiGenerate()` - Call AI summary endpoint
- `aiEmbed()` - Call AI embedding endpoint
- `publishContextUpdate()` - Emit ContextUpdated event
- `getDialogType()` - Determine channel/supergroup/group/private
- `buildMessageId()` - Generate deterministic UUID from dialog+msg_id

### 2.4 Error Handling
- FLOOD_WAIT: Wait with multiplier, retry
- SESSION_REVOKED: Log error, fail gracefully
- Network errors: Retry with backoff
- Individual dialog errors: Continue to next dialog

## Phase 3: Runtime (src/runtime.ts)

### 3.1 createModuleRuntime()
Return ModuleRuntime with handlers for queue `mod_telegram`:

**`collect` handler:**
1. Fetch telegram settings
2. Check if enabled
3. Fetch system settings (contextTopK, embedDim)
4. Create TelegramIngestor
5. Ensure schema
6. Run collectAndPersist()
7. Return metrics

**`updateContexts` handler:**
1. Fetch telegram settings
2. Check if enabled
3. Fetch system settings
4. Create TelegramIngestor
5. Ensure schema
6. Run refreshContexts()
7. Return metrics

## Phase 4: Exports (src/index.ts)

Export:
- TelegramIngestor class
- parseTelegramSettingsFromInternal function
- TelegramSettings type
- createModuleRuntime function

## Phase 5: Verification

### 5.1 TypeScript Compilation
- Run `pnpm build` in module directory
- Fix any type errors
- Ensure no `any` types (strict mode)

### 5.2 Integration Check
- Verify module.json job names match handlers
- Verify settings.ts types match module.json schema
- Verify context key format matches CLAUDE.md spec

## Data Model

### telegram_messages table
```sql
CREATE TABLE mod_telegram.telegram_messages (
  id text PRIMARY KEY,                    -- telegram-{dialogId}-{messageId}
  dialog_id text NOT NULL,                -- Telegram dialog ID (may be negative)
  message_id bigint NOT NULL,             -- Telegram message ID within dialog
  message_id_num bigint NOT NULL,         -- For sorting
  ts timestamptz NOT NULL,                -- Message timestamp
  author_id text,                         -- Sender ID
  author_name text,                       -- Sender display name
  text text,                              -- Message text content
  reply_to_msg_id bigint,                 -- If reply, the parent message ID
  thread_id bigint,                       -- Forum topic ID (if applicable)
  is_forum_topic boolean DEFAULT false,
  payload jsonb NOT NULL,                 -- Full message data
  collected_at timestamptz DEFAULT now()
);
```

### telegram_message_embeddings table
```sql
CREATE TABLE mod_telegram.telegram_message_embeddings (
  id text PRIMARY KEY,
  dialog_id text NOT NULL,
  context_key text NOT NULL,
  ts timestamptz NOT NULL,
  embedding vector(N)
);
```

## Context Key Format
```
telegram:{dialogId}:{threadId}

Examples:
- telegram:-1001234567890:0      # Main chat
- telegram:-1001234567890:12345  # Forum topic
- telegram:self:0                # Saved Messages
```

## gramjs Usage Patterns

### Connection
```typescript
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

const client = new TelegramClient(
  new StringSession(sessionString),
  apiId,
  apiHash,
  { connectionRetries: 5, floodSleepThreshold: 60 }
);
await client.connect();
```

### Fetch Dialogs
```typescript
const dialogs = await client.getDialogs({});
for (const dialog of dialogs) {
  // dialog.id, dialog.name, dialog.isChannel, dialog.isGroup, etc.
}
```

### Fetch Messages
```typescript
for await (const msg of client.iterMessages(dialogId, {
  limit: 100,
  offsetId: lastMessageId,
  reverse: true
})) {
  // msg.id, msg.message, msg.date, msg.senderId, etc.
}
```

### FLOOD_WAIT Handling
```typescript
import { FloodWaitError } from 'telegram/errors';

try {
  await client.getDialogs({});
} catch (e) {
  if (e instanceof FloodWaitError) {
    await sleep(e.seconds * 1000 * settings.floodWaitMultiplier);
    // retry
  }
}
```

## Implementation Order
1. package.json, tsconfig.json
2. src/ingest.ts (core class)
3. src/runtime.ts (job handlers)
4. src/index.ts (exports)
5. Verify TypeScript compiles
6. Commit and push

## Notes
- Use gramjs `telegram` package (not `telegram-mtproto`)
- BigInteger handling: gramjs returns bigInt for IDs
- Dialog IDs can be negative (groups/channels)
- Saved Messages: use string "self" or user's own ID
- Forum topics require special handling via GetForumTopics API
