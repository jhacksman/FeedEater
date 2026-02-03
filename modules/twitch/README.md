# Twitch Module

**Priority: TBD** (Good API access, EventSub for real-time, chat support)

Collects streams, VODs, clips, and chat from Twitch channels you follow. Uses EventSub WebSocket for real-time notifications when streamers go live, and optionally monitors chat in channels you're moderating.

## API Capabilities

Twitch's Helix API provides excellent access to:

| Data Type | Endpoint | Notes |
|-----------|----------|-------|
| **Followed Streams** | `Get Followed Streams` | Live streams from channels user follows |
| **Any Streams** | `Get Streams` | Filter by game, language, user IDs |
| **VODs** | `Get Videos` | Past broadcasts, highlights, uploads |
| **Clips** | `Get Clips` | User-created clips from streams |
| **Schedules** | `Get Channel Stream Schedule` | Upcoming stream times |
| **Chat Messages** | EventSub `channel.chat.message` | Real-time chat (requires auth) |
| **Stream Events** | EventSub `stream.online`/`stream.offline` | Real-time go-live notifications |

## Quick Start

### Step 1: Create a Twitch Application

1. Go to [https://dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
2. Log in with your Twitch account
3. Click **Register Your Application**
4. Fill in:
   - **Name**: FeedEater (or anything unique)
   - **OAuth Redirect URLs**: `http://localhost:3000/callback` (for local dev) or your FeedEater callback URL
   - **Category**: Application Integration
5. Click **Create**
6. Click **Manage** on your new app
7. Copy the **Client ID**
8. Click **New Secret** and copy the **Client Secret** (you won't see it again!)

### Step 2: Get OAuth Tokens

Twitch requires OAuth tokens for API access. You need:

**App Access Token** (for public data + EventSub webhooks):
```bash
curl -X POST 'https://id.twitch.tv/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&grant_type=client_credentials'
```

**User Access Token** (for user-specific data like followed streams):
1. Direct user to authorize:
   ```
   https://id.twitch.tv/oauth2/authorize
     ?client_id=YOUR_CLIENT_ID
     &redirect_uri=YOUR_REDIRECT_URI
     &response_type=code
     &scope=user:read:follows moderator:read:chatters channel:bot
   ```
2. Exchange the code for tokens at `https://id.twitch.tv/oauth2/token`

### Step 3: Required OAuth Scopes

| Scope | Purpose |
|-------|---------|
| `user:read:follows` | Get channels the user follows |
| `moderator:read:chatters` | See who's in chat (if moderator) |
| `channel:bot` | Receive chat messages via EventSub |
| `user:read:chat` | Read chat as the authenticated user |

For chat reading in channels where you're **not** a moderator, the broadcaster must authorize `channel:bot` for your app.

### Step 4: Configure FeedEater

In the FeedEater web UI, go to **Settings** > **Twitch** and configure:

| Setting | Value |
|---------|-------|
| **Client ID** | Your app's Client ID |
| **Client Secret** | Your app's Client Secret (encrypted at rest) |
| **User Access Token** | OAuth token for user-specific API calls |
| **User ID** | Your Twitch user ID (numeric, not username) |
| **Broadcaster IDs** | Comma-separated channel IDs to monitor for chat |
| **Collect VODs** | Whether to fetch past broadcasts (default: true) |
| **Collect Clips** | Whether to fetch clips (default: true) |
| **Lookback Hours** | How far back for VODs/clips (default: 168 = 1 week) |

### Step 5: Find User/Channel IDs

Twitch uses numeric IDs, not usernames. To find a user ID:

```bash
curl -X GET 'https://api.twitch.tv/helix/users?login=CHANNEL_NAME' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Client-Id: YOUR_CLIENT_ID'
```

The response includes the numeric `id` field.

### Step 6: Test It

Trigger a manual collect from the FeedEater UI. Check the **Logs** panel for:
- Successful EventSub subscription creation
- Followed streams being fetched
- Any authentication errors

## EventSub Setup (Real-Time Events)

This module uses EventSub **WebSocket** transport for real-time events. WebSocket is preferred over webhooks because:

1. No public endpoint required
2. Simpler firewall/NAT traversal
3. Lower latency

### How EventSub Works

1. Module connects to `wss://eventsub.wss.twitch.tv/ws`
2. Receives a Welcome message with a session ID
3. Uses session ID to subscribe to events via REST API
4. Receives real-time notifications via WebSocket

### Subscribed Events

| Event | Purpose |
|-------|---------|
| `stream.online` | Streamer goes live |
| `stream.offline` | Streamer ends stream |
| `channel.follow` | New follower (if authorized) |
| `channel.chat.message` | Chat message received |

### WebSocket Limits

- **Max 3 connections** per user token
- **Max 300 subscriptions** per connection
- **10 second timeout** after welcome to subscribe
- **Keepalive** every ~10 seconds (configurable up to 600s)

### Reconnection Handling

EventSub sends a `session_reconnect` message 30 seconds before closing. The module must:
1. Connect to the new URL provided
2. Keep the old connection open until welcome received
3. Then close the old connection

This ensures no events are missed during edge server swaps.

## Chat Integration

Twitch chat is now best accessed via **EventSub**, not IRC. The `channel.chat.message` event provides:

- Real-time messages with full metadata
- Emotes, badges, bits information
- No IRC parsing required
- Automatic bot badge if using app access token

### Chat Requirements

To receive chat messages from a channel:

1. **You're the broadcaster**: Just subscribe with your user token
2. **You're a moderator**: Subscribe with your user token
3. **Neither**: The broadcaster must authorize `channel:bot` scope for your app

### Sending Messages

Use the `Send Chat Message` API endpoint:
```bash
POST https://api.twitch.tv/helix/chat/messages
{
  "broadcaster_id": "CHANNEL_ID",
  "sender_id": "YOUR_USER_ID",
  "message": "Hello chat!"
}
```

## How It Works

### Jobs

**collect** (every 5 minutes):
- Fetches live followed streams via REST API
- Fetches recent VODs and clips
- Stores in `mod_twitch.twitch_streams`, `mod_twitch.twitch_videos`, `mod_twitch.twitch_clips`
- Publishes to FeedEater message bus

**maintainEventSub** (continuous):
- Maintains WebSocket connection
- Processes real-time events (stream online/offline, chat)
- Reconnects on disconnection or server request

**updateContexts** (every 30 minutes):
- Generates AI summaries for active streams/chats
- Uses semantic search for relevant messages

### Context Keys

- Stream contexts: `stream:{broadcasterId}`
- Chat contexts: `chat:{broadcasterId}:{date}`
- VOD contexts: `vod:{videoId}`

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the module |
| `clientId` | string | required | Twitch app Client ID |
| `clientSecret` | secret | required | Twitch app Client Secret |
| `userAccessToken` | secret | required | OAuth user access token |
| `refreshToken` | secret | optional | OAuth refresh token for auto-renewal |
| `userId` | string | required | Your Twitch user ID (numeric) |
| `broadcasterIds` | string | `""` | Comma-separated channel IDs for chat monitoring |
| `collectVods` | boolean | `true` | Fetch past broadcasts |
| `collectClips` | boolean | `true` | Fetch clips |
| `collectChat` | boolean | `false` | Monitor chat (requires auth per channel) |
| `lookbackHours` | number | `168` | How far back for VODs/clips (default 1 week) |
| `contextPrompt` | string | (see module.json) | AI summary system prompt |

## Rate Limits

### API Rate Limits

Twitch uses a token-bucket system:
- **800 points/minute** for app access tokens
- **Points per user** for user access tokens
- Default: 1 point per request
- Check `Ratelimit-Remaining` header

### Chat Rate Limits

When sending messages:
- **20 messages/30s** normal users
- **100 messages/30s** broadcaster/mod/VIP
- **7500 messages/30s** verified bots
- **1 message/second/channel** for non-mod users

### EventSub Limits

- 3 WebSocket connections per user token
- 300 enabled subscriptions per connection
- 10,000 total subscription cost

## Troubleshooting

**"Invalid OAuth token"**: Token expired or revoked. Use the refresh token to get a new access token, or re-authorize.

**"Missing scope"**: The token doesn't have required scopes. Re-authorize with all needed scopes.

**EventSub connection drops**: Check logs for close codes:
- `4000`: Server error (retry)
- `4001`: You sent data (don't send messages except pong)
- `4003`: No subscription within 10s (subscribe faster)
- `4005/4006`: Network issues (reconnect)

**No chat messages**: Ensure either:
- You're the broadcaster/moderator of the channel
- The broadcaster has authorized `channel:bot` for your app

**"rate_limit_exceeded"**: Wait for `Ratelimit-Reset` timestamp before retrying.

**Wrong user ID**: Use the numeric ID, not the username. Fetch it via `Get Users` endpoint.

## IRC (Legacy)

Twitch still supports IRC (`irc.chat.twitch.tv:6697`), but EventSub is now preferred:
- IRC requires parsing IRC protocol
- IRC doesn't get the bot badge
- IRC join limits are stricter (20/10s normal, 2000/10s verified)
- Some features (like shared chat) don't work on IRC

Only use IRC if you have a specific reason (e.g., existing IRC infrastructure).

## For AI Agents

See [CLAUDE.md](./CLAUDE.md) for architecture decisions, conventions, and implementation guidance.
