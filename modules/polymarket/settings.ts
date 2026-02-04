import { z } from "zod";

export const PolymarketSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  watchedMarkets: z.string().default("[]"),
  watchedCategories: z.string().default("[\"politics\", \"crypto\", \"sports\"]"),
  minVolume: z.number().positive().default(10000),
  collectComments: z.boolean().default(false),
  lookbackHours: z.number().positive().default(24),
  contextPrompt: z.string().default(
    "You are summarizing prediction market activity on Polymarket. Summarize ONLY the market data provided. Include current probabilities, volume, and notable movements. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided market data in plain text. 1-3 short sentences about probability and volume. Do not return JSON."
  ),
});

export type PolymarketSettings = z.infer<typeof PolymarketSettingsSchema>;
