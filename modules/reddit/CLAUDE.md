# Reddit Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the Reddit module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The Reddit module collects posts and comments from Reddit feeds (home feed, specific subreddits, saved posts) and organizes them into FeedEater's Context system. Comment threads become their own contexts with AI-generated summaries.

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Reddit API                                  │
│  oauth.reddit.com                                                    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ OAuth 2.0 (password grant)
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      collect job (every 10 min)                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐   │
│  │ Fetch /best  │───▶│ Deduplicate  │───▶│ Store in mod_reddit  │   │
│  │ Fetch /r/sub │    │ by post ID   │    │ Publish to NATS      │   │
│  │ Fetch /saved │    │              │    │                      │   │
│  └──────────────┘    └──────────────┘    └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ MessageCreated event
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 updateContexts job (every 30 min)                    │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐   │
│  │ Find active  │───▶│ Semantic     │───▶│ Generate AI summary  │   │
│  │ threads      │    │ search       │    │ Publish ContextUpdated│   │
│  └──────────────┘    └──────────────┘    └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Context Key Format

`{subreddit}:{postId}` - e.g., `AskReddit:abc123def`

For comment threads: `{subreddit}:{postId}:{rootCommentId}`

### Key Files (To Be Created)

- `src/ingest.ts` - Core `RedditIngestor` class with all collection and context logic
- `src/runtime.ts` - Job handlers that wire up the ingestor
- `src/client.ts` - Wrapper around snoowrap with auth handling
- `module.json` - Job definitions, settings schema, UI cards
- `settings.ts` - TypeScript types for settings (mirrors module.json)

## Conventions

### Settings

All settings come from the FeedEater settings registry, not environment variables. The module fetches them via `ctx.fetchInternalSettings("reddit")`.

Secrets (like `clientSecret`, `password`) are encrypted at rest and only decrypted when fetched via the internal API.

### Database

- Private schema: `mod_reddit`
- Tables: `reddit_posts`, `reddit_comments`, `reddit_post_embeddings`
- Use `ensureSchema()` to create tables on first run
- Never access other modules' schemas

### Bus Events

- Emit `PostCreated` on `feedeater.reddit.postCreated`
- Emit `CommentCreated` on `feedeater.reddit.commentCreated`
- Emit `ContextUpdated` on `feedeater.reddit.contextUpdated`
- Use `subjectFor("reddit", "eventName")` helper

### Logging

Use the `log()` method which publishes to `feedeater.reddit.log` for visibility in the FeedEater UI.

## Reddit API Quirks

### Authentication

- **Access tokens expire in 1 hour** - must refresh or re-authenticate
- Script-type apps use password grant: `grant_type=password&username=X&password=Y`
- Tokens are per-user, not per-app
- **User-Agent is required** - Reddit blocks requests without a descriptive User-Agent
- Format: `platform:appid:version (by /u/username)`

### Rate Limiting

- **100 requests per minute** (6000/hour) for OAuth requests
- Headers tell you current status:
  - `X-Ratelimit-Remaining`: float, requests left
  - `X-Ratelimit-Reset`: seconds until window resets
  - `X-Ratelimit-Used`: requests used this window
- **Best practice**: Add 1000ms delay between requests minimum
- snoowrap handles rate limiting automatically, but configure `requestDelay`

### Pagination

Reddit uses cursor-based pagination with "fullnames":
- Fullnames are `kind_id` (e.g., `t3_abc123` for a link, `t1_xyz789` for a comment)
- `after=t3_abc123` returns items after that post
- **Important**: Store the `after` cursor to resume fetching
- Max 100 items per request
- Empty `children` array means no more pages

### Fullname Prefixes

| Prefix | Type |
|--------|------|
| t1_ | Comment |
| t2_ | Account |
| t3_ | Link (post) |
| t4_ | Message |
| t5_ | Subreddit |
| t6_ | Award |

### The Home Feed

- `GET /best` - Reddit's "Best" algorithm (personalized)
- `GET /hot` - Hot posts (also personalized if authenticated)
- `GET /` - Same as /hot
- **All require authentication** for personalized results
- Without auth, you get the global front page

### Comment Threading

- Comments have a `parent_id` field (fullname of parent post or comment)
- Replies are nested in a `replies` property (can be deeply nested)
- Reddit returns `"replies": ""` (empty string) for comments with no replies
- Use `expandReplies()` in snoowrap to flatten the tree

### Common Gotchas

1. **Empty strings vs null**: Reddit often uses `""` instead of `null`
2. **Deleted content**: Shows as `[deleted]` or `[removed]`
3. **Score fuzzing**: Reddit fuzzes scores slightly on popular posts
4. **Timestamps are UTC epoch floats**: e.g., `1234567890.0`
5. **NSFW flag**: Called `over_18` in the API

## What NOT To Do

