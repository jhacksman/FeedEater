# X (Twitter) Module

**Priority: TBD** (to be assigned based on MAU ranking)

Collects tweets from X (formerly Twitter) using the `bird` CLI tool with browser cookie authentication. This module provides access to your personalized timeline, lists, user tweets, search results, and more.

## ⚠️ API vs Scraping: The Brutal Truth

### Official X API v2 Pricing (as of 2024)

| Tier | Cost | Read Limits | Verdict |
|------|------|-------------|---------|
| **Free** | $0 | **100 reads/month** | Literally unusable for feed reading |
| **Basic** | $200/month | 10,000 reads/month | ~333 tweets/day. Barely viable. |
| **Pro** | $5,000/month | 1,000,000 reads/month | The "real" tier for serious use |
| **Enterprise** | Custom | Custom | Contact sales ($$$$) |

The free tier gives you **100 reads per month**. That's not a typo. You can't even check your feed twice a day.

### Our Approach: bird CLI with Browser Cookies

**bird** is a CLI tool that uses your browser session cookies to access X's internal GraphQL API — the same API the web client uses. This provides:

- ✅ Full access to personalized "For You" and "Following" feeds
- ✅ List timelines
- ✅ User profile tweets
- ✅ Search (same as web search)
- ✅ Mentions, bookmarks, likes
- ✅ JSON output for easy parsing
- ✅ **$0/month**

### The Tradeoff

Using browser cookies means:
- You're using X as your logged-in user, not via official API
- No official rate limits documented (but they exist internally)
- Risk of account restrictions if you abuse it
- Cookies can expire/change (though rarely)

**Verdict**: For personal feed aggregation at reasonable frequency (every 15-30 min), bird CLI is vastly superior to paying $200+/month for the official API.

## Quick Start

### Step 1: Install bird CLI

```bash
# macOS (Homebrew)
brew install bird

# Or via npm
npm install -g @nicepkg/bird
```

Verify installation:
```bash
bird --version
# bird 0.8.0 or higher
```

### Step 2: Set Up Cookie Authentication

bird can extract cookies from your browser automatically. You need two cookies: `auth_token` and `ct0`.

**Option A: Chrome Profile (Recommended)**

1. Log into X (twitter.com) in Chrome
2. Note your Chrome profile name (check `chrome://version/` → "Profile Path")
3. Configure bird:

```bash
# Test it works
bird --chrome-profile "Default" whoami

# Should show your X username
```

**Option B: Firefox Profile**

```bash
bird --firefox-profile "default-release" whoami
```

**Option C: Manual Cookies**

If automatic extraction fails:

1. Open X in your browser
2. Open DevTools (F12) → Application → Cookies → twitter.com
3. Copy the values of `auth_token` and `ct0`
4. Use directly:

```bash
bird --auth-token "YOUR_AUTH_TOKEN" --ct0 "YOUR_CT0" whoami
```

### Step 3: Create bird Config (Optional)

Create `~/.config/bird/config.json5`:

```json5
{
  // Use Chrome for cookie extraction
  chromeProfile: "Default",
  
  // Or Firefox
  // firefoxProfile: "default-release",
  
  // Request timeout (ms)
  timeoutMs: 30000,
}
```

### Step 4: Test Feed Access

```bash
# Your "For You" home timeline
bird home --json -n 10

# Your "Following" timeline (chronological)
bird home --following --json -n 10

# A specific list
bird list-timeline 1234567890 --json -n 20

# A user's tweets
bird user-tweets elonmusk --json -n 10

# Search
bird search "from:OpenAI" --json -n 10
```

### Step 5: Configure FeedEater

In the FeedEater web UI, go to **Settings** > **X (Twitter)** and configure:

| Setting | Value |
|---------|-------|
| **Cookie Source** | `chrome` or `firefox` |
| **Chrome Profile** | Profile name (e.g., `Default`) |
| **Firefox Profile** | Profile name if using Firefox |
| **Feed Type** | `home`, `following`, `list`, or `search` |
| **List ID** | List ID if using list feed |
| **Search Query** | Query string if using search feed |
| **Tweets Per Fetch** | Number of tweets to fetch (default: 50) |
| **Include Replies** | Whether to include reply tweets |
| **Include Retweets** | Whether to include retweets |

### Step 6: Test It

The collector runs every 15 minutes by default. Trigger a manual run from the FeedEater UI to verify.

