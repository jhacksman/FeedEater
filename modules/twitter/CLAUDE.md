# X (Twitter) Module - AI Agent Context

This file captures project rules, conventions, and lessons learned for AI agents working on the X module. Following the [Boris Cherny Method](https://github.com/jhacksman/boris-method).

## What This Module Does

The X module collects tweets using the `bird` CLI tool (browser cookie authentication) and organizes them into FeedEater's Context system. It provides access to personalized timelines that the official free API cannot.

## Architecture Decision: bird CLI over Official API

### Why NOT the Official API

| Tier | Cost | Read Limit | Reality |
|------|------|------------|---------|
| Free | $0 | 100/month | Can't even check feed daily |
| Basic | $200/mo | 10k/month | ~333 tweets/day — barely viable |
| Pro | $5,000/mo | 1M/month | Real tier, insane price |

**The free tier is not viable for any feed reading use case.**

### Why bird CLI

- Uses X's internal GraphQL API (same as web client)
- Authenticates via browser session cookies
- Full access to personalized "For You" and "Following" feeds
- No API key needed, no monthly cost
- JSON output for easy parsing

### The Tradeoff

- No documented rate limits (internal limits exist)
- Account risk if you abuse it (but low for reasonable polling)
- Cookie management required (rarely changes)

**Decision**: For personal feed aggregation at 15-30 min intervals, bird is vastly superior.

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        collect job (every 15 min)               │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  bird CLI                                                       │
│  - Extracts cookies from Chrome/Firefox                         │
│  - Calls X GraphQL API                                          │
│  - Returns JSON array of tweets                                 │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  Tweet Parser                                                   │
│  - Normalize tweet structure                                    │
│  - Extract conversation_id, quote chains                        │
│  - Handle media, quoted tweets, retweets                        │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  mod_twitter.tweets (Postgres)                                  │
│  - Store raw + normalized tweet data                            │
│  - Dedupe by tweet_id                                           │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  NATS: feedeater.twitter.messageCreated                         │
│  - Publish normalized message envelopes                         │
│  - Include contextRef for thread grouping                       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    updateContexts job (every 30 min)            │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  Context Aggregator                                             │
│  - Group tweets by conversation_id                              │
│  - Find quote-tweet chains                                      │
│  - Semantic search for related tweets                           │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  AI Summary Generator                                           │
│  - Generate short/long summaries via Ollama                     │
│  - Include key participants, topics, sentiment                  │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  NATS: feedeater.twitter.contextUpdated                         │
│  - Publish context updates                                      │
└─────────────────────────────────────────────────────────────────┘
```

## Rate Limit Strategy

X doesn't document GraphQL rate limits, but they exist. Based on observed behavior:

### Safe Polling Rates

| Feed Type | Recommended Interval | Max Tweets/Request |
|-----------|---------------------|-------------------|
| Home (For You) | 15 min | 50 |
| Home (Following) | 15 min | 50 |
| List Timeline | 15 min | 50 |
| User Tweets | 30 min | 50 |
| Search | 30 min | 50 |
| Mentions | 30 min | 30 |

### Warning Signs

1. **Empty responses**: Throttling has kicked in. Back off.
2. **401 errors**: Cookies expired. Re-extract from browser.
3. **429 errors**: Hard rate limit hit. Wait 15+ minutes.
4. **Account warnings**: Too aggressive. Reduce frequency immediately.

### Backoff Strategy

```typescript
async function fetchWithBackoff(command: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await execBird(command);
      if (result.tweets?.length === 0 && i < retries - 1) {
        // Possible throttle, back off
        await sleep(60000 * (i + 1)); // 1min, 2min, 3min
        continue;
      }
      return result;
    } catch (err) {
      if (err.code === 429 || err.message.includes('rate limit')) {
        await sleep(900000); // 15 minutes
        continue;
      }
      throw err;
    }
  }
}
```

## What NOT To Do

### 🚫 NEVER: Aggressive Pagination

```bash
# THIS WILL GET YOU BANNED
bird list-timeline 123456 --all  # Fetches ALL tweets
bird search "keyword" --all      # Fetches ALL results
```

bird even warns you: `"WARNING: your account might get banned using this flag"`

### 🚫 NEVER: High-Frequency Polling

```typescript
// DON'T DO THIS
setInterval(() => fetchTweets(), 60000); // Every minute = ban
```

### 🚫 NEVER: Parallel Feed Fetching

```typescript
// DON'T DO THIS
await Promise.all([
  fetchHome(),
  fetchList1(),
  fetchList2(),
  fetchList3(),
  fetchMentions(),
  fetchSearch(),
]); // Too many concurrent requests
```

Instead, stagger requests:
```typescript
await fetchHome();
await sleep(5000);
await fetchList1();
await sleep(5000);
// etc.
```

### 🚫 NEVER: Ignore Empty Responses

Empty response = possible throttle. Don't just retry immediately.

### 🚫 NEVER: Store Cookies in Module Settings

Cookies should come from browser extraction, not be stored in FeedEater's settings. They're session tokens that can change.

## Conventions

### Settings

All settings come from FeedEater settings registry. Cookie extraction happens at runtime from the specified browser profile.

Sensitive settings (manual auth tokens if used) are encrypted at rest.

### Database

- Private schema: `mod_twitter`
- Tables: `tweets`, `tweet_embeddings`
- Use `ensureSchema()` to create tables on first run
- Never access other modules' schemas

### Bus Events

- Emit `MessageCreated` on `feedeater.twitter.messageCreated`
- Emit `ContextUpdated` on `feedeater.twitter.contextUpdated`
- Use `subjectFor("twitter", "eventName")` helper

### Logging

Use the `log()` method which publishes to `feedeater.twitter.log` for visibility in the FeedEater UI.

## Tweet Data Structure

bird outputs tweets with this structure (simplified):

```json
{
  "id": "1234567890123456789",
  "text": "Tweet content here",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "author": {
    "id": "987654321",
    "username": "someuser",
    "displayName": "Some User",
    "verified": false,
    "blueVerified": true
  },
  "metrics": {
    "likes": 42,
    "retweets": 10,
    "replies": 5,
    "quotes": 2,
    "bookmarks": 3,
    "views": 1500
  },
  "conversationId": "1234567890123456789",
  "inReplyToId": null,
  "quotedTweet": null,
  "retweetedTweet": null,
  "media": [],
  "urls": [],
  "hashtags": [],
  "mentions": []
}
```

## Context Key Format

| Context Type | Key Format | Example |
|-------------|------------|---------|
| Thread | `thread:{conversation_id}` | `thread:1234567890123456789` |
| Quote chain | `quote:{original_tweet_id}` | `quote:1234567890123456789` |
| User daily | `user:{user_id}:{YYYY-MM-DD}` | `user:987654321:2024-01-15` |
| Search batch | `search:{query_hash}:{YYYY-MM-DD}` | `search:abc123:2024-01-15` |

## Lessons Learned

### Implementation Notes (2024-02-03)

**bird CLI JSON Output:**
- bird outputs JSON array directly (not wrapped in an object)
- Warnings go to stderr, JSON to stdout — need to extract JSON with regex
- Date format is Twitter's quirky format: "Mon Feb 02 12:00:00 +0000 2026"
- Safari cookie access requires special permissions and often fails — Chrome/Firefox more reliable

**TypeScript SDK Compatibility:**
- Don't use full library types (`Pool` from pg, `NatsConnection` from nats)
- Use minimal interfaces that match `DbLike` and `NatsLike` from module-sdk
- The SDK's db.query returns `Promise<unknown>`, need explicit type assertions

**FeedEater Patterns:**
- Follow Slack module structure exactly — it's the reference implementation
- Settings come as strings from internal API — parse JSON fields manually
- Use discriminated unions for feed source types (Zod's `z.discriminatedUnion`)
- Sequential feed fetching with delays — never parallel requests

**bird CLI Specifics:**
- Path: `/opt/homebrew/bin/bird` (Homebrew on Apple Silicon)
- Cookie source format: `--chrome-profile "Profile Name"` or `--firefox-profile profile-name`
- Home timeline variants: default (For You) or `--following` (chronological)
- Always use `-n` to limit tweets — never use `--all`

### Cookie Extraction

- Chrome profile names can have spaces ("Profile 1", not "Profile1")
- Firefox uses "default-release" not "default" usually
- macOS Keychain prompts for cookie access — set `--cookie-timeout` appropriately
- If extraction fails, manual cookie entry works but cookies may expire

### GraphQL Quirks

- `conversation_id` links replies to parent tweets
- Retweets have `retweetedTweet` with the original
- Quote tweets have `quotedTweet` embedded
- Some tweets have `tombstone` if deleted/unavailable

### Context Summarization

- Tweets are SHORT — you can fit many in a context window
- Thread order matters — sort by ID (chronological)
- Quote tweets add important context about discourse
- Retweet counts indicate virality/importance

### Embedding Strategy

- Tweet text is often too short for good embeddings alone
- Concatenate: author name + text + quoted text (if any)
- Consider including hashtags for topic clustering

## Testing Locally

1. Ensure bird CLI is installed: `bird --version`
2. Test cookie extraction: `bird whoami`
3. Test feed access: `bird home --json -n 5`
4. Set up FeedEater's docker-compose environment
5. Configure X settings in the UI
6. Trigger manual `collect` job
7. Check logs panel for errors
8. Verify tweets appear in the feed

## Future Improvements

- [x] Support multiple feed sources per instance (home + lists) — DONE via feedSources JSON array
- [ ] Automatic cookie refresh detection and re-extraction
- [ ] Engagement threshold filtering (min likes/retweets)
- [ ] Topic/keyword filtering before storage
- [ ] Thread expansion (fetch full thread when interesting)
- [ ] Spaces/audio content detection
- [ ] Sentiment analysis for context summaries
- [ ] User timeline support (`bird user-tweets <handle>`)
- [ ] Search support (`bird search <query>`)
- [ ] Bookmarks support (`bird bookmarks`)
