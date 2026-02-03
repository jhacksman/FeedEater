# YouTube Module Implementation Plan

Following the Boris Cherny method: PLAN → EXECUTE → VERIFY → DOCUMENT

## Goal
Implement the YouTube module for FeedEater using RSS-first strategy (zero quota) with optional API enrichment.

## Architecture Overview
```
┌─────────────────────────────────────────────────────────────┐
│                    YouTubeIngestor                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  RSS Fetching (Primary)      API Enrichment (Optional)      │
│  ─────────────────────      ────────────────────────       │
│  • channel_id → RSS URL      • Batch video details          │
│  • Parse Atom feed           • Duration/view counts         │
│  • Extract video metadata    • Shorts detection             │
│                                                             │
│  Storage ──────────────────────────────────────────────────│
│  • mod_youtube.youtube_channels                             │
│  • mod_youtube.youtube_videos                               │
│  • mod_youtube.youtube_video_embeddings                     │
│                                                             │
│  Events ───────────────────────────────────────────────────│
│  • feedeater.youtube.messageCreated (VideoCreated)          │
│  • feedeater.youtube.contextUpdated (ChannelContext)        │
│  • feedeater.youtube.log                                    │
└─────────────────────────────────────────────────────────────┘
```

## Files to Create/Update

### 1. `src/ingest.ts` - Core YouTubeIngestor class
- `parseYouTubeSettingsFromInternal()` - Parse settings from internal API
- `YouTubeIngestor` class with:
  - Constructor accepting settings, db, nats, sc, opts
  - `log()` - Publish to feedeater.youtube.log
  - `fetchRSSFeed(channelId)` - Fetch and parse YouTube RSS
  - `ensureSchema()` - Create tables if needed
  - `ensureChannel(channelId, title)` - Upsert channel record
  - `collectAndPersist()` - Main collection logic
  - `refreshContexts()` - Generate AI summaries per channel

### 2. `src/runtime.ts` - Job handlers
- `createModuleRuntime()` returning:
  - `mod_youtube.collect` - Scheduled video collection
  - `mod_youtube.updateContexts` - Refresh channel summaries

### 3. `src/index.ts` - Exports
- Export YouTubeIngestor, parser, runtime

### 4. `package.json` - Dependencies
- fast-xml-parser (RSS parsing)
- @feedeater/core, @feedeater/module-sdk
- nats, pg, uuid, zod

### 5. `tsconfig.json` - TypeScript config
- Extend ../../tsconfig.base.json

### 6. `module.json` - Module manifest
- Jobs: collect (every 60 min), updateContexts (every 6 hours)
- Settings schema matching settings.ts

## Key Design Decisions

1. **RSS-First**: Default to RSS collection (zero quota)
   - URL: `https://www.youtube.com/feeds/videos.xml?channel_id={ID}`
   - Get: videoId, title, description, published, thumbnail, channelId
   
2. **Context Model**: Channel-based (unlike Slack's thread-based)
   - contextKey: `channel:{channelId}`
   - Summarize recent uploads from each channel
   
3. **Shorts Detection**: Via duration (≤60s) when API-enriched, otherwise skip

4. **Embedding Strategy**: Embed video title + description for semantic search

5. **Deduplication**: Check video_id existence before inserting

## RSS Feed Structure (Atom)
```xml
<feed>
  <entry>
    <yt:videoId>dQw4w9WgXcQ</yt:videoId>
    <yt:channelId>UCuAXFkgsw1L7xaCfnd5JJOw</yt:channelId>
    <title>Video Title</title>
    <link href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
    <author><name>Channel Name</name></author>
    <published>2024-01-15T12:00:00+00:00</published>
    <updated>2024-01-15T12:00:00+00:00</updated>
    <media:group>
      <media:title>Video Title</media:title>
      <media:description>Description...</media:description>
      <media:thumbnail url="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"/>
    </media:group>
  </entry>
</feed>
```

## Implementation Order
1. Create package.json with dependencies
2. Create tsconfig.json
3. Implement src/ingest.ts
4. Implement src/runtime.ts
5. Create src/index.ts
6. Create module.json
7. Test TypeScript compilation
8. Git commit

## Testing Checklist
- [ ] TypeScript compiles without errors
- [ ] All imports resolve correctly
- [ ] Settings parser handles all fields
- [ ] RSS parser extracts all required fields
- [ ] Schema creation SQL is valid
- [ ] Event schemas match @feedeater/core contracts
