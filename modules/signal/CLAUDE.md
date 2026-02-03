# Signal Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the Signal module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The Signal module collects messages from Signal messenger using signal-cli as a linked device. Unlike other platforms, Signal's E2E encryption means **messages only exist on local devices** — there is no server API to query.

## ⚠️ CRITICAL: Understand Signal's Architecture

### This Is NOT Like Other Platforms

```
SLACK/TELEGRAM/DISCORD:
  Server has messages → API fetches from server → Full history available

SIGNAL:
  Server CANNOT read messages → No API possible → Local device only
  ↓
  signal-cli acts as a linked device
  ↓
  Only receives messages AFTER linking
  ↓
  Historical messages are CRYPTOGRAPHICALLY INACCESSIBLE
```

### What E2E Encryption Means For Us

1. **No getHistory() equivalent** — Messages before linking don't exist for us
2. **No server-side storage** — Signal's servers store encrypted blobs they can't read
3. **Forward secrecy** — Past encryption keys are deliberately destroyed
4. **Local decryption** — signal-cli decrypts on the machine running it

**Do NOT try to:**
- Fetch historical messages (impossible)
- Access another user's messages (impossible)
- Query Signal's servers for content (impossible)
- "Sync" with the user's phone history (impossible)

## Architecture Decisions

### Why signal-cli

| Option | Status | Verdict |
|--------|--------|---------|
| signal-cli | ✅ Active | **Use this** |
| signald | ❌ Deprecated | Don't use |
| libsignal | ✅ Active | Too low-level |
| Official API | ❌ Doesn't exist | Never will |

signal-cli provides:
- JSON-RPC daemon mode (stable interface)
- Device linking (acts as secondary device)
- Message receive/send capabilities
- Group support

### Connection Mode: JSON-RPC Daemon

```
┌─────────────────────────────────────────────────────────────────┐
│                      signal-cli daemon                           │
│                    (long-running process)                        │
├─────────────────────────────────────────────────────────────────┤
│  Maintains Signal session                                        │
│  Decrypts incoming messages                                      │
│  Exposes JSON-RPC interface                                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ JSON-RPC
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FeedEater Signal Module                       │
├─────────────────────────────────────────────────────────────────┤
│  Polls daemon for new messages                                   │
│  Transforms to FeedEater message format                          │
│  Publishes to NATS bus                                           │
└─────────────────────────────────────────────────────────────────┘
```

**Why daemon mode:**
- Session stays alive
- Don't need to authenticate each request
- Can receive messages in real-time
- Protocol requires regular message fetching

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         COLLECT JOB                              │
├─────────────────────────────────────────────────────────────────┤
│  1. Connect to signal-cli daemon (JSON-RPC)                      │
│  2. Call "receive" to get new messages                           │
│  3. For each message:                                            │
│     a. Extract sender, body, timestamp, group                    │
│     b. Handle special types (reactions, disappearing)            │
│     c. Store in mod_signal.signal_messages                       │
│     d. Publish MessageCreated event                              │
│  4. Track last processed timestamp                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    SESSION_CHECK JOB (periodic)                  │
├─────────────────────────────────────────────────────────────────┤
│  1. Verify daemon is responsive                                  │
│  2. Check if linked device still active                          │
│  3. Alert if session expired                                     │
│  4. Log session health metrics                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Context Key Format

```
signal:{phoneNumber}:{conversationId}

Examples:
- signal:+15551234567:+15559876543     (1:1 with specific contact)
- signal:+15551234567:group.abc123...  (group conversation)
```

Phone numbers are in E.164 format (+CountryCode...).
Group IDs are base64-encoded strings prefixed with "group.".

## Key Implementation Details

### JSON-RPC Interface

signal-cli daemon exposes methods like:

```json
// Receive messages
{
  "jsonrpc": "2.0",
  "method": "receive",
  "id": 1
}

// Response includes decrypted messages
{
  "result": {
    "envelope": {
      "source": "+15559876543",
      "timestamp": 1234567890123,
      "dataMessage": {
        "message": "Hello!",
        "groupInfo": null,
        "reaction": null
      }
    }
  }
}
```

### Message Types

