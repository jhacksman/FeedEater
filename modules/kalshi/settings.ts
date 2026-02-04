import { z } from "zod";

export const KalshiSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  watchedMarkets: z.string().default("[]"),
  collectTrades: z.boolean().default(true),
  collectOrderbook: z.boolean().default(false),
  lookbackHours: z.number().positive().default(24),
  contextPrompt: z.string().default(
    "You are summarizing prediction market activity. Summarize ONLY the market data provided. Include current prices, volume, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided market data in plain text. 1-3 short sentences about price and volume. Do not return JSON."
  ),
});

export type KalshiSettings = z.infer<typeof KalshiSettingsSchema>;