Check the **Logs** panel for collection activity and errors.

## Available Feed Types

### Home Timeline

Your personalized feed, just like the X app.

```bash
# "For You" (algorithmic)
bird home --json -n 50

# "Following" (chronological)
bird home --following --json -n 50
```

### List Timeline

Curated feeds from Twitter Lists you've created or subscribed to.

```bash
# Get your lists first
bird lists --json

# Then fetch a list's timeline
bird list-timeline <list-id> --json -n 50
```

**Tip**: Lists are great for organizing feeds by topic without polluting your main timeline.

### User Tweets

All tweets from a specific user.

```bash
bird user-tweets <handle> --json -n 50
```

### Search

Any search query X supports.

```bash
bird search "AI safety" --json -n 50
bird search "from:anthropic" --json -n 50
bird search "#machinelearning min_faves:100" --json -n 50
```

### Mentions

Tweets mentioning a user.

```bash
bird mentions --json -n 50
bird mentions --user someuser --json -n 50
```

### Bookmarks

Your saved tweets.

```bash
bird bookmarks --json -n 50
```

## How It Works

The X module runs scheduled jobs:

**collect** (every 15 minutes): Executes bird CLI commands to fetch tweets, parses JSON output, stores in the module's private database, and publishes to the FeedEater message bus.

**updateContexts** (every 30 minutes): Groups related tweets (threads, quote-tweet chains) into Contexts with AI-generated summaries.

## Context Keys

Tweets are organized into Contexts:

- **Threads**: `thread:{conversation_id}` — A tweet and its replies
- **Quote chains**: `quote:{original_tweet_id}` — Quote tweets of a viral post
- **User activity**: `user:{user_id}:{date}` — A user's tweets for the day
- **Search results**: `search:{query_hash}:{date}` — Search result batches

## What It Stores

Raw tweet data (plus convenience columns) in:
- `mod_twitter.tweets` — All collected tweets
- `mod_twitter.tweet_embeddings` — Vector embeddings for semantic search

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the module |
| `cookieSource` | enum | `chrome` | Cookie source: `chrome`, `firefox`, or `manual` |
| `chromeProfile` | string | `Default` | Chrome profile name |
| `firefoxProfile` | string | — | Firefox profile name |
| `authToken` | secret | — | Manual auth_token cookie (if cookieSource=manual) |
| `ct0Token` | secret | — | Manual ct0 cookie (if cookieSource=manual) |
| `feedType` | enum | `home` | Feed type: `home`, `following`, `list`, `search`, `user` |
| `listId` | string | — | List ID (if feedType=list) |
| `searchQuery` | string | — | Search query (if feedType=search) |
| `targetUser` | string | — | Username (if feedType=user) |
| `tweetsPerFetch` | number | `50` | Tweets to fetch per collection run |
| `includeReplies` | boolean | `false` | Include reply tweets |
| `includeRetweets` | boolean | `true` | Include retweets |
| `pollIntervalMinutes` | number | `15` | How often to collect tweets |

## Alternatives Considered (and Rejected)

### Nitter

Nitter was a privacy-focused Twitter frontend that exposed RSS feeds. **It's effectively dead** as of 2023-2024. Most public instances have shut down after Twitter's API changes, and the main nitter.net instance returns empty responses.

### RSS Bridges

Various RSS bridge services that scraped Twitter have also been blocked or shut down.

### Syndication Endpoints

Twitter's old syndication/embed endpoints (`syndication.twitter.com`) are heavily rate-limited and don't include personalized feeds.

### Official API with Free Tier

100 reads/month is not a typo. It's not viable for any real use case.

## Troubleshooting

**"Could not find cookies" error**: Make sure you're logged into X in the browser, and the profile name is correct. Try `bird --chrome-profile "Profile 1"` (note the space).

**"Bad guest token" error**: Your cookies may have expired. Log out and back into X in your browser.

**Empty responses**: X may be rate-limiting your session. Wait 15-30 minutes and try again with fewer tweets.

**"Account locked" warning**: You've made too many requests. Reduce `tweetsPerFetch` and `pollIntervalMinutes`. See CLAUDE.md for rate limit guidance.

**Cookies not refreshing**: bird caches cookies. Delete `~/.config/bird/` and try again.

## For AI Agents

See [CLAUDE.md](./CLAUDE.md) for detailed context on this module's architecture, conventions, and lessons learned.
