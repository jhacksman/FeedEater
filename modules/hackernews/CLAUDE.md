# Hacker News Module — CLAUDE.md

## What This Module Does
Collects stories from the Hacker News Firebase API (top, new, best, ask, show, job feeds), normalizes them into the FeedEater unified message bus, and generates AI context summaries.

## Data Flow
1. `collect` job runs every 5 minutes
2. Fetches story IDs from configured feed endpoints (e.g. `/v0/topstories.json`)
3. Fetches individual items via `/v0/item/{id}.json`
4. Deduplicates by `hn_id` (upsert), only publishes new stories to the bus
5. Optionally fetches top-level comments per story
6. Stores raw data in `mod_hackernews.stories` and `mod_hackernews.comments`
7. Publishes `NormalizedMessage` with contextRef linking to `story:{hn_id}`
8. `updateContexts` job (every 30 minutes) generates AI summaries for recent stories

## HN API Details
- Base: `https://hacker-news.firebaseio.com/v0`
- No authentication required
- No documented rate limit (be respectful with request volume)
- Returns JSON directly, no pagination — story list endpoints return full ID arrays
- Items can be `null`, `deleted`, or `dead` — all filtered out

## Context Key Format
`story:{hn_id}` — one context per story

## Settings
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| enabled | boolean | true | |
| feedTypes | string | "top,best,new,ask,show" | Comma-separated |
| maxStoriesPerFeed | number | 30 | IDs fetched per feed type |
| lookbackHours | number | 24 | Skip stories older than this |
| includeComments | boolean | false | Fetch top-level comments |
| maxCommentsPerStory | number | 5 | Only if includeComments=true |
| requestTimeoutSeconds | number | 15 | Per-request timeout |
| contextPrompt | string | (see module.json) | AI summary system prompt |
| contextPromptFallback | string | (see module.json) | Fallback if JSON parse fails |

## Schema (mod_hackernews)
- `stories` — hn_id (unique), feed_type, title, url, hn_text, author, score, comment_count, hn_time, payload (jsonb)
- `comments` — hn_id (unique), story_hn_id (FK-like), author, hn_text, hn_time, payload (jsonb)
- `story_embeddings` — context_key, embedding (vector), for semantic search

## Tags Emitted
- `source`: "hackernews"
- `feedType`: "top" | "new" | "best" | "ask" | "show" | "job"
- `author`: HN username
- `score`: story points
- `commentCount`: number of descendants
- `storyUrl`: external link (if present)
- `isJob`: true (only for job posts)

## Conventions
- HTML in `text` fields is stripped to plain text (HN API returns HTML for Ask HN / comments)
- `&amp;`, `&lt;`, `&gt;`, `&#x27;` entities are decoded
- `<a>` tags are replaced with their href URL
- `<p>` and `<br>` converted to newlines
- Score and comment count are updated on re-collect (upsert), but message is not re-published

## Lessons Learned
- HN API returns `null` for deleted items — must handle gracefully
- Story IDs from feed endpoints are not guaranteed to be within lookback window — filter by `time` field
- The `descendants` field is total comment count (recursive), not just direct children
- `kids` array is only immediate children IDs
- Job posts (`type: "job"`) have no `score` or `descendants`
- The API is eventually consistent — a story might appear in topstories before its item is fetchable

## What NOT to Do
- Do not fetch all 500 stories from a feed — use maxStoriesPerFeed to limit
- Do not re-publish messages for stories already seen (dedup via `(xmax = 0) AS inserted`)
- Do not call the HN API in parallel with unbounded concurrency — sequential per story to be respectful
- Do not assume `item.url` exists — Ask HN and Show HN posts may only have `text`