```typescript
interface SignalMessage {
  timestamp: number;         // Unix ms
  source: string;            // Sender phone number
  sourceUuid?: string;       // Sender UUID (newer)
  
  // One of these will be present:
  dataMessage?: {
    message: string;
    groupInfo?: { groupId: string };
    reaction?: { emoji: string; targetTimestamp: number };
    quote?: { id: number; author: string; text: string };
    mentions?: Array<{ start: number; length: number; uuid: string }>;
    attachments?: Array<{ contentType: string; filename: string }>;
    expiresInSeconds?: number;
    viewOnce?: boolean;
  };
  
  receiptMessage?: {
    type: 'DELIVERY' | 'READ';
    timestamps: number[];
  };
  
  typingMessage?: {
    action: 'STARTED' | 'STOPPED';
  };
}
```

### Handling Disappearing Messages

```typescript
if (message.dataMessage?.expiresInSeconds) {
  // Message will auto-delete on sender/recipient devices
  const expiresIn = message.dataMessage.expiresInSeconds;
  
  // ETHICAL DECISION: Should FeedEater persist this?
  // Default: Yes, but flag it
  // Setting: handleDisappearing = true/false
}
```

### Group Identification

Groups in Signal v2 use base64 IDs:

```typescript
const groupId = message.dataMessage?.groupInfo?.groupId;
// e.g., "group.YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo="

// Groups don't have human-readable names accessible via signal-cli
// Store the ID, can't reliably get display name
```

## What NOT To Do

### Fundamental Constraints (Don't Even Try)

- **Don't try to fetch historical messages** — They're cryptographically inaccessible
- **Don't try to query Signal's servers** — They can't read the content
- **Don't expect profile names** — Privacy-protected, not reliably available
- **Don't assume continuous operation** — Sessions can expire

### Security Violations

- **Don't log phone numbers in plaintext** in production logs
- **Don't expose session data** — It grants full account access
- **Don't store decrypted attachments** without encryption at rest
- **Don't auto-trust all identities** unless user explicitly opts in

### Protocol Violations

- **Don't ignore session expiry** — Must handle re-linking
- **Don't skip message receives** for too long — Protocol requires regular polling
- **Don't send messages as the user** without explicit consent
- **Don't poll too aggressively** — Rate limits apply

### Data Handling

- **Don't assume message body exists** — Media-only messages have no body
- **Don't assume contacts exist in address book** — Signal doesn't sync contacts
- **Don't persist view-once media** — Violates sender intent
- **Don't ignore expiresInSeconds** — At minimum, flag these messages

## Signal-Specific Quirks

### Phone Numbers vs UUIDs

Signal is transitioning from phone numbers to UUIDs:

```typescript
// Old: phone number only
source: "+15551234567"

// New: both available
source: "+15551234567"
sourceUuid: "abc123-def456-..."

// Store both, prefer UUID for future compatibility
```

### Safety Numbers

When a contact reinstalls Signal, their "safety number" changes:

```
Untrusted identity for: +15559876543
```

Options:
- Manual trust: `signal-cli trust -a +15559876543`
- Auto-trust: `trustAllIdentities` setting (security trade-off)

### Session Expiry

signal-cli sessions expire if:
- User terminates from phone (Linked Devices)
- Prolonged inactivity (weeks without receiving)
- Account security events

**Detection:** Watch for auth errors in JSON-RPC responses.

**Recovery:** Re-link the device. Messages during downtime are LOST.

### View-Once Media

```typescript
if (message.dataMessage?.viewOnce) {
  // Sender intended this to be viewed once then deleted
  // Signal deletes from server after delivery
  // ETHICAL: Should FeedEater preserve this?
  // Recommendation: Don't persist, or make it opt-in only
}
```

## Database Schema Considerations

### Private Schema: `mod_signal`

```sql
-- Messages received via signal-cli
CREATE TABLE mod_signal.signal_messages (
  id SERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,           -- Signal timestamp (ms)
  source_phone VARCHAR(20) NOT NULL,   -- E.164 format
  source_uuid VARCHAR(50),             -- UUID if available
  group_id VARCHAR(100),               -- NULL for 1:1
  body TEXT,                           -- Decrypted message (may be NULL)
  message_type VARCHAR(20) NOT NULL,   -- 'data', 'receipt', 'reaction'
  expires_in_seconds INTEGER,          -- Disappearing timer
  view_once BOOLEAN DEFAULT false,
  raw_envelope JSONB,                  -- Full message for debugging
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(timestamp, source_phone)      -- Dedup key
);

-- Embeddings for semantic search
CREATE TABLE mod_signal.signal_message_embeddings (
  message_id INTEGER REFERENCES mod_signal.signal_messages(id),
  embedding vector(4096),
  PRIMARY KEY (message_id)
);
```

