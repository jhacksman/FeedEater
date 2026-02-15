# Event Resolver Module

Cross-venue event resolver for FeedEater. Matches equivalent events across prediction markets (Kalshi and Polymarket) and maps them to underlying assets on CEX/DEX venues.

## What it does

1. **Cross-venue matching**: Detects when Kalshi and Polymarket markets refer to the same real-world event using text similarity + embedding cosine similarity
2. **Asset mapping**: Maps prediction market tickers to underlying spot assets (e.g., KXBTC -> BTC/USD on Coinbase/Binance/Kraken/Uniswap)
3. **Event taxonomy**: Classifies markets into event types (price movement, governance, liquidation, etc.) ported from jhacksman/quant
4. **Query interface**: Given a signal on venue A, find all equivalent markets/assets on other venues

## Schema

Creates `mod_event_resolver.event_mappings` table:

| Column | Type | Description |
|--------|------|-------------|
| id | text PK | Deterministic UUID from venue+ticker pair |
| context_id | text | Optional link to BusContext |
| venue_a | text | Source venue (kalshi, polymarket) |
| ticker_a | text | Source ticker/ID |
| title_a | text | Source market title |
| venue_b | text | Target venue |
| ticker_b | text | Target ticker/ID |
| title_b | text | Target market title |
| underlying_asset | text | Underlying asset symbol (BTC/USD, etc.) |
| confidence | numeric | Match confidence 0-1 |
| method | text | Matching method (text, text+embedding, ticker_map, text_extract) |
| event_type | text | Event classification from taxonomy |

## Jobs

- **resolveEvents** (every 10 min): Full scan of Kalshi and Polymarket markets, builds cross-references
- **onMessage** (event-triggered): When a new message arrives from kalshi/polymarket, checks for cross-venue equivalents
- **queryEquivalents** (manual): Query interface for finding equivalent markets

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| enabled | boolean | false | Enable the resolver |
| minConfidence | number | 0.5 | Minimum confidence for mappings |
| textSimilarityWeight | number | 0.4 | Weight for Jaccard text similarity |
| embeddingSimilarityWeight | number | 0.6 | Weight for embedding cosine similarity |
| lookbackHours | number | 24 | Hours of market history to scan |
