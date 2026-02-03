# Reddit Module

**Priority: #2**

Collects posts from your Reddit home feed and subscribed subreddits, organizing them into Contexts. Comment threads become their own contexts with AI-generated summaries, making it easy to track discussions across your favorite communities.

## ⚠️ Important: 2023 API Changes

In April 2023, Reddit introduced significant API pricing changes that affected many third-party applications. Key points:

- **Free tier still exists** for non-commercial, personal use
- **Rate limit**: 100 queries per minute (QPM) for OAuth-authenticated requests
- **Free tier cap**: ~1000 API calls per day for personal scripts
- **Commercial use** requires a paid agreement with Reddit

For FeedEater (personal, non-commercial use), the free tier is sufficient. We'll implement conservative rate limiting to stay well within bounds.

## Quick Start

### Step 1: Create a Reddit App

1. Go to [https://www.reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Scroll down and click **"are you a developer? create an app..."**
3. Fill in the form:
   - **name**: FeedEater (or any name)
   - **App type**: Select **script** (for personal use on your own account)
   - **description**: (optional)
   - **about url**: (optional)
   - **redirect uri**: `http://localhost:8080` (required but not used for script type)
4. Click **Create app**
5. Note your credentials:
   - **Client ID**: The string under "personal use script" (14 characters)
   - **Client Secret**: The string next to "secret"

### Step 2: Understand App Types

| Type | Use Case | Has Secret | Can Access User Data |
|------|----------|------------|---------------------|
| **script** | Personal bots, your account only | Yes | Yes (your account) |
| **web app** | Server-side apps, multiple users | Yes | Yes (via OAuth flow) |
| **installed app** | Mobile/desktop apps | No | Yes (via OAuth flow) |

For FeedEater, **script** type is recommended - it's simplest for personal use and allows direct username/password authentication.

### Step 3: Configure FeedEater

In the FeedEater web UI, go to **Settings** > **Reddit** and configure:

| Setting | Value |
|---------|-------|
| **Client ID** | Your 14-character client ID from Step 1 |
| **Client Secret** | Your client secret from Step 1 |
| **Username** | Your Reddit username |
| **Password** | Your Reddit password |
| **User Agent** | A unique identifier (e.g., `FeedEater/1.0 by u/YourUsername`) |
| **Feed Types** | Which feeds to collect: `home`, `saved`, or specific subreddits |
| **Lookback Hours** | How far back to look for posts (default: 24) |

> ⚠️ **Security Note**: Your Reddit password is stored encrypted in FeedEater's settings database and never logged.

### Step 4: Test It

The Reddit collector runs every 10 minutes by default. You can trigger a manual run from the FeedEater UI to test immediately.

Check the **Logs** panel to see collection activity and any errors.

## How It Works

The Reddit module runs two scheduled jobs:

**collect** (every 10 minutes): Fetches new posts from your configured feeds, stores them in the module's private database, and publishes them to the FeedEater message bus. Uses cursor-based pagination (`after` token) to efficiently fetch only new content.

**updateContexts** (every 30 minutes): Refreshes AI summaries for active comment threads. Uses semantic search to find the most relevant comments, then generates summaries.

## Feed Types

### Home Feed (Personalized)
Your Reddit home page - posts from all subreddits you're subscribed to, ranked by Reddit's algorithm.

```
feedTypes: ["home"]
```

This uses the `GET /best` endpoint, which returns posts from your subscriptions ranked by Reddit's "Best" algorithm.

### Specific Subreddits
Posts from specific subreddits (doesn't require subscription):

```
feedTypes: ["r/programming", "r/MachineLearning", "r/selfhosted"]
```

### Saved Posts
Posts and comments you've saved on Reddit:

```
feedTypes: ["saved"]
```

### Multireddits
Custom collections of subreddits:

```
feedTypes: ["m/YourMulti"]
```

### Mixed Configuration
Combine multiple feed types:

```
feedTypes: ["home", "r/AskReddit", "saved"]
```

## Context Keys

Each Reddit thread becomes its own Context with the key format: `{subreddit}:{postId}`

For example: `AskReddit:abc123def`

Comment threads within a post use: `{subreddit}:{postId}:{commentId}`

## What It Stores

Raw Reddit post/comment data (plus convenience columns) in:
- `mod_reddit.reddit_posts` - All collected posts
- `mod_reddit.reddit_comments` - Comments from threads
- `mod_reddit.reddit_post_embeddings` - Vector embeddings for semantic search

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the module |
| `clientId` | string | required | Reddit app client ID |
| `clientSecret` | secret | required | Reddit app client secret |
| `username` | string | required | Reddit username |
| `password` | secret | required | Reddit password |
| `userAgent` | string | required | Unique app identifier (e.g., `FeedEater/1.0 by u/you`) |
| `feedTypes` | string[] | `["home"]` | Which feeds to collect |
| `lookbackHours` | number | `24` | How far back to fetch posts |
| `includeComments` | boolean | `true` | Fetch top comments on posts |
| `commentDepth` | number | `3` | How many levels of comment replies to fetch |
| `minScore` | number | `0` | Minimum post score to collect |
| `excludeNSFW` | boolean | `true` | Skip NSFW posts |
| `postsPerFeed` | number | `25` | Max posts to fetch per feed per run |
| `rateLimitDelay` | number | `1000` | Milliseconds between API calls |

## API Details

### Authentication Flow (Script Type)

1. Send POST to `https://www.reddit.com/api/v1/access_token`
2. Use HTTP Basic Auth with `clientId:clientSecret`
3. Body: `grant_type=password&username=USER&password=PASS`
4. Receive access token (expires in 1 hour)
5. Token auto-refreshes before expiration

### Key Endpoints

| Endpoint | Scope Required | Description |
|----------|---------------|-------------|
| `GET /best` | `read` | User's personalized home feed |
| `GET /r/{sub}/new` | `read` | New posts from a subreddit |
| `GET /user/{user}/saved` | `history` | User's saved posts/comments |
| `GET /api/v1/me/karma` | `mysubreddits` | Karma breakdown by subreddit |
| `GET /subreddits/mine/subscriber` | `mysubreddits` | User's subscribed subreddits |

### Rate Limits

- **100 requests per minute** for OAuth requests
- Rate limit info returned in response headers:
  - `X-Ratelimit-Remaining`: Requests left in current window
  - `X-Ratelimit-Reset`: Seconds until window resets
  - `X-Ratelimit-Used`: Requests used in current window

## Pagination

Reddit uses cursor-based pagination with `after` tokens:

```
GET /r/subreddit/new?limit=25&after=t3_abc123
```

- `after`: The fullname of the last item in the previous page
- `before`: For paginating backward (rarely needed)
- `limit`: 1-100, default 25

**Important**: Store the `after` value from each response to continue fetching from where you left off.

## Required OAuth Scopes

For FeedEater's functionality, request these scopes:

| Scope | Purpose |
|-------|---------|
| `identity` | Verify user identity |
| `read` | Read posts from feeds |
| `history` | Access saved posts |
| `mysubreddits` | List subscribed subreddits |

## Troubleshooting

### "Invalid credentials" error
- Verify your client ID and secret are correct
- Check that your Reddit username and password are correct
- If you have 2FA enabled, you may need to use an app-specific password or disable 2FA

### "Rate limit exceeded" error
- Increase `rateLimitDelay` setting
- Reduce `postsPerFeed` setting
- The module automatically respects rate limits, but aggressive settings can still trigger them

### "Forbidden" error on home feed
- The script app type should have access to your home feed
- Verify the `read` scope is granted
- Try fetching a specific subreddit first to isolate the issue

### No posts appearing
- Check that `lookbackHours` is set high enough
- Verify your feed types are correct (e.g., `home` not `Home`)
- Check the logs for specific API errors

### Comments not loading
- Set `includeComments: true`
- Some posts may have comments disabled
- Very old posts may have limited comment availability

## JavaScript Library: snoowrap

For implementation, we'll use [snoowrap](https://github.com/not-an-aardvark/snoowrap), a fully-featured Reddit API wrapper:

```bash
npm install snoowrap
```

Key features:
- Automatic token refresh
- Built-in rate limit handling
- Promise-based API
- Automatic request queuing

## For AI Agents

See [CLAUDE.md](./CLAUDE.md) for detailed context on this module's architecture, conventions, and lessons learned.