- **Don't hardcode credentials** - Use the settings registry
- **Don't skip User-Agent** - Reddit will block you
- **Don't ignore rate limits** - Your IP can get banned
- **Don't poll faster than every 5 min** - Unnecessary and wasteful
- **Don't fetch full comment trees** - Use depth limits, trees can be huge
- **Don't trust score values** - They're fuzzy and change
- **Don't assume all fields exist** - Check for null/undefined/empty string
- **Don't store access tokens** - They expire in 1 hour; store refresh tokens if using web/installed app type
- **Don't forget pagination** - Always handle the `after` cursor

## Data Structures

### Post Object (simplified)

```typescript
interface RedditPost {
  id: string;           // e.g., "abc123"
  name: string;         // e.g., "t3_abc123"
  title: string;
  selftext: string;     // body text (for self posts)
  url: string;          // link URL or post URL
  author: string;       // username
  subreddit: string;    // subreddit name (no r/ prefix)
  score: number;        // upvotes - downvotes
  num_comments: number;
  created_utc: number;  // Unix timestamp
  over_18: boolean;     // NSFW flag
  is_self: boolean;     // true if self/text post
  permalink: string;    // relative URL
  // ... many more fields
}
```

### Comment Object (simplified)

```typescript
interface RedditComment {
  id: string;
  name: string;         // e.g., "t1_xyz789"
  body: string;
  author: string;
  score: number;
  created_utc: number;
  parent_id: string;    // t3_ for post, t1_ for parent comment
  link_id: string;      // t3_ of the post
  depth: number;        // nesting level (0 = top-level)
  replies: Listing;     // nested replies (or empty string)
}
```

## Pagination Handling

### Store Pagination State

```sql
CREATE TABLE mod_reddit.pagination_state (
  feed_key VARCHAR PRIMARY KEY,  -- e.g., "home", "r/programming"
  after_cursor VARCHAR,          -- last seen fullname
  last_fetched_at TIMESTAMP,
  posts_fetched INT DEFAULT 0
);
```

### Fetch Loop Pattern

```typescript
async function fetchFeed(feedKey: string, limit: number) {
  const state = await getPaginationState(feedKey);
  let after = state?.after_cursor;
  let allPosts = [];
  
  while (allPosts.length < limit) {
    const response = await reddit.get(feedKey, { after, limit: 25 });
    const posts = response.children;
    
    if (posts.length === 0) break;  // No more content
    
    allPosts.push(...posts);
    after = posts[posts.length - 1].name;  // Update cursor
    
    await delay(1000);  // Rate limit delay
  }
  
  await savePaginationState(feedKey, after);
  return allPosts;
}
```

## snoowrap Configuration

```typescript
import Snoowrap from 'snoowrap';

const reddit = new Snoowrap({
  userAgent: 'FeedEater/1.0 (by /u/YourUsername)',
  clientId: settings.clientId,
  clientSecret: settings.clientSecret,
  username: settings.username,
  password: settings.password,
});

// Configure rate limiting
reddit.config({
  requestDelay: 1000,           // 1 second between requests
  requestTimeout: 30000,        // 30 second timeout
  continueAfterRatelimitError: true,  // Queue requests if rate limited
  warnings: false,              // Disable console warnings
});
```

### Key snoowrap Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `r.getBest()` | Home feed (Best) | Listing |
| `r.getHot('subreddit')` | Hot posts | Listing |
| `r.getNew('subreddit')` | New posts | Listing |
| `r.getSubmission(id)` | Single post | Submission |
| `r.getMe().getSavedContent()` | Saved posts/comments | Listing |
| `r.getSubreddit('name')` | Subreddit object | Subreddit |
| `submission.expandReplies()` | Flatten comment tree | Submission |

## Lessons Learned

### 2023 API Changes

- Free tier is still usable for personal, non-commercial use
- Rate limits are enforced more strictly
- Some endpoints may require approval for commercial apps
- No major changes to endpoint structure

### Handling Deleted Content

- Deleted by user: `author` = `[deleted]`, content may remain
- Removed by mods: `author` = `[deleted]`, `body` = `[removed]`
- Check for these strings before processing

### Subreddit Names

- Store without the `r/` prefix: `programming`, not `r/programming`
- API endpoints use `/r/subreddit` but return data without prefix
- Be consistent in your storage format

### Token Management

For script apps, you can authenticate with username/password each session - no need to store tokens since they expire in 1 hour anyway. snoowrap handles this automatically.

## Testing Locally

1. Set up FeedEater's docker-compose environment
2. Create a Reddit app at reddit.com/prefs/apps (script type)
3. Configure Reddit settings in the FeedEater UI
4. Trigger a manual `collect` job
5. Check logs panel for errors
6. Verify posts appear in the feed

## Future Improvements

- [ ] Support for web/installed app types (user OAuth flow)
- [ ] Real-time streaming via Reddit's streaming API
- [ ] Multireddit support
- [ ] User profile/comment collection
- [ ] Award tracking
- [ ] Crosspost detection
- [ ] Subreddit auto-discovery based on user activity
- [ ] Comment sentiment analysis
