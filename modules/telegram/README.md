# Telegram Module for FeedEater

> **Priority: HIGH** — Telegram has the most open API of any major platform. MTProto offers full access to a user's entire message history, chat list, and real-time updates.

## Overview

This module collects messages from Telegram chats and organizes them into FeedEater's Context system. Unlike most platforms, Telegram offers **two completely different APIs** with dramatically different capabilities.

## API Comparison: Bot API vs MTProto

| Feature | Bot API | MTProto (User Client) |
|---------|---------|----------------------|
| **Setup Complexity** | Simple (HTTP + token) | Complex (auth flow + session) |
| **Access Scope** | Only chats where bot is present | User's entire chat history |
| **User's Chat List** | ❌ No | ✅ Yes (`messages.getDialogs`) |
| **Private Chats** | Only if user messages bot | ✅ Full access |
| **Channel History** | Only if bot is admin/member | ✅ Full access to joined channels |
| **Group History** | Only messages after bot joined | ✅ Full history |
| **Saved Messages** | ❌ No | ✅ Yes |
| **Reactions** | Limited (admin only) | ✅ Full access |
| **Message Editing** | Real-time updates | ✅ Full history |
| **Rate Limits** | 30 msg/sec per bot | Generous (FLOOD_WAIT based) |
| **Library** | Any HTTP client | gramjs (TypeScript MTProto) |
| **Auth Storage** | Single token | Encrypted session string |

### When to Use Which

**Use Bot API when:**
- Building a bot that responds to commands
- Only need messages sent directly to the bot
- Want minimal setup complexity
- Building notification/alert systems

**Use MTProto (recommended for FeedEater) when:**
- Need the user's complete chat list
- Want to ingest private conversations
- Need full channel/group history
- Want to collect Saved Messages
- Building a personal feed aggregator (our use case!)

## Architecture Decision

**FeedEater should use MTProto via gramjs** because:
1. We need access to the user's chat list to know what to collect
2. We want historical messages, not just new ones
3. Private chats are often the most valuable content
4. Saved Messages is a common "read later" inbox

## Prerequisites

### For MTProto (Recommended)

1. **Telegram API Credentials**
   - Go to https://my.telegram.org/
   - Log in with your phone number
   - Click "API development tools"
   - Create a new application (any name)
   - Save your `api_id` (number) and `api_hash` (string)

2. **Initial Authentication** (one-time)
   - Run the setup script (generates session string)
   - Enter phone number when prompted
   - Enter 2FA password if enabled
   - Enter verification code from Telegram
   - Save the session string to module settings

### For Bot API (Limited)

