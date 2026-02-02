# FeedEater - Ad-block and spam filtering for the post-human internet

Feedeater's name is quite literal: it's a tool for injesting the sprawl of news, social media, alerts, and chat feeds we're all stuck sorting through every day. It processes them with locally-hosted AI to summarize and filter the crap while permitting the freshest, tastiest, healthiest nuggets to pass through and grace your grey matter in a single combined dashboard. 

It's kinda like a helper-🤖, written by a coder-🤖, to fight the spam-🤖s and their all-mighty algorythm-🤖 overloads. Clearly this is the best timeline. 

Feedeater is Open-Source (GNU licenced) and designed to run off a locally-hosted AI box like a DJX Spark or a Strix Halo. It hosts it's web interface on port 666 because hurr funny number. 

# Why FeedEater? 
For most of human history the biggest challenge we faced was getting enough food. We wired ourselves to consume all the greese, salt, carbs, and sugar we could cram into our mouths so we had something to survive on during the hard times. 

Then, in an evolutionary blink of the eye the hard times ended. Developed nations didn't just have enough food, we had too much food. Suddenly the biggest killer and threat to our wellbeing wasn't starving, it was obesity, diabetes, and heart problems... suddenly success wasn't eating enough, it was eating right. 

It took us years of experimenting with scientific reserch, fad diets, public education campaigns, regulation, and finally GLP-1 drugs to functionally patch our brain's wiring for the new era.

Our natural curiosity and need for knowledge and closeness is in many ways just like hunger. Knowledge and social closeness increases our evolutionary advantage and for most of human history we were starving and scratching for every tidbit. 

Then, in an evolutionary blink of the eye the whole game changed. Suddenly the Internet allowed us to hook a firehose of all humanitites knowledge and every banial thought and infinite volume of empty mental junkfood directly up to our eyeballs 24/7/365. Suddenly becoming wise, informed, and healthy means consuming the right information. 

Since Facebook, Twitter, Bluesky, Mastadon, RSS feeds, Slack, Discord, IRC, SMS, Signal, Telegram, WeChat, Email.... all of them, seem intent on blasting your eyeballs with infinite volumes of ever-enshittifying garbage, FeedEater exists to be your filter. You can eat your metaphorical information-burger  

## Why do you need FeedEater?
**fights for the user**: You tell FeedEater what you care about and FeedEater monitors your socials for that. Full stop. No advertisers tipping the scale to sell you shit, no data scientists optimizing feeds for addiction, no evil recomendation algorythm, no enshitification, no phones being blown up at 2am when you friends start trading memes (unless FeedEater knows you'd want in).

**Only watches**: FeedEater isn't your garden-variaty social media bot. It will never spam or bother your friends, impersonate minorities, humiliate you, or otherwise contribute to the Dead-Internet problems it exists to solve. 

**Own your data**: It is designed to run entirely on self-hosted equipment. All data it collects never leaves your direct ownership and soverenty. Everything you feed FeedEater is still yours!

# Architecture

FeedEater is a modular pipeline:

- **Ingest**: modules collect source data and publish normalized messages.
- **Bus**: NATS JetStream carries `MessageCreated`, `ContextUpdated`, and job events.
- **Archive**: the worker writes messages/tags/contexts to Postgres (pgvector enabled).
- **Summaries**: contexts store short/long summaries and embeddings (messages remain immutable).
- **UI**: dashboards show live bus feed, contexts, jobs, and module cards.

## What's new

- **Contexts dashboard**: live feed of evolving context summaries with message drill-down.
- **Module-owned prompts**: modules assemble LLM prompts and parse responses; the system only runs models.
- **Slack link rendering**: Slack’s `<url|label>` format is normalized and rendered as clickable links in FeedEater.
- **Jobs panel grouping**: jobs are grouped by module for easier scanning.

## 🤝 Contributing

Yes please! 

**🤖 responsibly,  my friends**