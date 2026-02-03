# YouTube Module

**Priority: TBD** (will be assigned based on MAU ranking)

Collects videos from your YouTube subscriptions and organizes them into FeedEater's unified feed. Supports both the official YouTube Data API and a zero-quota RSS fallback for lightweight use cases.

## Overview

The YouTube module offers two collection strategies:

| Strategy | Quota Cost | Best For |
|----------|------------|----------|
| **RSS-First (Recommended)** | 0 units/day | Most users - unlimited checks, 15 recent videos per channel |
| **Full API** | ~100+ units/day | Users needing video metadata (descriptions, durations, view counts) |

## Quick Start (RSS-First Strategy)

For most personal use, the RSS approach is **free and sufficient**. No API key required.

### Step 1: Get Your Channel IDs

You need the channel IDs for channels you want to follow. To find a channel ID:

1. Go to the channel's YouTube page
2. Look at the URL: `https://www.youtube.com/channel/UC...` - the `UC...` part is the channel ID
3. If the URL uses a custom handle (`@username`), view page source and search for `channelId`

Alternatively, use a service like [Comment Picker](https://commentpicker.com/youtube-channel-id.php) to convert URLs to IDs.

### Step 2: Configure FeedEater

In the FeedEater web UI, go to **Settings** > **YouTube** and configure:

| Setting | Value |
|---------|-------|
| **Collection Strategy** | `rss` (default) |
| **Channel IDs** | Comma-separated list of channel IDs |
| **Max Videos Per Channel** | How many recent videos to fetch (default: 15, RSS max) |

That's it! The collector will fetch videos via RSS with zero quota usage.

---

## Full Setup (OAuth + API Strategy)

If you need your actual subscription list (auto-sync) or rich video metadata, use the full API approach.

### Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **YouTube Data API v3**:
   - Go to **APIs & Services** > **Library**
   - Search for "YouTube Data API v3"
   - Click **Enable**

### Step 2: Create OAuth 2.0 Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **+ CREATE CREDENTIALS** > **OAuth client ID**
3. If prompted, configure the OAuth consent screen:
   - User Type: **External** (unless you have a Workspace org)
   - App name: "FeedEater" (or whatever you like)
   - Add your email as a test user
4. Application type: **Desktop app** (or Web application if you prefer)
5. Click **Create**
6. Download the JSON credentials file

### Step 3: Authorize FeedEater

1. In FeedEater, go to **Settings** > **YouTube**
2. Upload or paste your OAuth credentials JSON
3. Click **Authorize** - this opens a Google sign-in flow
4. Grant the requested permissions:
   - `youtube.readonly` - Read your YouTube data
5. FeedEater stores the refresh token securely

### Step 4: Configure Collection

| Setting | Value |
|---------|-------|
| **Collection Strategy** | `api` or `hybrid` |
| **Sync Subscriptions** | `true` to auto-fetch your subscription list |
| **Fetch Video Details** | `true` to get descriptions, durations, etc. |
| **Lookback Days** | How far back to fetch (default: 7) |

---

## Quota Guide

YouTube API uses a **quota unit system**. Default allocation: **10,000 units/day**.

### Quota Costs

| Operation | Cost | Notes |
|-----------|------|-------|
| `subscriptions.list` | 1 unit | 50 results per page |
| `playlistItems.list` | 1 unit | Get channel uploads (50 per page) |
| `videos.list` | 1 unit | Get video details (50 per request) |
| `activities.list` | 1 unit | Channel activity |
| `search.list` | **100 units** | Avoid if possible! |
| `channels.list` | 1 unit | Channel metadata |

### Example Quota Math

**Scenario: 100 subscriptions, check once per hour**

| Approach | Units per Check | Daily (24 checks) |
|----------|-----------------|-------------------|
| RSS-First | 0 | **0 units** ✓ |
| API: Subscriptions only | 2 | 48 units |
| API: Subs + uploads | 102 | 2,448 units |
| API: Subs + uploads + details | 204 | 4,896 units |

**Recommendation:** Use RSS for video discovery, API only for enrichment.

### Hybrid Strategy (Best of Both)

1. Sync subscriptions via API (once/day): ~2 units
2. Fetch new videos via RSS: 0 units
3. Enrich interesting videos via API: 1 unit per 50 videos

This approach uses <50 units/day for most users.

---

## RSS Feed Details

YouTube provides RSS feeds for every channel:

```
https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}
```

### RSS Limitations
- Returns ~15 most recent videos only
- No view counts, durations, or descriptions
- No Shorts filtering (must check video duration via API)
- No comments or community posts

### RSS Advantages
- **Zero quota usage**
- No authentication required
- Fast and reliable
- Sufficient for most feed-reader use cases

---

## What It Collects

| Content Type | API | RSS | Notes |
|--------------|-----|-----|-------|
| Channel uploads | ✓ | ✓ | Main videos |
| Video metadata | ✓ | Partial | RSS: title, date, thumbnail only |
| Shorts | ✓ | ✓ | Need API to filter by duration |
| Live streams | ✓ | ✓ | |
| Premieres | ✓ | ✓ | |
| Community posts | ✗ | ✗ | Not available via API |
| Comments | ✓ | ✗ | High quota cost |

---

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the module |
| `collectionStrategy` | enum | `rss` | `rss`, `api`, or `hybrid` |
| `channelIds` | string | `""` | Manual list of channel IDs (comma-separated) |
| `syncSubscriptions` | boolean | `false` | Auto-fetch subscribed channels (requires OAuth) |
| `oauthCredentials` | secret | `null` | OAuth credentials JSON |
| `refreshToken` | secret | `null` | OAuth refresh token (auto-populated) |
| `apiKey` | secret | `null` | API key (for public data only) |
| `maxVideosPerChannel` | number | `15` | Max recent videos per channel |
| `lookbackDays` | number | `7` | How far back to fetch |
| `fetchVideoDetails` | boolean | `false` | Get full metadata (costs quota) |
| `includeShorts` | boolean | `true` | Include YouTube Shorts |
| `excludeLiveStreams` | boolean | `false` | Skip live streams |
| `checkIntervalMinutes` | number | `60` | How often to check for new videos |

---

## How It Works

### Jobs

**collect** (configurable interval, default 60 min):
1. If `syncSubscriptions`: Fetch subscription list via API
2. For each channel, fetch recent videos (RSS or API based on strategy)
3. Store new videos in `mod_youtube.youtube_videos`
4. Optionally enrich with video details via API
5. Publish `VideoCreated` events to the message bus

**updateContexts** (every 30 min):
- Groups videos by channel
- Generates AI summaries for channels with multiple new videos
- Publishes `ContextUpdated` events

### Context Keys

Videos are grouped into Contexts by channel: `{channelId}`

Each context represents "recent activity from this channel."

---

## Troubleshooting

**"quotaExceeded" error**: You've hit your daily limit. Wait until midnight PT, or:
- Switch to RSS strategy
- Request a quota increase via [Google's form](https://support.google.com/youtube/contact/yt_api_form)

**"forbidden" on subscriptions**: OAuth token lacks the required scope, or the user hasn't granted access. Re-authorize via Settings.

**Missing videos**: RSS only returns ~15 recent videos. For complete history, use the API with pagination.

**Shorts appearing when excluded**: The `includeShorts` setting requires the API strategy (RSS doesn't include duration).

**"invalid_grant" error**: Refresh token expired or revoked. Re-authorize via Settings.

---

## For AI Agents

See [CLAUDE.md](./CLAUDE.md) for detailed context on this module's architecture, conventions, and lessons learned.
