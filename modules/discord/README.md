# Discord Module

**Priority: TBD** (Pending prioritization)

Collects messages from Discord servers and organizes them into Contexts. Threads and forum posts become their own contexts with AI-generated summaries.

## Authentication Approaches

Discord offers two main authentication methods. **Bot tokens are recommended** for FeedEater.

### Bot Token vs OAuth2 Comparison

| Aspect | Bot Token | OAuth2 User Token |
|--------|-----------|-------------------|
| **Scope** | Only servers bot is invited to | Can list user's guilds via `guilds` scope |
| **Message Reading** | Full access to visible channels | `messages.read` only for local RPC, not remote API |
| **Setup Complexity** | Simple - one token | Complex - OAuth flow, token refresh |
| **Real-time Events** | Full Gateway access | Limited Gateway access |
| **Rate Limits** | Standard bot limits | Stricter limits |
| **Recommended For** | Feed collection ✅ | User-facing apps, "Login with Discord" |

**Why Bot Token?** The `messages.read` OAuth scope only works for local Discord RPC (desktop client integration), NOT for reading message history via API. Bot tokens are the only practical way to collect messages at scale.

## API Approaches

### Gateway (WebSocket) vs REST Polling

| Aspect | Gateway (WebSocket) | REST Polling |
|--------|---------------------|--------------|
| **Latency** | Real-time (< 1 second) | 5+ minute intervals typical |
| **Complexity** | High (heartbeat, resume, sharding) | Low (simple HTTP requests) |
| **Connection** | Persistent WebSocket | Stateless requests |
| **Resource Usage** | Higher (always connected) | Lower (on-demand) |
| **Message History** | Events only, no backfill | Can fetch history |
| **Rate Limits** | 120 events/min send limit | Per-endpoint buckets |
| **Recommended For** | High-volume, real-time needs | Periodic collection ✅ |

**Recommendation:** Start with REST polling (like Slack module), add Gateway for real-time needs later.

## Quick Start

### Step 1: Create a Discord Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**
3. Name your app (e.g., "FeedEater") and accept the ToS
4. Click **Create**

### Step 2: Create a Bot User

1. In the left sidebar, click **Bot**
2. Click **Add Bot** (if not already created)
3. Under **Privileged Gateway Intents**, enable:
   - **MESSAGE CONTENT INTENT** ⚠️ Required to read message text!
   - **SERVER MEMBERS INTENT** (optional, for member info)
