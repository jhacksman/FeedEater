import { z } from "zod";

export const BitstampSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  apiUrl: z.string().default("wss://ws.bitstamp.net"),
  restApiUrl: z.string().default("https://www.bitstamp.net/api/v2"),
  whaleThreshold: z.number().positive().default(50000),
  watchedPairs: z.string().default('["btcusd", "ethusd", "solusd"]'),
  orderbookEnabled: z.boolean().default(true),
  candleIntervalSeconds: z.number().positive().default(60),
  contextPrompt: z.string().default(
    "You are summarizing CEX trading activity on Bitstamp. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON."
  ),
});

export type BitstampSettings = z.infer<typeof BitstampSettingsSchema>;
