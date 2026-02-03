# YouTube Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the YouTube module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The YouTube module collects videos from YouTube channels (optionally synced from the user's subscriptions) and integrates them into FeedEater's unified feed. It supports three strategies: RSS-only (zero quota), API-only (rich metadata), and hybrid (best of both).

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         COLLECTION STRATEGIES                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────┐     RSS Strategy (0 quota)                          │
│  │   Channel   │────────────────────────────────────┐                │
│  │    IDs      │                                    │                │
│  └─────────────┘                                    ▼                │
│        │            ┌──────────────────┐    ┌──────────────┐         │
│        │            │  YouTube RSS     │    │   Store in   │         │
│        │            │  Feeds (free)    │───▶│   Postgres   │         │
│        │            └──────────────────┘    └──────┬───────┘         │
│        │                                           │                 │
│        │            API Strategy (uses quota)      │                 │
│        │            ┌──────────────────┐           │                 │
│        └───────────▶│  YouTube Data    │           │                 │
│                     │  API v3 (OAuth)  │───────────┤                 │
│                     └──────────────────┘           │                 │
│                                                    ▼                 │
│                                           ┌──────────────┐           │
│                                           │  NATS Bus    │           │
│                                           │ VideoCreated │           │
│                                           └──────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **RSS-First Default**: Unlike most YouTube integrations, we default to RSS because:
   - Zero quota usage = unlimited scalability
   - Sufficient for feed-reader use case (title, thumbnail, date)
   - API reserved for enrichment, not discovery

2. **No Search API**: The search endpoint costs 100 units per call. Never use it for routine operations. Use channel upload playlists instead (1 unit).

3. **Subscription Sync is Optional**: Users can manually specify channel IDs to avoid OAuth entirely. OAuth only needed for auto-sync.

4. **Hybrid Enrichment**: Discover videos via RSS, then selectively enrich interesting ones via API. This balances quota with data richness.

### Context Model

Unlike Slack (where threads = contexts), YouTube contexts are channel-based:
- Context key: `{channelId}`
- Context represents: "Recent activity from this channel"
- Summary: AI-generated digest of recent uploads from the channel

### Key Files (to be implemented)

- `src/ingest.ts` - Core `YouTubeIngestor` class with RSS and API collection logic
- `src/runtime.ts` - Job handlers that wire up the ingestor
- `src/rss.ts` - RSS feed parser utilities
- `src/oauth.ts` - OAuth token management
- `module.json` - Job definitions, settings schema, UI cards
- `settings.ts` - TypeScript types for settings (mirrors module.json)

## Conventions

### Settings

All settings come from the FeedEater settings registry, not environment variables. The module fetches them via `ctx.fetchInternalSettings("youtube")`.

OAuth credentials and refresh tokens are encrypted at rest.

### Database

- Private schema: `mod_youtube`
- Tables: `youtube_videos`, `youtube_channels`, `youtube_video_embeddings`
- Use `ensureSchema()` to create tables on first run
- Never access other modules' schemas

### Bus Events

- Emit `VideoCreated` on `feedeater.youtube.videoCreated`
- Emit `ContextUpdated` on `feedeater.youtube.contextUpdated`
- Use `subjectFor("youtube", "eventName")` helper

### Logging

Use the `log()` method which publishes to `feedeater.youtube.log` for visibility in the FeedEater UI.

## Quota Management Strategies

### The Golden Rule

**RSS for discovery, API for enrichment.**

### Strategy 1: Pure RSS (Recommended Default)

```typescript
// Zero quota, unlimited checks
for (const channelId of channelIds) {
  const videos = await fetchRSSFeed(channelId);
  await storeVideos(videos);
}
```

### Strategy 2: Minimal API

```typescript
// ~2 units/day for subscription sync
const subs = await youtube.subscriptions.list({ mine: true, maxResults: 50 });
const channelIds = subs.items.map(s => s.snippet.resourceId.channelId);
// Then use RSS for video fetching
```

### Strategy 3: Hybrid with Enrichment

```typescript
// Discover via RSS
const newVideos = await discoverViaRSS(channelIds);
// Batch enrich via API (1 unit per 50 videos)
const videoIds = newVideos.map(v => v.id).join(',');
const details = await youtube.videos.list({ id: videoIds, part: 'contentDetails,statistics' });
```

### Quota Budget Tracking

Maintain a daily quota counter in settings or database:

```typescript
interface QuotaBudget {
  usedToday: number;
  resetAt: string; // ISO timestamp, midnight PT
  warningThreshold: number; // e.g., 8000
  hardLimit: number; // e.g., 9500 (leave buffer)
}
```

Log warnings when approaching limits. Switch to RSS-only mode if quota exhausted.

## What NOT To Do

