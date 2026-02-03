# Signal Module Implementation Plan

**Created:** 2025-07-11
**Status:** Planning

## Overview

Implement the Signal module for FeedEater following the Slack module patterns. This module will collect messages from Signal using signal-cli as a linked device.

## Key Constraints (from CLAUDE.md)

1. **No historical messages** - Signal's E2E encryption means we can only receive messages AFTER device linking
2. **signal-cli daemon mode** - Use JSON-RPC interface for reliable connection
3. **Forward-only collection** - No server API, local device only
4. **Session management** - Sessions can expire, need health monitoring
5. **Ethical considerations** - Respect disappearing messages and view-once settings

## Architecture

```
signal-cli daemon (JSON-RPC on :7583)
        ↓
SignalIngestor (polls daemon)
        ↓
┌───────────────────────────────────┐
│  mod_signal.signal_messages       │
│  mod_signal.signal_message_embeddings │
│  mod_signal.signal_session_health │
└───────────────────────────────────┘
        ↓
NATS: feedeater.signal.messageCreated
NATS: feedeater.signal.contextUpdated
```

## Files to Create/Update

### 1. `src/ingest.ts` - SignalIngestor Class

Core responsibilities:
- Connect to signal-cli daemon via JSON-RPC
- Poll for new messages using `receive` method
- Transform Signal messages to FeedEater format
- Store in PostgreSQL
- Publish MessageCreated events to NATS
- Generate embeddings for semantic search
- Track session health

Key methods:
- `constructor(settings, db, nats, sc, opts)`
- `ensureSchema()` - Create/verify database tables
- `collectAndPersist()` - Main collection job
- `refreshContexts(params)` - AI context summarization
- `checkSessionHealth()` - Verify daemon/session alive
- Private helpers for JSON-RPC communication

### 2. `src/runtime.ts` - Job Handlers

Three jobs from module.json:
- `collect` - Receive new messages from daemon
- `sessionCheck` - Verify session health
- `updateContexts` - Generate AI summaries

### 3. `src/index.ts` - Exports

Export:
- `SignalIngestor`
- `parseSignalSettingsFromInternal`
- `SignalSettings` type
- `createModuleRuntime`

### 4. `package.json` - Dependencies

```json
{
  "dependencies": {
    "@feedeater/core": "0.0.1",
    "@feedeater/module-sdk": "0.0.1",
    "nats": "^2.29.3",
    "pg": "^8.16.3",
    "uuid": "^11.1.0",
    "zod": "^3.25.76"
  }
}
```

Note: No signal-cli npm package needed - we communicate via JSON-RPC HTTP

### 5. `tsconfig.json` - TypeScript Config

Extend base config, output to `dist/`

## Implementation Details

### Signal Message Types to Handle

```typescript
interface SignalEnvelope {
  source: string;           // Phone number
  sourceUuid?: string;      // UUID
  timestamp: number;        // Unix ms
  dataMessage?: {
    message: string;
    groupInfo?: { groupId: string };
    reaction?: { emoji: string; targetTimestamp: number };
    quote?: { id: number; author: string; text: string };
    expiresInSeconds?: number;
    viewOnce?: boolean;
    attachments?: Array<{ contentType: string; filename?: string }>;
  };
  receiptMessage?: { type: 'DELIVERY' | 'READ'; timestamps: number[] };
  typingMessage?: { action: 'STARTED' | 'STOPPED' };
}
```

### Context Key Format

```
signal:{phoneNumber}:{conversationId}

Examples:
- signal:+15551234567:+15559876543     (1:1 chat)
- signal:+15551234567:group.YWJjZGU=   (group chat)
```

### JSON-RPC Communication

```typescript
async function rpcCall(method: string, params?: object): Promise<any> {
  const response = await fetch(this.settings.daemonRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: params ?? {},
      id: ++this.rpcId
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}
```

### Filtering Logic

```typescript
function shouldCollectMessage(msg: SignalMessage, settings: SignalSettings): boolean {
  // Check whitelist/blacklist for contacts
  if (settings.includeContacts.length > 0) {
    if (!settings.includeContacts.includes(msg.source)) return false;
  }
  if (settings.excludeContacts.includes(msg.source)) return false;

  // Check whitelist/blacklist for groups
  if (msg.groupId) {
    if (settings.includeGroups.length > 0) {
      if (!settings.includeGroups.includes(msg.groupId)) return false;
    }
    if (settings.excludeGroups.includes(msg.groupId)) return false;
  }

  // Check message type (group vs private)
  if (msg.groupId && !settings.collectGroups) return false;
  if (!msg.groupId && !settings.collectPrivate) return false;

  // Check message length
  if (msg.body && msg.body.length < settings.minMessageLength) return false;

  return true;
}
```

### Ethical Handling

```typescript
// View-once: respect sender intent
if (msg.viewOnce && !settings.persistViewOnce) {
  // Store metadata only, not content
  body = '[view-once media]';
}

// Disappearing: flag but allow collection (configurable)
if (msg.expiresInSeconds && !settings.handleDisappearing) {
  // Skip or flag only
}
```

## Execution Order

1. Create `src/` directory
2. Write `src/ingest.ts` (largest file, ~500 lines)
3. Write `src/runtime.ts` (~80 lines)
4. Write `src/index.ts` (~10 lines)
5. Write `package.json`
6. Write `tsconfig.json`
7. Test TypeScript compilation
8. Git commit

## Testing Strategy

1. TypeScript compilation (`npm run typecheck`)
2. Build (`npm run build`)
3. Manual verification of schema against CLAUDE.md specs
4. Document any issues in CLAUDE.md lessons learned

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| signal-cli API changes | Document version tested, use conservative API |
| Session expiry | sessionCheck job, clear error messages |
| Rate limiting | Configurable poll interval |
| Large group messages | Batch processing, limit lookback |

## Success Criteria

- [ ] TypeScript compiles without errors
- [ ] All jobs defined in module.json have handlers
- [ ] Schema matches CLAUDE.md specifications
- [ ] Settings from settings.ts are properly parsed
- [ ] Events follow FeedEater core schemas
- [ ] Code follows Slack module patterns

---

**Next Step:** Execute - implement src/ingest.ts
