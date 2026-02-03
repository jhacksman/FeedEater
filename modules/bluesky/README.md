# Bluesky Module

> **Priority: #1** — This is the highest priority module for FeedEater.

The Bluesky module collects posts from Bluesky/AT Protocol and organizes them into FeedEater's unified message system. It fetches your actual home timeline (what you see when you open Bluesky) plus supports custom feeds.

## Overview

- **Protocol**: AT Protocol (atproto) — a decentralized social protocol
- **Data Source**: User's timeline, custom feeds, author feeds
- **Authentication**: App Password (recommended) or OAuth
- **Update Method**: Polling (configurable interval)

## Quick Start

### 1. Create an App Password

App passwords are the recommended authentication method for automation:

1. Open Bluesky app → **Settings** → **Privacy and Security** → **App Passwords**
2. Click **Add App Password**
3. Name it something memorable (e.g., "FeedEater")
4. Copy the generated password (format: `xxxx-xxxx-xxxx-xxxx`)

> ⚠️ **Security Note**: App passwords have limited permissions — they cannot change your account password, email, or create/revoke other app passwords. Use them instead of your primary password.

### 2. Configure in FeedEater

1. Navigate to **Modules** → **Bluesky** in the FeedEater UI
2. Enter your credentials:
   - **Identifier**: Your handle (e.g., `alice.bsky.social`) or DID
   - **App Password**: The `xxxx-xxxx-xxxx-xxxx` token from step 1
3. Configure which feeds to collect (see [Feed Settings](#feed-settings))
4. Save and enable the module

### 3. Verify Connection

Run a manual `collect` job from the UI. Check the logs panel for:
- ✅ "Session created successfully"
- ✅ "Collected X posts from timeline"

## How It Works

### Data Flow

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Bluesky   │────▶│  collect job │────▶│  Postgres   │
│   API/PDS   │     │  (5 min)     │     │  mod_bsky   │
└─────────────┘     └──────────────┘     └─────────────┘
                           │
                           ▼
                    ┌──────────────┐     ┌─────────────┐
                    │ NATS Events  │────▶│ Other       │
                    │ MessageCreated│    │ Modules     │
                    └──────────────┘     └─────────────┘
```

### Jobs

| Job | Schedule | Description |
|-----|----------|-------------|
| `collect` | Every 5 min | Fetches new posts from configured feeds |
| `updateContexts` | Every 30 min | Generates AI summaries for active threads |

### What Gets Collected

- **Posts**: Text, timestamps, author info, engagement counts
- **Reposts**: Who reposted, original post reference
- **Replies**: Thread structure (parent + root references)
- **Quote Posts**: Embedded post references
- **Media**: Image metadata and blob references (not binary data)
- **Facets**: Links, mentions, hashtags parsed from rich text

## Feed Settings

### Feed Types

| Type | API Method | Description |
|------|------------|-------------|
| `timeline` | `getTimeline` | Your home feed (posts from people you follow) |
| `feed` | `getFeed` | Custom algorithmic feeds by AT URI |
| `author` | `getAuthorFeed` | Posts from a specific user |

### Custom Feed URIs

Custom feeds use AT URI format:
```
at://<did>/app.bsky.feed.generator/<record-key>
```

Examples:
- **Discover**: `at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot`
- **Following**: Your timeline (use `timeline` type instead)

To find a feed's URI, open the feed in Bluesky web and extract from the URL.

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `identifier` | string | *required* | Your Bluesky handle or DID |
| `appPassword` | secret | *required* | App password (xxxx-xxxx-xxxx-xxxx) |
| `serviceUrl` | string | `https://bsky.social` | PDS service URL |
| `collectTimeline` | boolean | `true` | Collect your home timeline |
| `customFeeds` | array | `[]` | List of custom feed URIs to collect |
| `lookbackHours` | number | `24` | How far back to look for posts |
| `postsPerFetch` | number | `100` | Posts per API request (max 100) |
| `collectIntervalMinutes` | number | `5` | How often to poll for new posts |
| `enableEmbeddings` | boolean | `true` | Generate embeddings for semantic search |
| `preferredLanguages` | string | `en` | Comma-separated language codes for feed filtering |

## API Details

### Authentication Flow

1. **Create Session**: POST to `/xrpc/com.atproto.server.createSession`
   - Returns `accessJwt` (expires in minutes) and `refreshJwt` (longer lived)
2. **Make Requests**: Include `Authorization: Bearer {accessJwt}` header
3. **Refresh Session**: POST to `/xrpc/com.atproto.server.refreshSession` when token expires

The `@atproto/api` SDK handles this automatically via `BskyAgent`.

### Rate Limits

| Limit | Scope | Value |
|-------|-------|-------|
| General API requests | Per IP | 3,000 / 5 minutes |
| Create session | Per account | 30 / 5 min, 300 / day |
| Content writes | Per account | 5,000 points/hour, 35,000/day |

**Write point costs**: CREATE=3, UPDATE=2, DELETE=1

> 💡 FeedEater only reads data, so write limits don't apply. With default settings (100 posts every 5 min), you'll use ~600 requests/hour — well within limits.

### Key Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `com.atproto.server.createSession` | Authenticate and get tokens |
| `com.atproto.server.refreshSession` | Refresh expired access token |
| `app.bsky.feed.getTimeline` | Fetch home timeline |
| `app.bsky.feed.getFeed` | Fetch custom feed by URI |
| `app.bsky.feed.getAuthorFeed` | Fetch posts from specific user |
| `app.bsky.feed.getPostThread` | Fetch full thread context |
| `com.atproto.identity.resolveHandle` | Convert handle → DID |

### Service Hosts

| Service | URL | Purpose |
|---------|-----|---------|
| Entryway | `https://bsky.social` | Account creation, session management |
| AppView | `https://api.bsky.app` | Read aggregated app data |
| Public AppView | `https://public.api.bsky.app` | Cached public reads (no auth) |
| Relay | `https://bsky.network` | Firehose subscription |

## Troubleshooting

### "Invalid identifier or password"

- Verify you're using an **App Password**, not your main password
- Check the identifier format (handle or DID)
- Ensure no extra spaces in credentials

### "Rate limited" (HTTP 429)

- Check `RateLimit-*` response headers for reset time
- Increase `collectIntervalMinutes` setting
- Reduce `postsPerFetch` if doing many requests

### "Session expired"

- The module auto-refreshes sessions, but if it fails:
- Check that your app password wasn't revoked
- Try re-entering credentials in settings

### "Could not resolve handle"

- The handle may have changed or been deleted
- Try using the DID instead (format: `did:plc:xxxxxxxx`)

### Posts not appearing

1. Check logs for collection errors
2. Verify `lookbackHours` covers the time range
3. Confirm the account has posted recently
4. Check if posts are in a language you're filtering

### Thread context missing

- Parent/root posts are fetched on-demand
- If the original post is deleted, thread context is unavailable
- Check `getPostThread` errors in logs

## Future Enhancements

- [ ] Jetstream real-time subscription (instead of polling)
- [ ] Direct message collection (chat.bsky.* APIs)
- [ ] Notification collection (likes, follows, mentions)
- [ ] List membership tracking
- [ ] Labeler/moderation integration
- [ ] Multi-account support

## Resources

- [Bluesky API Docs](https://docs.bsky.app)
- [AT Protocol Specs](https://atproto.com/specs)
- [@atproto/api NPM Package](https://www.npmjs.com/package/@atproto/api)
- [Bluesky API Cookbook](https://github.com/bluesky-social/cookbook)
