import { z } from "zod";

export const BitfinexSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  apiUrl: z.string().default("wss://api-pub.bitfinex.com/ws/2"),
  restApiUrl: z.string().default("https://api-pub.bitfinex.com/v2"),
  whaleThreshold: z.number().positive().default(50000),
  watchedPairs: z.string().default('["tBTCUSD", "tETHUSD", "tSOLUSD"]'),
  candleIntervalSeconds: z.number().positive().default(60),
  contextPrompt: z.string().default(
    "You are summarizing CEX trading activity on Bitfinex. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON."
  ),
});

export type BitfinexSettings = z.infer<typeof BitfinexSettingsSchema>;