### ❌ Don't Use search.list for Routine Operations
```typescript
// BAD: 100 units per call!
const results = await youtube.search.list({ channelId, type: 'video' });
```
Instead, use the channel's uploads playlist:
```typescript
// GOOD: 1 unit per call
const channel = await youtube.channels.list({ id: channelId, part: 'contentDetails' });
const uploadsPlaylistId = channel.items[0].contentDetails.relatedPlaylists.uploads;
const videos = await youtube.playlistItems.list({ playlistId: uploadsPlaylistId });
```

### ❌ Don't Fetch Full Video Details by Default
```typescript
// BAD: Wastes quota on data users may not need
const videos = await youtube.videos.list({ id: videoId, part: 'snippet,contentDetails,statistics,topicDetails' });
```
Only fetch what's needed, make it opt-in via settings.

### ❌ Don't Poll More Than Necessary
YouTube videos don't change frequently. Once per hour is plenty for most users. RSS is rate-limit friendly but still be respectful.

### ❌ Don't Store OAuth Credentials in Plain Text
Always use FeedEater's secret storage for `refreshToken` and `oauthCredentials`.

### ❌ Don't Assume the activities.list home Parameter Works
It's **deprecated**. There's no API to get "what YouTube would show you on the home page."

### ❌ Don't Ignore Pagination
Both API and RSS can have pagination. Always handle `nextPageToken` for API calls. RSS is limited to ~15 items with no pagination.

## API Quirks and Gotchas

### OAuth Token Expiry
- Access tokens expire in 1 hour
- Refresh tokens can expire if unused for 6 months
- Google may revoke tokens if the OAuth consent screen is in "testing" mode and >100 users
- Always handle `invalid_grant` errors gracefully

### Channel ID vs Username vs Handle
- Channel ID: `UC...` (24 chars, starts with UC)
- Legacy username: `/user/username` (deprecated)
- Handle: `/@username` (new format)
- Always normalize to channel ID for consistency

### Uploads Playlist ID
Every channel has a hidden "uploads" playlist. The playlist ID is the channel ID with `UC` replaced by `UU`:
```typescript
const uploadsPlaylistId = channelId.replace(/^UC/, 'UU');
```
This is faster than calling `channels.list` to get it.

### RSS Feed URL
```
https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}
```
Also works with playlist ID:
```
https://www.youtube.com/feeds/videos.xml?playlist_id={PLAYLIST_ID}
```

### Shorts Detection
YouTube Shorts are just videos with duration <= 60 seconds and vertical aspect ratio. The API `contentDetails.duration` field is in ISO 8601 format (e.g., `PT58S`). RSS doesn't include duration.

## Testing Locally

1. Set up FeedEater's docker-compose environment
2. For RSS-only testing: Just add channel IDs in settings
3. For API testing: Create OAuth credentials in Google Cloud Console
4. Trigger a manual `collect` job from the UI
5. Check logs panel for errors
6. Verify videos appear in the feed

## Future Improvements

- [ ] WebSub/PubSubHubbub for real-time RSS updates
- [ ] Playlist support (not just uploads)
- [ ] Watch later / liked videos sync (requires extra OAuth scopes)
- [ ] Shorts-specific handling (separate feed?)
- [ ] Community posts (if YouTube ever adds API support)
- [ ] Video transcript extraction for semantic search
- [ ] Smart quota budgeting with ML predictions

## Lessons Learned

### Research Phase (Feb 2026)
- The `activities.list` with `home=true` parameter is **deprecated** - there's no API to replicate YouTube's home feed algorithm
- YouTube's quota system is generous (10,000 units/day) but search is expensive (100 units)
- RSS is a hidden gem: zero cost, reliable, sufficient for feed-reader use case
- The uploads playlist trick (`UC` → `UU`) saves an API call per channel

### RSS Parsing
- YouTube RSS is Atom format, not RSS 2.0
- Video ID is in `yt:videoId` element
- Thumbnail URL follows predictable pattern: `https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg`

### OAuth Flow
- Desktop app flow is simplest for personal use
- Store refresh token, not access token
- Handle token refresh transparently in API wrapper

### Implementation Phase (Feb 2026)
- fast-xml-parser works well for Atom feed parsing with `ignoreAttributes: false` and `attributeNamePrefix: "@_"` for attribute handling
- YouTube RSS entries can have nested link elements (array or single) - always handle both cases
- Channel-based context model (vs thread-based like Slack) simplifies summarization - one context per channel
- Schema creation should avoid FK constraints initially to handle upsert ordering (channel may not exist when video arrives via RSS)
- Embedding generation can fail silently (rate limits, timeouts) - log warning but don't fail the job
- RSS feed returns ~15 most recent videos - sufficient for daily/hourly collection
- Lookback filtering should happen after fetching to avoid repeatedly fetching old videos that are still in the RSS feed