4. Click **Reset Token** and copy your bot token (you won't see it again!)

### Step 3: Configure Bot Permissions

Under **Bot** > **Bot Permissions**, the minimum required:
- `Read Message History` - Read past messages
- `View Channels` - See channel list

Recommended additions:
- `Read Messages/View Channels` - General read access
- `Add Reactions` - If tracking reactions

The resulting permission integer will be used in your invite URL.

### Step 4: Invite the Bot to Your Server

1. Go to **OAuth2** > **URL Generator**
2. Under **Scopes**, select `bot`
3. Under **Bot Permissions**, select the permissions from Step 3
4. Copy the generated URL and open it in your browser
5. Select the server and authorize

### Step 5: Get Your Server and Channel IDs

**Enable Developer Mode:**
1. User Settings > App Settings > Advanced
2. Enable **Developer Mode**

**Get IDs:**
- Right-click on a server icon → **Copy Server ID** (Guild ID)
- Right-click on a channel → **Copy Channel ID**

### Step 6: Configure FeedEater

In the FeedEater web UI, go to **Settings** > **Discord** and configure:

| Setting | Value |
|---------|-------|
| **Bot Token** | Your bot token from Step 2 |
| **Guild IDs** | Comma-separated server IDs to monitor |
| **Channel IDs** | (Optional) Specific channels. If empty, monitors all accessible channels in guilds |
| **Lookback Hours** | How far back to fetch messages (default: 24) |
| **Include Threads** | Whether to fetch thread messages (default: true) |
| **Exclude Bots** | Whether to skip bot messages (default: true) |

### Step 7: Test It

Trigger a manual collection run from the FeedEater UI to test immediately.

Check the **Logs** panel in FeedEater to see collection activity and any errors.

## Rate Limit Handling

Discord has complex rate limiting that **must** be handled carefully:

### Rate Limit Types

| Type | Limit | Scope | Consequence |
|------|-------|-------|-------------|
| **Per-Route** | Varies (e.g., 5/5s for messages) | Endpoint + resource | 429 response with `retry_after` |
| **Global** | 50 requests/second | Entire application | 429 + `X-RateLimit-Global: true` |
| **Gateway** | 120 events/60 seconds | WebSocket connection | Connection closed |
| **Invalid Requests** | Varies | IP address | Cloudflare ban |

### Implementation Requirements

1. **Always respect `X-RateLimit-*` headers:**
   - `X-RateLimit-Remaining` - Requests left in bucket
   - `X-RateLimit-Reset` - Unix timestamp when bucket resets
   - `X-RateLimit-Bucket` - Bucket identifier

2. **Handle 429 responses gracefully:**
   - Read `retry_after` from JSON body
   - Wait the specified duration before retrying
   - Implement exponential backoff for repeated 429s

3. **Don't spam invalid requests:**
   - Cache channel/guild validity
   - Log but don't retry permission errors (403)

## How It Works

### Jobs

**collect** (every 5 minutes): 
1. Calls `/guilds/{id}/channels` to get channel list
2. For each text channel, calls `/channels/{id}/messages` with `after` parameter
3. Stores messages in `mod_discord.discord_messages`
4. Publishes `MessageCreated` events to NATS

**updateContexts** (every 30 minutes):
1. Identifies active threads from recent messages
2. Uses semantic search to find relevant messages
3. Generates AI summaries
4. Publishes `ContextUpdated` events

### Context Keys

Format: `{guildId}:{channelId}:{threadId}` or `{guildId}:{channelId}` for main channels

Example: `123456789:987654321:111111111`

## Feed Types Supported

| Feed Type | Support | Notes |
|-----------|---------|-------|
| Server text channels | ✅ Full | Primary use case |
| Threads | ✅ Full | Auto-discovered from parent channels |
| Forum posts | ✅ Full | Threads in forum-type channels |
| Voice channel text | ✅ Full | Same API as text channels |
| Announcements | ✅ Full | Same API as text channels |
| DMs | ❌ Not supported | Requires special OAuth scope + approval |
| Group DMs | ❌ Not supported | Requires special OAuth scope + approval |

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the module |
| `botToken` | secret | required | Discord bot token |
| `guildIds` | string | required | Comma-separated guild (server) IDs |
| `channelIds` | string | `""` | Comma-separated channel IDs (empty = all accessible) |
| `lookbackHours` | number | `24` | How far back to fetch messages |
| `includeThreads` | boolean | `true` | Fetch thread messages |
| `excludeBots` | boolean | `true` | Skip bot messages |
| `collectIntervalMinutes` | number | `5` | How often to run collection |
| `respectRateLimits` | boolean | `true` | Honor Discord rate limits (don't disable!) |
| `channelNameMap` | string | `"{}"` | JSON mapping of channel IDs to friendly names |
| `contextPrompt` | string | (see module.json) | System prompt for AI summaries |

## Troubleshooting

**"Missing Access" error (50001)**: The bot doesn't have permission to view the channel. Check bot role permissions in Server Settings.

**"Unknown Channel" error (10003)**: The channel ID is wrong or the channel was deleted.

**"Missing Permissions" error (50013)**: Bot lacks specific permission (e.g., Read Message History). Check bot permissions.

**Empty messages or "[content not shown]"**: You need to enable **MESSAGE CONTENT INTENT** in the bot settings. This is a privileged intent required since September 2022.

**Rate limited constantly**: You're likely polling too frequently or monitoring too many channels. Increase `collectIntervalMinutes` or reduce monitored channels.

**Bot appears offline**: The bot doesn't need Gateway connection for REST polling. Offline status is normal for collection-only bots.

## Privileged Intents Warning

⚠️ **MESSAGE CONTENT INTENT**: As of September 2022, reading message content requires enabling this privileged intent:
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your app → Bot
3. Enable **MESSAGE CONTENT INTENT**

For bots in **100+ servers**, you must apply for verification and intent approval.

## For AI Agents

See [CLAUDE.md](./CLAUDE.md) for detailed context on this module's architecture, conventions, and lessons learned.
