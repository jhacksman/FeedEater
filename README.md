# Takeing back the newsfeed

Feedeater's name is literal: it's a backplane and an engine for tools that munch on and digest the modern world's ever-expanding sprawl of newsfeeds, social media apps, notifications, alerts, chats, and reminders that we're all stuck trying to stomach every day.

It's a backplane to unite an ecosystem of lightweight and modular tools that empowers people to assemble their own darn newsfeeds policed and moderated by their own darn algorythms (blackjack and hookers optional).

# Context is King
Rather then rigied and archaic system-specific concepts like "threads" or "topics" or "channels" or "conversations" or "Hashtags", Feedeater's unified data model groups messages by "Contexts". 

**Contexts allow deep knowedge**: FeedEater tracks AI summaries and semantic embeds for messages in a given context. This allows both humans any any sorting/filtering/monitoring processes to understand a given message at a much deeper level.

**Contexts may span platforms**: FeedEater allows the tracking of topics and conversations across platforms by allowing messages and information coming from diffent systems to be related to the same context. 

**Contexts allow deep control**: [future feature] FeedEater allows feed filtering and monitoring (job triggering) based on semantic search. 

# Batteries Included Platform
FeedEater makes it easy to collect, aggriate, process, and filter feeds like news, chats, message, and notifications by providing unified data structures and support services: 

- **Drop-in installs**: FeedEater will automatically import and integrate with any module cloned into its /modules folder (see an [example module](https://github.com/SparksMcGhee/FeedEater/tree/main/modules/example)).
- **Free Orchestration**: Modules may define jobs which FeedEater will invoke either on a schedule, based on message/context subscription rules, or based on button presses in the web interface.  
- **External intergration**: Jobs may make external API calls 
- **Unified Message Bus**: All modules can read and emit messages on a unified, persistant, and realtime message bus.
- **Collabrative understanding**: Modules can collaborate on a shared understanding of those messages by emitting key-value tags on any message (not just theirs)
- **AI all warmed up**: Modules are provided system endpoints for interacting with OLLAMA. No fussing with API keys, networking, sidecar services, pulling stuff from HuggingFace or waiting for models to load. FeedEater will even handle task queueing. 
- **Free Logging**: FeedEater logs and monitors jobs as well as providing a unified realtime debug log accessible from the UI. 
- **Free Settings**: FeedEater handles exposing module settings to the end-user via the web interface as well as securely and persistantly storing settings values.  
- **Free UI**: Modules may expand their settings page by defining their own TypeScript cards for any additional interoperability, as well as defining the card which is displayed when a user clicks on one of it's messages. 
- **Free Persistance**: Modules get their own schema on the Postgres backend to store persistant data. Schema definitions via Prisma. 
- **Free Message Queue**: Modules get their own namespace on FeedEater's NATs message queue. 

# Why FeedEater? 
For most of human history the biggest challenge we faced was getting enough food. Our brains are wired to consume all the greese, salt, carbs, and sugar we could cram into our mouths becuase for most of history the threat of heart diease was laughable compared to the looming monster of starvation.  

Then, in an evolutionary blink of the eye the hard times ended. Developed nations didn't just have enough food, we had too much food. Suddenly the biggest killer and threat to our wellbeing wasn't starving, it was obesity, diabetes, and heart problems... suddenly success wasn't eating enough, it was eating right. 

It took us years of experimenting, medical reserch, fad diets, public education campaigns, and food regulation to get the situation under control. 

Our natural desire for knowledge and closeness is, like hunger, is rooted in the same fear. Knowledge and social closeness increases our evolutionary advantage and for most of human history we were starving and scratching for every tidbit.

Then, in the same evolutionary blink of the eye the whole game changed. Suddenly the Internet allowed us to pump all of humanitites knowledge along with every baniel thought and cat picture directly into our eyeballs 24/7/365. Suddenly becoming wise, informed, and healthy required careful information dieting. 

Since Facebook, Twitter, Tik-Toc, Bluesky, Mastadon, RSS feeds, Slack, Discord, IRC, SMS, Signal, Telegram, WeChat, Email.... appear to have collectively decided that pumping volumes of unhealthy and outright dangerious information into our eyeballs is more prophetable we're going to have to take matters into our own hands. 

## Available Modules

FeedEater ships with a growing library of drop-in modules. Clone or symlink any of these into `/modules` and they will be auto-discovered on startup.

| Module | Description |
|--------|-------------|
| `aerodrome-base` | Aerodrome DEX swap collector for Base L2 (stable/volatile pools) |
| `arbitrum-dex` | DEX swap collector for Arbitrum L2 |
| `binance` | Binance CEX market data |
| `bitstamp` | Bitstamp CEX market data |
| `bitfinex` | Bitfinex CEX market data |
| `bluesky` | Bluesky social feed |
| `bybit` | Bybit CEX market data |
| `coinbase` | Coinbase CEX market data |
| `discord` | Discord message collector |
| `gemini` | Gemini CEX market data |
| `github` | GitHub event collector |
| `hackernews` | Hacker News feed |
| `kalshi` | Kalshi prediction market data |
| `kraken` | Kraken CEX market data |
| `mastodon` | Mastodon/Fediverse feed |
| `okx` | OKX CEX market data |
| `polygon-dex` | DEX swap collector for Polygon |
| `polymarket` | Polymarket prediction market data |
| `reddit` | Reddit feed |
| `rss` | Generic RSS/Atom feed |
| `signal` | Signal messenger |
| `slack` | Slack workspace collector |
| `telegram` | Telegram channel/group collector |
| `twitch` | Twitch stream events |
| `twitter` | Twitter/X feed |
| `uniswap` | Uniswap V3 swap collector (Ethereum mainnet) |
| `uniswap-base` | Uniswap V3 swap collector for Base L2 |
| `youtube` | YouTube feed |

## 🤝 Contributing

Yes please! 

**🤖 responsibly,  my friends**
