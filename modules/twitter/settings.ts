import { z } from "zod";

/**
 * Feed source configuration for Twitter collection.
 * - home: Home timeline (following feed - requires auth)
 * - list: Twitter list timeline (requires listId)
 * - user: A specific user's tweets (by username)
 * - search: Search results (requires query)
 */
export const FeedSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("home"),
  }),
  z.object({
    type: z.literal("list"),
    listId: z.string().min(1),
    name: z.string().optional(),
  }),
  z.object({
    type: z.literal("user"),
    username: z.string().min(1),
  }),
  z.object({
    type: z.literal("search"),
    query: z.string().min(1),
  }),
]);

export type FeedSource = z.infer<typeof FeedSourceSchema>;

/**
 * Authentication mode for Twitter/X access.
 * - guest: No login required, limited access (user timelines, tweet details)
 * - user: Full access with username/password login
 */
export const AuthModeSchema = z.enum(["guest", "user"]);

export type AuthMode = z.infer<typeof AuthModeSchema>;

export const TwitterSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  authMode: z.string().default("guest"),
  apiKey: z.string().default(""),
  feedSources: z.string().default('[{"type":"user","username":"elonmusk"}]'),
  tweetsPerRequest: z.number().positive().default(20),
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
