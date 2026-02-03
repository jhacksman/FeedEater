import { z } from "zod";

export const RSSSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  defaultPollIntervalMinutes: z.number().positive().default(30),
  minPollIntervalMinutes: z.number().positive().default(5),
  maxConcurrentPolls: z.number().positive().default(10),
  requestTimeoutSeconds: z.number().positive().default(30),
  userAgent: z.string().default("FeedEater/1.0 (+https://feedeater.app)"),
  useConditionalGet: z.boolean().default(true),
  adaptivePolling: z.boolean().default(false),
  adaptiveMinMinutes: z.number().positive().default(5),
  adaptiveMaxMinutes: z.number().positive().default(1440),
  retentionDays: z.number().positive().default(90),
  maxEntriesPerFeed: z.number().positive().default(1000),
  contextPrompt: z.string().default(
    "You are summarizing recent RSS feed entries. Summarize ONLY the content provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs describing the feed's current focus and themes."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided feed entries in plain text. 1-3 short sentences about the feed's recent content. Do not return JSON. Do not make suggestions or ask questions."
  ),
});

export type RSSSettings = z.infer<typeof RSSSettingsSchema>;
