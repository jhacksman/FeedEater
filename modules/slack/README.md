## Slack Module

Collects messages from your Slack workspace and organizes them into Contexts. Threads become their own contexts with AI-generated summaries, making it easy to catch up on conversations without reading every message.

## Quick Start

### Step 1: Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Choose **From scratch**
4. Name your app (e.g., "FeedEater") and select your workspace
5. Click **Create App**

### Step 2: Configure OAuth Scopes

1. In the left sidebar, click **OAuth & Permissions**
2. Scroll down to **Scopes** > **Bot Token Scopes**
3. Add the following scopes:
   - `channels:history` - Read messages from public channels
   - `channels:read` - View basic channel info
   - `groups:history` - Read messages from private channels (optional)
   - `groups:read` - View basic private channel info (optional)
   - `users:read` - View user display names

### Step 3: Install the App to Your Workspace

1. Scroll up to **OAuth Tokens for Your Workspace**
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### Step 4: Get Your Channel IDs

Channel IDs are not the same as channel names. To find a channel ID:

1. Open Slack in your browser or desktop app
2. Right-click on the channel name > **View channel details** (or click the channel name)
3. Scroll to the bottom of the details panel
4. Copy the **Channel ID** (looks like `C01ABC123DE`)

Alternatively, in the Slack web app, the channel ID is in the URL when viewing a channel:
```
https://app.slack.com/client/T00000000/C01ABC123DE
                                       ^^^^^^^^^^^^^ this is the channel ID
```

### Step 5: Invite the Bot to Your Channels

The bot can only read channels it has been invited to. For each channel you want to monitor:

1. Open the channel in Slack
2. Type `/invite @YourBotName` (use the name you gave your app in Step 1)
3. Press Enter

For private channels, you must also add the `groups:history` and `groups:read` scopes (Step 2).

### Step 6: Configure FeedEater

In the FeedEater web UI, go to **Settings** > **Slack** and configure:

| Setting | Value |
|---------|-------|
| **Bot Token** | Your `xoxb-...` token from Step 3 |
| **Channel IDs** | Comma-separated list of channel IDs (e.g., `C01ABC123DE,C02DEF456GH`) |
| **Lookback Hours** | How far back to fetch messages (default: 24) |
| **Include Threads** | Whether to fetch thread replies (default: true) |
| **Exclude Bots** | Whether to skip bot messages (default: true) |

### Step 7: Test It

The Slack collector runs every 5 minutes by default. You can trigger a manual run from the FeedEater UI to test immediately.

Check the **Logs** panel in FeedEater to see collection activity and any errors.

## How It Works

The Slack module runs two scheduled jobs:

**collect** (every 5 minutes): Fetches new messages from your configured channels, stores them in the module's private database, and publishes them to the FeedEater message bus.

**updateContexts** (every 30 minutes): Refreshes AI summaries for active threads. Uses semantic search to find the most relevant messages in each thread, then generates short and long summaries.

## Context Keys

Each Slack thread becomes its own Context with the key format: `{channelId}:{threadTs}`

For example: `C01ABC123DE:1234567890.123456`

Non-threaded messages get a simple context based on the channel name.

## What It Stores

Raw Slack message payloads (plus convenience columns) in:
- `mod_slack.slack_messages` - All collected messages
- `mod_slack.slack_message_embeddings` - Vector embeddings for semantic search

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the module |
| `botToken` | secret | required | Slack bot token (`xoxb-...`) |
| `channelIds` | string | required | Comma-separated channel IDs |
| `lookbackHours` | number | `24` | How far back to fetch messages |
| `includeThreads` | boolean | `true` | Fetch thread replies |
| `excludeBots` | boolean | `true` | Skip bot messages |
| `nonThreadContextTemplate` | string | `"Message in channel {channel}"` | Summary template for non-threaded messages |
| `channelNameMap` | string | `"{}"` | JSON mapping of channel IDs to friendly names |
| `contextPrompt` | string | (see module.json) | System prompt for AI summaries |
| `contextPromptFallback` | string | (see module.json) | Fallback prompt if JSON parsing fails |

## Troubleshooting

**"missing_scope" error**: Your bot token doesn't have the required scopes. Go back to Step 2 and add the missing scope, then reinstall the app.

**"channel_not_found" error**: The channel ID is incorrect, or the bot hasn't been added to the channel. Invite the bot to the channel with `/invite @YourBotName`.

**"not_in_channel" error**: The bot needs to be invited to the channel. Use `/invite @YourBotName` in the channel.

**No messages appearing**: Check that `lookbackHours` is set high enough to capture recent messages. Also verify the channel has activity within that window.

**Thread summaries not updating**: The `updateContexts` job runs every 30 minutes. You can trigger a manual run from the UI, or check the logs for errors.

## For AI Agents

See [CLAUDE.md](./CLAUDE.md) for detailed context on this module's architecture, conventions, and lessons learned.


