# GitHub Module — CLAUDE.md

## Data Flow

```
GitHub REST API (/notifications, /users/:u/received_events, /repos/:r/releases)
  → GitHubIngestor (fetch, dedup, persist)
    → mod_github.notifications / events / releases (Postgres)
      → NormalizedMessage → NATS feedeater.github.messageCreated
        → AI summary → NATS feedeater.github.contextUpdated
```

## GitHub API Details

- Base URL: `https://api.github.com`
- Auth: Personal Access Token (PAT) — Bearer header
- API Version: `2022-11-28` (pinned via `X-GitHub-Api-Version` header)
- Rate Limit: 5000 req/hour authenticated
- Polling: `Last-Modified` / `If-Modified-Since` for notifications, `ETag` / `If-None-Match` for events
- Events API returns max 300 events, last 30 days only

## Three Collection Streams

| Stream | Endpoint | Schedule | What it collects |
|---|---|---|---|
| Notifications | `GET /notifications` | */5 * * * * | Issues, PRs, commits the user is subscribed to |
| Events | `GET /users/{username}/received_events` | */5 * * * * | Stars, forks, PRs, issues from followed repos/users |
| Releases | `GET /repos/{owner}/{repo}/releases` | */15 * * * * | New releases from explicitly watched repos |

## Context Key Format

`repo:{owner}/{repo}` — one context per repository, aggregating all activity types.

## Settings

| Key | Type | Default | Description |
|---|---|---|---|
| enabled | boolean | true | Master switch |
| accessToken | secret | (required) | GitHub PAT |
| username | string | (required) | GitHub username for events feed |
| watchedRepos | string | "" | Comma-separated `owner/repo` list for release tracking |
| collectNotifications | boolean | true | Poll notifications |
| collectEvents | boolean | true | Poll received events |
| collectReleases | boolean | true | Poll releases (requires watchedRepos) |
| lookbackHours | number | 24 | How far back to look for activity |
| maxEventsPerPoll | number | 100 | Max events per poll (API max is 100/page) |
| requestTimeoutSeconds | number | 15 | HTTP timeout per request |
| contextPrompt | string | (see module.json) | AI summary system prompt |
| contextPromptFallback | string | (see module.json) | Fallback summary prompt |

## Schema (mod_github)

### notifications
- `id` (PK), `gh_id` (unique), `reason`, `subject_title`, `subject_type`, `subject_url`, `repo_name`, `updated_at`, `unread`, `payload` (jsonb), `collected_at`

### events
- `id` (PK), `gh_id` (unique), `event_type`, `actor`, `repo_name`, `description`, `created_at`, `payload` (jsonb), `collected_at`

### releases
- `id` (PK), `gh_id` (unique), `repo_name`, `tag_name`, `release_name`, `body`, `html_url`, `author`, `published_at`, `is_prerelease`, `payload` (jsonb), `collected_at`

### activity_embeddings
- `id` (PK), `context_key`, `ts`, `embedding` (vector)

## Tags Emitted

### Notification messages
`source: github`, `stream: notification`, `reason`, `subjectType`, `repo`, `unread`

### Event messages
`source: github`, `stream: event`, `eventType` (PushEvent, IssuesEvent, etc.), `actor`, `repo`

### Release messages
`source: github`, `stream: release`, `repo`, `tagName`, `author`, `isPrerelease`

## Event Type Descriptions

The module formats 11 event types into human-readable descriptions:
PushEvent, CreateEvent, DeleteEvent, IssuesEvent, PullRequestEvent, IssueCommentEvent, WatchEvent, ForkEvent, ReleaseEvent, PullRequestReviewEvent, PullRequestReviewCommentEvent. Unknown types fall back to `"{actor} performed {type} on {repo}"`.

## Conventions

- Notification API URLs are converted to `github.com` HTML URLs via regex replacement
- `isDirectMention` is true for notifications with reason `mention` or `team_mention`
- Releases skip drafts; only published/pre-release are collected
- Release body is truncated to 500 chars in the NormalizedMessage
- Events older than `lookbackHours` are filtered out client-side
- ETag/Last-Modified caching reduces API calls and avoids hitting rate limits

## Lessons Learned

- GitHub notifications API only works with classic PATs (not fine-grained tokens)
- Events API has 6h latency in worst case — not suitable for real-time use
- `ON CONFLICT DO NOTHING` for events (immutable) vs `DO UPDATE` for notifications (unread state changes)
- The events API returns max 10 pages of 30 events = 300 total; the module fetches 1 page per poll
- Release `published_at` can be null for very old releases; falls back to `created_at`

## What NOT to Do

- Don't fetch all pages of events (300 max, wastes rate limit)
- Don't assume notifications API works with fine-grained PATs
- Don't skip the `X-GitHub-Api-Version` header (API behavior changes between versions)
- Don't store the PAT anywhere except encrypted module settings
- Don't poll releases for repos not in `watchedRepos` (no discovery mechanism)
