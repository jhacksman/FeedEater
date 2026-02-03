import { z } from "zod";

export const MastodonSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  instanceUrl: z.string().min(1).url(),
  accessToken: z.string().min(1),
  timelineType: z.enum(["home", "local", "public"]).default("home"),
  lookbackHours: z.number().positive().default(24),
  includeBoosts: z.boolean().default(true),
  includeReplies: z.boolean().default(true),
  excludeSensitive: z.boolean().default(false),
  contextPrompt: z.string().default(
    "You are summarizing the provided Mastodon toots. Summarize ONLY the toots provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided toots in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions."
  ),
  nonThreadContextTemplate: z.string().default("Toot from @{author}"),
});

export type MastodonSettings = z.infer<typeof MastodonSettingsSchema>;