### Deduplication

Signal timestamps are unique per sender:

```typescript
// Dedup key: (timestamp, source_phone)
// This handles duplicate receives from daemon restarts
```

## Error Handling

### JSON-RPC Errors

```typescript
interface JsonRpcError {
  code: number;
  message: string;
}

// Common errors:
// -32600 Invalid Request
// -32601 Method not found
// Custom codes for Signal-specific errors
```

### Session Errors

```typescript
if (error.message.includes('Unregistered') || 
    error.message.includes('Not found')) {
  // Session dead - need re-linking
  await notifySessionExpired();
}
```

### Network Errors

signal-cli daemon may disconnect. Implement reconnection:

```typescript
async function withDaemonConnection<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isConnectionError(e)) {
      await reconnectToDaemon();
      return await fn(); // Retry once
    }
    throw e;
  }
}
```

## Testing Locally

1. **Install signal-cli**
   ```bash
   # See README for installation
   ```

2. **Link device**
   ```bash
   signal-cli link -n "FeedEater-Dev"
   # Scan QR with phone
   ```

3. **Start daemon**
   ```bash
   signal-cli -u +1XXXXXXXXXX daemon --json-rpc
   ```

4. **Send yourself a test message**
   - Use phone to send to yourself
   - Or use another Signal account

5. **Verify receipt**
   ```bash
   curl -X POST http://localhost:8080 \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"receive","id":1}'
   ```

## Realistic Scope

### What FeedEater CAN Do

✅ Collect messages received after linking
✅ Track group conversations
✅ Handle reactions and replies
✅ Note disappearing message timers
✅ Store attachments metadata
✅ Build conversation contexts going forward

### What FeedEater CANNOT Do

❌ Import historical messages (before linking)
❌ Access messages from user's phone
❌ Get contact names/profiles reliably
❌ Sync across multiple instances (one daemon per account)
❌ Survive session expiry without re-linking

### Priority Assessment

**Medium priority because:**
- Valuable for privacy-conscious power users
- Limited to forward-looking collection
- More complex setup than API-based platforms
- Session maintenance overhead
- But: Signal is increasingly important messaging platform

## Lessons Learned

### From Implementation (2025-07-11)

1. **Use SDK types not pg types** — The module-sdk provides `DbLike`, `NatsLike`, `StringCodecLike` which are more flexible than importing directly from `pg` and `nats`. This avoids type compatibility issues between the SDK's abstractions and the concrete implementations.

2. **Query results need explicit typing** — When using `DbLike.query()`, the return type is `Promise<unknown>`. Cast results explicitly: `(await this.db.query(...)) as { rows: Array<{ ... }> }`.

3. **Optional properties vs undefined** — TypeScript's `exactOptionalPropertyTypes` means `{ errorMessage?: string }` is NOT the same as `{ errorMessage: string | undefined }`. Use spread syntax to conditionally include properties: `...(errorMessage !== undefined ? { errorMessage } : {})`.

4. **shims.d.ts for development** — Create a `shims.d.ts` file with minimal type declarations for external dependencies. This allows the editor/typecheck to work even without `node_modules` installed.

5. **signal-cli RPC interface** — The daemon exposes JSON-RPC at port 7583 by default. Key methods: `receive` (get messages), `listIdentities` (health check). The `account` parameter is required for multi-account setups.

6. **Deduplication key** — Signal messages are uniquely identified by `(timestamp, source_phone)`. This is the natural dedup key since timestamps are unique per sender.

### From signal-cli Community

1. **Keep daemon running** — Sessions that don't receive messages may expire
2. **Trust management is annoying** — Consider `trustAllIdentities` for personal use
3. **Group names aren't accessible** — signal-cli doesn't expose group display names
4. **Attachments need explicit download** — Not included in receive by default

### Ethical Considerations

1. **Disappearing messages exist for a reason** — Users chose privacy
2. **Signal users often have higher privacy expectations** — Be respectful
3. **Persistence vs intent** — Document your choices clearly
4. **Transparency** — Users should know FeedEater is collecting

## Future Improvements

- [ ] Real-time message handling (daemon websocket?)
- [ ] Attachment download and storage
- [x] Reaction tracking and context updates *(implemented in collect job)*
- [x] Disappearing message policy configuration *(handleDisappearing setting)*
- [x] Session health monitoring and alerts *(sessionCheck job)*
- [ ] Multi-account support (multiple daemons)
- [ ] Group member tracking
- [ ] Better error recovery for session expiry
