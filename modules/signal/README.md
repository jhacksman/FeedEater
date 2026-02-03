# Signal Module for FeedEater

> **Priority: MEDIUM** — Signal is valuable for privacy-conscious users but has fundamental architectural constraints. E2E encryption means NO server-side message access — only forward-looking collection is possible after device linking.

## ⚠️ Critical: Signal is Different

**Signal is not like other platforms.** Before proceeding, understand these fundamental constraints:

| Aspect | Most Platforms | Signal |
|--------|---------------|--------|
| Message Storage | Server-side | **Device-only** |
| API Access | Full history via API | **None** |
| Historical Messages | ✅ Fetchable | ❌ **Impossible** |
| Data Collection Start | Any time in past | **Linking moment onward** |
| Server Can Read Messages | Yes (encrypted in transit) | **No** (E2E encrypted) |

**What this means for FeedEater:**
- Can only collect messages received **AFTER** you link signal-cli
- Cannot import existing message history
- Must maintain an active signal-cli session (sessions expire)
- Signal deliberately does not provide an API — respect this design

## Overview

This module collects messages from Signal using [signal-cli](https://github.com/AsamK/signal-cli), an unofficial command-line client. signal-cli acts as a **secondary linked device** (like Signal Desktop), receiving messages in real-time.

## Tool Comparison

### signal-cli (Recommended)

| Aspect | Details |
|--------|---------|
| **Status** | Actively maintained |
| **Interface** | CLI, JSON-RPC daemon, D-Bus |
| **Implementation** | Java (patched libsignal-service-java) |
| **Install** | JRE 25+, native binary available |
| **Best For** | Server notifications, bots, FeedEater |

### signald (Deprecated)

| Aspect | Details |
|--------|---------|
| **Status** | ❌ **No longer maintained** |
| **Recommendation** | Use signal-cli instead |
| **Note** | Was Unix socket-based daemon |

### libsignal (Official)

| Aspect | Details |
|--------|---------|
| **Status** | Actively maintained by Signal |
| **Purpose** | Cryptographic primitives only |
| **Use Case** | Building official Signal apps |
| **For FeedEater** | ❌ Not directly usable |

**Decision:** Use signal-cli in JSON-RPC daemon mode.

## Authentication Approaches

### Option A: Device Linking (Recommended)

Link signal-cli as a secondary device to your phone:

```bash
# Generate a link URI (displays QR code or URI)
signal-cli link -n "FeedEater"

# Scan the QR code with Signal app:
# Settings → Linked Devices → Link New Device
```

**Pros:**
- No phone number verification needed
- Uses existing Signal account
- Appears in "Linked Devices" list

**Cons:**
- Primary device (phone) must stay active
- Session can be terminated from phone
- Only receives messages after linking

### Option B: New Registration (Not Recommended)

Register a new phone number directly with signal-cli:

```bash
# Register (requires SMS/voice verification)
signal-cli -u +1XXXXXXXXXX register

# Verify with code received
signal-cli -u +1XXXXXXXXXX verify 123-456
```

**Why not recommended:**
- Requires dedicated phone number
- Subject to CAPTCHA challenges
- Creates a separate Signal identity
- Contacts won't recognize this as you

## Setup Guide

### Step 1: Install signal-cli

```bash
# Download latest release
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} \
  https://github.com/AsamK/signal-cli/releases/latest | sed 's/.*\/v//')

# Native binary (recommended for Docker)
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
tar xf signal-cli-${VERSION}-Linux-native.tar.gz

# Or JVM version (requires JRE 25+)
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}.tar.gz"
tar xf signal-cli-${VERSION}.tar.gz -C /opt
ln -sf /opt/signal-cli-${VERSION}/bin/signal-cli /usr/local/bin/
```

### Step 2: Link Device

```bash
# Start linking process
signal-cli link -n "FeedEater"

# This outputs a URI like:
# sgnl://linkdevice?uuid=...&pub_key=...

# Generate QR code (optional)
qrencode -t ANSIUTF8 "sgnl://linkdevice?uuid=..."

# Open Signal on phone:
# Settings → Linked Devices → Link New Device → Scan QR
```

### Step 3: Start Daemon

```bash
# Run JSON-RPC daemon (recommended)
signal-cli -u +1XXXXXXXXXX daemon --json-rpc

# Or with socket
signal-cli -u +1XXXXXXXXXX daemon --socket /var/run/signal-cli.socket
```

### Step 4: Configure FeedEater

In FeedEater settings, configure:
- Phone number (account identifier)
- Daemon connection (socket or HTTP)
- Collection preferences

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `phoneNumber` | string | (required) | Phone number in international format (+1XXXXXXXXXX) |
| `daemonSocket` | string | `/var/run/signal-cli.socket` | Unix socket path for signal-cli daemon |
| `daemonRpcUrl` | string | `http://localhost:8080` | JSON-RPC endpoint if using HTTP |
| `connectionMode` | enum | `socket` | `socket` or `jsonrpc` |
| `collectGroups` | boolean | `true` | Collect group messages |
| `collectPrivate` | boolean | `true` | Collect 1:1 messages |
| `collectReactions` | boolean | `true` | Track message reactions |
| `trustAllIdentities` | boolean | `false` | Auto-trust new contacts (security trade-off) |
| `handleDisappearing` | boolean | `true` | Capture messages with disappearing timers |
| `pollIntervalMs` | number | `5000` | Polling interval in daemon mode |
| `sessionCheckIntervalHours` | number | `24` | How often to verify session is alive |

## E2E Encryption: What It Means

### How Signal Encryption Works

```
┌─────────────┐     E2E Encrypted     ┌─────────────┐
│   Sender    │ ──────────────────▶   │  Recipient  │
│   Device    │                       │   Device    │
└─────────────┘                       └─────────────┘
                         │
                         │ Signal Server sees:
                         │ - Who sent to whom (metadata)
                         │ - Encrypted blob (unreadable)
                         │ - NOT the message content
```

### Implications for FeedEater

1. **No server API exists** — Signal servers cannot read messages
2. **Local decryption only** — signal-cli decrypts on your machine
3. **Forward secrecy** — Past messages cannot be decrypted with new keys
4. **No history import** — Messages before linking are inaccessible

### The "Double Ratchet" Algorithm

Signal uses the Double Ratchet algorithm:
- Each message uses a unique encryption key
- Keys are "ratcheted" forward after each message
- Cannot derive past keys from current state
- This is why historical access is **cryptographically impossible**

## Data Available

### Per Message (After Linking)

| Field | Description |
|-------|-------------|
| `timestamp` | Unix timestamp (ms) |
| `sender` | Phone number or UUID |
| `body` | Decrypted message text |
| `groupId` | Group identifier (if group message) |
| `quote` | Replied-to message reference |
| `reaction` | Emoji reaction to another message |
| `attachments` | List of attachment metadata |
| `mentions` | @-mentioned users |
| `expiresInSeconds` | Disappearing message timer |
| `isViewOnce` | View-once media flag |

### What You DON'T Get

- ❌ Message history before linking
- ❌ Sender's profile name (privacy protected)
- ❌ Read receipts from others
- ❌ Typing indicators
- ❌ Contact list from phone

## Disappearing Messages

Signal supports disappearing messages (auto-delete after timer):

| Timer | Behavior |
|-------|----------|
| Off | Normal message, persists |
| 30s - 1 week | Deletes after recipient views + timer |

**FeedEater handling:**
- Capture message when received
- Note the expiration timer
- Message content preserved in FeedEater (unless you choose not to)
- Original disappears from Signal per sender's intent

**Ethical consideration:** Respect that senders chose disappearing messages for privacy. Consider whether to persist them.

## Groups

Signal groups are identified by base64 group IDs:

```javascript
// Group ID format
"group.abc123xyz..." // Base64 encoded

// Group types
- Basic groups (legacy)
- Groups v2 (current, with admin features)
```

Context mapping: `signal:{phoneNumber}:{groupId}`

## Rate Limits & Anti-Spam

Signal implements anti-spam measures:

| Protection | Behavior |
|------------|----------|
| CAPTCHA on register | May need to solve CAPTCHA |
| Rate limiting | Too many messages = temporary block |
| Spam detection | Accounts sending to many non-contacts flagged |
| Session limits | ~5 linked devices max |

**For FeedEater (receive-only):** Less concerning since we're receiving, not sending.

## Session Maintenance

signal-cli sessions can expire or be terminated:

### Keep Session Alive

```bash
# Receive messages regularly (protocol requirement)
signal-cli -u +1XXXXXXXXXX receive

# Or run daemon continuously
signal-cli -u +1XXXXXXXXXX daemon --json-rpc
```

**Critical:** Signal protocol expects clients to regularly fetch messages. Inactive sessions may be terminated.

### Session Expired?

If you see "session expired" or "unregistered":
1. Check Linked Devices in Signal app
2. Re-link if terminated
3. Note: Any messages during downtime are **lost forever**

## Data Storage

signal-cli stores data in:

```
~/.local/share/signal-cli/data/
├── +1XXXXXXXXXX/           # Per-account folder
│   ├── account.db          # SQLite database
│   └── ...
```

**Security:** This contains decrypted message history. Protect accordingly.

## Docker Deployment

```dockerfile
FROM eclipse-temurin:25-jre

# Install signal-cli
RUN curl -L -o /tmp/signal-cli.tar.gz \
    https://github.com/AsamK/signal-cli/releases/download/v0.XX.X/signal-cli-0.XX.X.tar.gz \
    && tar xf /tmp/signal-cli.tar.gz -C /opt \
    && ln -s /opt/signal-cli-*/bin/signal-cli /usr/local/bin/

# Data persistence
VOLUME /data
ENV SIGNAL_CLI_DATA=/data

# Run daemon
CMD ["signal-cli", "--config", "/data", "-u", "${PHONE_NUMBER}", "daemon", "--json-rpc"]
```

**Important:** Mount `/data` as a persistent volume to preserve session.

## Troubleshooting

### "Device not linked"
Re-run link process. Check Signal app → Linked Devices.

### "Untrusted identity"
Contact's safety number changed. Run:
```bash
signal-cli -u +1XXXXXXXXXX trust -a CONTACT_NUMBER
```
Or enable `trustAllIdentities` setting (security trade-off).

### "No messages received"
- Verify daemon is running
- Check linked device still active on phone
- Ensure `receive` is being called regularly

### "CAPTCHA required"
During registration only. See [signal-cli wiki](https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha).

### "Rate limit exceeded"
Wait and retry. Reduce request frequency.

## Security Considerations

1. **Session data = full account access**
   - Protect `~/.local/share/signal-cli/` directory
   - Anyone with this data can impersonate you

2. **Linked device visibility**
   - Users can see "FeedEater" in their Linked Devices
   - They can terminate your session at any time

3. **Message persistence**
   - FeedEater persists messages that may have been disappearing
   - Consider the ethical implications

4. **Metadata**
   - Even with E2E encryption, Signal sees some metadata
   - FeedEater stores additional metadata locally

## Ethical Considerations

Signal exists because people want private communication. When building this module:

- **Don't persist disappearing messages** unless users explicitly opt in
- **Don't share decrypted content** outside FeedEater
- **Respect that others chose Signal for privacy**
- **Be transparent** about your FeedEater setup if appropriate

## Related Resources

- [signal-cli GitHub](https://github.com/AsamK/signal-cli)
- [signal-cli Wiki](https://github.com/AsamK/signal-cli/wiki)
- [Signal Protocol Specification](https://signal.org/docs/)
- [Double Ratchet Algorithm](https://signal.org/docs/specifications/doubleratchet/)
- [libsignal (official)](https://github.com/signalapp/libsignal)
