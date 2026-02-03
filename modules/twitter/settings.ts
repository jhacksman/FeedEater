import { z } from "zod";

/**
 * Feed source configuration for Twitter collection.
 * - home: Home timeline (foryou or following variant)
 * - list: Twitter list timeline (requires listId)
 * - mentions: Mentions of the authenticated user
 */
export const FeedSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("home"),
    variant: z.enum(["foryou", "following"]).default("foryou"),
  }),
  z.object({
    type: z.literal("list"),
    listId: z.string().min(1),
    name: z.string().optional(), // human-readable name for display
  }),
  z.object({
    type: z.literal("mentions"),
  }),
]);

export type FeedSource = z.infer<typeof FeedSourceSchema>;

export const TwitterSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  feedSources: z.string().default('[{"type":"home","variant":"foryou"}]'),
  cookieSource: z.string().default(""),
  tweetsPerRequest: z.number().positive().default(50),
  lookbackHours: z.number().positive().default(24),
  requestDelayMs: z.number().nonnegative().default(5000),
  contextPrompt: z.string().default(
    "You are summarizing a Twitter/X thread or conversation. Summarize ONLY the tweets provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs covering the main topic and key points."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided tweets in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions."
  ),
});

export type TwitterSettings = z.infer<typeof TwitterSettingsSchema>;