1. **Create a Bot**
   - Message [@BotFather](https://t.me/BotFather) on Telegram
   - Send `/newbot` and follow prompts
   - Save the bot token (format: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

2. **Add Bot to Chats**
   - Add the bot to every group/channel you want to monitor
   - Bot must be admin to read channel history

## Setup Guide (MTProto)

### Step 1: Get API Credentials

```bash
# Visit https://my.telegram.org/
# Log in → API development tools → Create application
# Note your api_id and api_hash
```

### Step 2: Generate Session String

Run this one-time auth script (will be part of module setup):

```bash
# In FeedEater's Telegram module setup UI:
# 1. Enter api_id and api_hash
# 2. Click "Authenticate"
# 3. Enter phone number in the prompt
# 4. Enter 2FA password if requested
# 5. Enter verification code from Telegram app
# 6. Session string is saved automatically
```

The session string is ~300+ characters and contains encrypted auth data. **Never share it** — it provides full account access.

### Step 3: Configure Collection

In FeedEater settings, specify which chats to collect:

- **All dialogs**: Collect from every chat in the user's list
- **Selected chats**: Only specific chat IDs
- **Chat types**: Channels only, groups only, private only, etc.
- **Exclude archived**: Skip archived chats

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `apiId` | number | (required) | Telegram API ID from my.telegram.org |
| `apiHash` | string | (required) | Telegram API hash from my.telegram.org |
| `sessionString` | secret | (required) | Encrypted auth session (generated during setup) |
| `collectDialogTypes` | string[] | `["channel", "group", "private"]` | Which chat types to collect |
| `excludeArchived` | boolean | `true` | Skip archived chats |
| `lookbackHours` | number | `168` (7 days) | How far back to fetch on first run |
| `includeDialogIds` | string[] | `[]` | If set, ONLY collect from these chats |
| `excludeDialogIds` | string[] | `[]` | Never collect from these chats |
| `collectSavedMessages` | boolean | `true` | Include user's Saved Messages |
| `minMessageLength` | number | `0` | Skip messages shorter than this |
| `collectMedia` | boolean | `false` | Download and store media files |
| `floodWaitMultiplier` | number | `1.5` | Multiply FLOOD_WAIT by this for safety |

## Chat Types

Telegram has several chat types, each with different properties:

| Type | Description | Has History | Has Topics |
|------|-------------|-------------|------------|
| `private` | 1-on-1 DMs | ✅ Full | ❌ No |
| `group` | Basic groups (<200k members) | ✅ Full | ❌ No |
| `supergroup` | Large groups (up to 200k) | ✅ Full | ✅ Optional (forums) |
| `channel` | Broadcast channels | ✅ Full | ❌ No |
| `saved` | Saved Messages (self-chat) | ✅ Full | ✅ Yes (new feature) |

### Forum Topics

Supergroups can enable "Topics" mode, creating a forum-like structure. Each topic is like a separate thread:
- Topics have their own message history
- Use `message_thread_id` to identify topic
- Map to FeedEater contexts naturally

## Data Available

### Per Message
- `id` — Unique message ID within chat
- `date` — Unix timestamp
- `message` — Text content (may be empty for media)
- `from_id` — Sender user/channel ID
- `reply_to` — Thread/reply structure
- `reactions` — List of reactions with counts
- `views` — View count (channels)
- `forwards` — Forward count
- `edit_date` — Last edit timestamp
- `media` — Photos, videos, documents, polls, etc.

### Per Chat
- `id` — Unique chat ID
- `title` — Chat name (groups/channels)
- `username` — Public @username if set
- `participants_count` — Member count
- `linked_chat_id` — Discussion group for channels
- `folder_id` — Which folder the chat is in

## Rate Limits

Telegram's rate limits are generous but enforced strictly:

- **FLOOD_WAIT_X**: Must wait X seconds before retrying
- No published limits — server decides based on behavior
- Typical safe rates:
  - `messages.getHistory`: ~50 requests/minute
  - `messages.getDialogs`: ~20 requests/minute
  - Overall: ~30 requests/second across all methods

### Handling FLOOD_WAIT

```
When you receive: FLOOD_WAIT_300
1. Wait 300 * floodWaitMultiplier seconds
2. Retry the request
3. If still failing, exponential backoff
```

gramjs handles this automatically with retry logic.

## Security Considerations

1. **Session String = Full Account Access**
   - Store encrypted in FeedEater's secrets
   - Never log or expose
   - Rotation: Terminate session via Telegram app if compromised

2. **API Credentials**
   - `api_id` and `api_hash` are less sensitive (app-level, not account-level)
   - Still should be stored as secrets

3. **Device Registration**
   - MTProto sessions appear in Telegram's "Active Sessions"
   - Users will see "FeedEater" (or your app name) as an active device
   - Can be terminated from Settings → Privacy → Active Sessions

## Troubleshooting

### "AUTH_KEY_UNREGISTERED"
Session was terminated. Re-authenticate.

### "SESSION_REVOKED"  
User terminated session from Telegram app. Re-authenticate.

### "FLOOD_WAIT_X"
Too many requests. Wait X seconds. Increase `floodWaitMultiplier` if recurring.

### "PHONE_NUMBER_INVALID"
Wrong phone format. Use international format: `+1234567890`

### "PHONE_CODE_EXPIRED"
Verification code timed out. Request new code.

### "PASSWORD_HASH_INVALID"
Wrong 2FA password. Retry carefully.

## Related Resources

- [Telegram Bot API Docs](https://core.telegram.org/bots/api)
- [Telegram MTProto API](https://core.telegram.org/api)
- [gramjs GitHub](https://github.com/gram-js/gramjs)
- [gramjs Documentation](https://gram.js.org)
- [TDLib (alternative)](https://core.telegram.org/tdlib)
