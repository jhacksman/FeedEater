# Mastodon Module

**Priority: HIGH** — Straightforward REST API, excellent documentation, easy OAuth flow. Should be one of the simpler modules to implement.

Collects toots from your Mastodon home timeline and organizes them into Contexts. Threads (reply chains) become their own contexts with AI-generated summaries, making it easy to follow conversations across the fediverse.

## Important: Multi-Instance Architecture

Mastodon is a **federated network** — there is no single "Mastodon" to authenticate with. Each instance (mastodon.social, fosstodon.org, hachyderm.io, etc.) is a separate server with its own:

- User accounts and authentication
- App registrations
- Rate limits (instance admin configurable)
- Content moderation policies

**You authenticate with YOUR instance.** Your home timeline includes posts from people you follow, regardless of which instance they're on. The federation handles cross-instance delivery.

## Quick Start

### Step 1: Choose Your Instance

You need an account on a Mastodon instance. Common options:
- **mastodon.social** — Largest general-purpose instance
- **fosstodon.org** — Open source focused
- **hachyderm.io** — Tech community
- **infosec.exchange** — Security professionals
- Or any of thousands of other instances

If you already have a Mastodon account, use that instance.

### Step 2: Register an Application (On Your Instance)

Every Mastodon instance requires you to register an application before using OAuth. This is done via API or through the web interface.

#### Option A: Via Web Interface (Easiest)

1. Log into your Mastodon instance
2. Go to **Settings** > **Development** > **New Application**
3. Fill in the form:
   - **Application name**: `FeedEater` (or whatever you prefer)
   - **Application website**: `http://localhost` (or your FeedEater URL)
   - **Redirect URI**: `urn:ietf:wg:oauth:2.0:oob` (for manual code copy)
   - **Scopes**: Select only `read` (that's all we need)
4. Click **Submit**
5. Copy the **Client ID** and **Client Secret**

#### Option B: Via API

```bash
curl -X POST \
  https://YOUR_INSTANCE/api/v1/apps \
  -d 'client_name=FeedEater' \
  -d 'redirect_uris=urn:ietf:wg:oauth:2.0:oob' \
  -d 'scopes=read' \
  -d 'website=http://localhost'
```

Response includes `client_id` and `client_secret`.

### Step 3: Authorize the Application

1. Visit this URL in your browser (replace YOUR_INSTANCE and CLIENT_ID):
   ```
   https://YOUR_INSTANCE/oauth/authorize?client_id=CLIENT_ID&scope=read&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code
   ```
2. Log in if prompted and click **Authorize**
3. Copy the **authorization code** displayed

### Step 4: Get Your Access Token

Exchange the authorization code for an access token:

```bash
curl -X POST \
  https://YOUR_INSTANCE/oauth/token \
  -d 'client_id=YOUR_CLIENT_ID' \
  -d 'client_secret=YOUR_CLIENT_SECRET' \
  -d 'redirect_uri=urn:ietf:wg:oauth:2.0:oob' \
  -d 'grant_type=authorization_code' \
  -d 'code=YOUR_AUTH_CODE' \
  -d 'scope=read'
```

Response includes `access_token`. Save this — it's what FeedEater needs.

### Step 5: Configure FeedEater

In the FeedEater web UI, go to **Settings** > **Mastodon** and configure:

| Setting | Value |
|---------|-------|
| **Instance URL** | Your instance base URL (e.g., `https://mastodon.social`) |
| **Access Token** | Your access token from Step 4 |
| **Timeline Type** | `home` (default), `local`, or `public` |
| **Lookback Hours** | How far back to fetch toots (default: 24) |
| **Include Boosts** | Whether to include boosted toots (default: true) |
| **Include Replies** | Whether to include reply toots (default: true) |

### Step 6: Test It

The Mastodon collector runs every 5 minutes by default. Trigger a manual run from the FeedEater UI to test immediately.

Check the **Logs** panel for collection activity and any errors.

## How It Works

The Mastodon module runs two scheduled jobs:

**collect** (every 5 minutes): Fetches new toots from your home timeline via `GET /api/v1/timelines/home`, stores them in the module's private database, and publishes them to the FeedEater message bus.

**updateContexts** (every 30 minutes): Refreshes AI summaries for active conversation threads. Uses semantic search to find relevant toots in each thread, then generates summaries.

## Timeline Types

| Type | Endpoint | Description |
|------|----------|-------------|
| `home` | `/api/v1/timelines/home` | Posts from people you follow (recommended) |
| `local` | `/api/v1/timelines/public?local=true` | Posts from your instance only |
| `public` | `/api/v1/timelines/public` | Federated timeline (very high volume!) |

**Recommendation**: Use `home` timeline. The federated timeline is extremely high volume and will consume rate limits quickly.

## Context Keys

Each Mastodon thread becomes its own Context with the key format: `{instanceHost}:{conversationId}`

For example: `mastodon.social:123456789`

Non-threaded toots get a simple context based on the author.

## What It Stores

Raw Mastodon status payloads (plus convenience columns) in:
- `mod_mastodon.mastodon_statuses` — All collected toots
- `mod_mastodon.mastodon_status_embeddings` — Vector embeddings for semantic search

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the module |
| `instanceUrl` | string | required | Mastodon instance URL (e.g., `https://mastodon.social`) |
| `accessToken` | secret | required | OAuth access token |
| `timelineType` | enum | `home` | Which timeline to fetch: `home`, `local`, `public` |
| `lookbackHours` | number | `24` | How far back to fetch toots |
| `includeBoosts` | boolean | `true` | Include boosted/reblogged toots |
| `includeReplies` | boolean | `true` | Include reply toots |
| `excludeSensitive` | boolean | `false` | Exclude toots marked sensitive (CW) |
| `minFavorites` | number | `0` | Minimum favorites to include (for filtering noise) |
| `pollIntervalMinutes` | number | `5` | How often to poll for new toots |
| `contextPrompt` | string | (see module.json) | System prompt for AI summaries |

## Rate Limits

**Default Mastodon rate limits** (may vary by instance):
- **300 requests per 5 minutes** for most endpoints
- Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

The module automatically respects rate limits via exponential backoff. If you're hitting limits frequently, consider:
1. Increasing `pollIntervalMinutes`
2. Using `home` timeline instead of `public`
3. Filtering with `minFavorites` to reduce volume

## Multi-Instance Usage (Advanced)

If you want to monitor multiple Mastodon instances (e.g., you have accounts on both mastodon.social and fosstodon.org), you'll need to:

1. Register separate apps on each instance
2. Obtain separate access tokens for each
3. Configure multiple module instances in FeedEater (future feature)

Currently, FeedEater supports one Mastodon instance per installation. Multi-instance support is planned.

## Troubleshooting

**"401 Unauthorized" error**: Your access token is invalid or expired. Regenerate it following Steps 3-4.

**"403 Forbidden" error**: The token doesn't have the required `read` scope. Re-authorize with `scope=read`.

**"404 Not Found" error**: The instance URL is incorrect. Make sure it includes the protocol (https://).

**Rate limited (429)**: You're making too many requests. The module will automatically back off. Consider increasing `pollIntervalMinutes`.

**No toots appearing**: Check that `lookbackHours` is set high enough, and that your home timeline actually has activity.

**Missing toots from other instances**: This is normal during federation delays. Content from remote instances may take time to propagate to your instance.

**Threads not connecting**: Mastodon's `conversation_id` is instance-local. Threads spanning multiple instances may not be grouped correctly.

## For AI Agents

See [CLAUDE.md](./CLAUDE.md) for detailed context on this module's architecture, conventions, and lessons learned.
