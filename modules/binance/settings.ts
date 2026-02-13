import { z } from "zod";

export const BinanceSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  apiUrl: z.string().default("wss://stream.binance.us:9443/ws"),
  restApiUrl: z.string().default("https://api.binance.us/api/v3"),
  whaleThreshold: z.number().positive().default(50000),
  watchedPairs: z.string().default('["BTCUSDT", "ETHUSDT", "SOLUSDT"]'),
  orderbookEnabled: z.boolean().default(true),
  candleIntervalSeconds: z.number().positive().default(60),
  contextPrompt: z.string().default(
    "You are summarizing CEX trading activity on Binance. Summarize ONLY the market data provided. Include price, volume, whale activity, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided trading data in plain text. 1-3 short sentences about price and volume. Do not return JSON."
  ),
});

export type BinanceSettings = z.infer<typeof BinanceSettingsSchema>;
