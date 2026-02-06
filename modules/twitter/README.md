# X (Twitter) Module

**Priority: TBD** (to be assigned based on MAU ranking)

Collects tweets from X (formerly Twitter) using the Rettiwt-API library. This module provides access to user timelines, your home feed, lists, and search results - all without paying for the official Twitter API.

## API vs Scraping: The Brutal Truth

### Official X API v2 Pricing (as of 2024)

| Tier | Cost | Read Limits | Verdict |
|------|------|-------------|---------|
| **Free** | $0 | **100 reads/month** | Literally unusable for feed reading |
| **Basic** | $200/month | 10,000 reads/month | ~333 tweets/day. Barely viable. |
| **Pro** | $5,000/month | 1,000,000 reads/month | The "real" tier for serious use |
| **Enterprise** | Custom | Custom | Contact sales ($$$$) |

The free tier gives you **100 reads per month**. That's not a typo. You can't even check your feed twice a day.

### Our Approach: Rettiwt-API

**Rettiwt-API** is a TypeScript library that uses Twitter's internal web API (the same API the website uses). This provides:

- Full access to user timelines (no login required)
- Home timeline, lists, search (with login)
- JSON output for easy parsing
- **$0/month**
- No browser cookies to extract
- Session persistence (login once, reuse the key)

### Authentication Modes

**Guest Mode** (no login required):
- User timeline (any public user's tweets)
- Tweet details
- User details

**User Mode** (requires login):
- Home timeline
- List timelines
- Search
- Everything in guest mode

## Quick Start

### Option 1: Guest Mode (Easiest)

No credentials needed. Just configure which users to follow:

1. Go to FeedEater Settings > Twitter
2. Set **Auth Mode** to `guest`
3. Set **Feed Sources** to track specific users:
   ```json
   [
     {"type": "user", "username": "karpathy"},
     {"type": "user", "username": "ylecun"},
     {"type": "user", "username": "OpenAI"}
   ]
   ```
4. Save and enable the module

### Option 2: User Mode (Full Access)

For home timeline, lists, and search, you need an API key. The API key is generated from your browser session cookies using a browser extension.

**Getting your API key:**

**For Chrome/Chromium:**
1. Install the [X Auth Helper extension](https://chromewebstore.google.com/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp)
2. Open an incognito window and log into Twitter/X
3. Click the extension and click "Get Key"
4. Copy the API key

**For Firefox:**
1. Install the [Rettiwt Auth Helper extension](https://addons.mozilla.org/en-US/firefox/addon/rettiwt-auth-helper)
2. Open a private window and log into Twitter/X
3. Click the extension and click "Get API Key"
4. Copy the API key

**Configuring FeedEater:**
1. Go to FeedEater Settings > Twitter
2. Set **Auth Mode** to `user`
3. Paste your **API Key**
4. Configure feed sources:
   ```json
   [
     {"type": "home"},
     {"type": "list", "listId": "1234567890"},
     {"type": "search", "query": "AI safety"}
   ]
   ```
5. Save and enable the module

**Note**: The API key lasts ~5 years as long as you don't log out of Twitter in that browser session. Using incognito/private mode ensures you don't accidentally invalidate the key by logging out.

## Feed Source Types

### User Timeline (Guest or User mode)

Fetch tweets from any public user:

```json
{"type": "user", "username": "elonmusk"}
```

### Home Timeline (User mode only)

Your personalized home feed:

```json
{"type": "home"}
```

### List Timeline (User mode only)

Tweets from a Twitter List:

```json
{"type": "list", "listId": "1234567890", "name": "AI Researchers"}
```

To find a list ID: Open the list on twitter.com, the URL will be `twitter.com/i/lists/1234567890`

### Search (User mode only)

Search results for any query:

```json
{"type": "search", "query": "from:anthropic AI safety"}
```

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the module |
| `authMode` | string | `guest` | `guest` (limited) or `user` (full access) |
| `username` | string | — | Twitter username (for user mode) |
| `password` | string | — | Twitter password (for user mode) |
| `email` | string | — | Twitter email (for user mode) |
| `apiKey` | string | — | Rettiwt API key (alternative to credentials) |
| `feedSources` | JSON | `[{"type":"user","username":"elonmusk"}]` | Array of feed sources |
| `tweetsPerRequest` | number | `20` | Tweets to fetch per source |
| `lookbackHours` | number | `24` | Hours to look back for context updates |
| `requestDelayMs` | number | `5000` | Delay between requests (rate limiting) |

## How It Works

The X module runs scheduled jobs:

**collect** (every 15 minutes): Uses Rettiwt-API to fetch tweets from configured sources, stores in the module's private database, and publishes to the FeedEater message bus.

**updateContexts** (every 30 minutes): Groups related tweets (threads, conversations) into Contexts with AI-generated summaries.

## Context Keys

Tweets are organized into Contexts:

- **Threads**: `thread:{conversation_id}` — A tweet and its replies

## What It Stores

Raw tweet data (plus convenience columns) in:
- `mod_twitter.tweets` — All collected tweets
- `mod_twitter.tweet_embeddings` — Vector embeddings for semantic search

## Troubleshooting

**"Login failed" error**: Check your credentials. If you have 2FA enabled, you may need to use an app password or disable 2FA temporarily.

**"User not found" error**: The username may be incorrect or the account may be private/suspended.

**Empty responses**: Twitter may be rate-limiting. Increase `requestDelayMs` and reduce `tweetsPerRequest`.

**Session expired**: If using an API key, it may have expired. Clear the `apiKey` setting and re-enter your credentials to generate a new one.

## Alternatives Considered

### bird CLI (Previous Approach)

The previous version of this module used the `bird` CLI tool with browser cookie extraction. While functional, it required:
- Installing a separate CLI tool
- Extracting cookies from your browser
- Dealing with cookie expiration

Rettiwt-API is simpler: just username/password, and it handles session management internally.

### Official API

100 reads/month on the free tier is not viable for any real use case. Basic tier at $200/month is expensive for personal use.

### Nitter / RSS Bridges

Nitter and most RSS bridges for Twitter have been shut down or blocked as of 2023-2024.

### bird.makeup (Mastodon Bridge)

Works for following Twitter users via Mastodon, but has refresh rate issues for less popular accounts. Good alternative if you're already using Mastodon.

## For AI Agents

See [CLAUDE.md](./CLAUDE.md) for detailed context on this module's architecture, conventions, and lessons learned.
