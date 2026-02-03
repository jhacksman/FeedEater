import { z } from "zod";

export const RedditSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  userAgent: z.string().min(1),
  feedTypes: z
    .string()
    .default("home")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    ),
  lookbackHours: z.number().positive().default(24),
  postsPerFeed: z.number().positive().default(25),
  minScore: z.number().default(0),
  excludeNSFW: z.boolean().default(true),
  rateLimitDelay: z.number().positive().default(1000),
  contextPrompt: z.string().default(
    "You are summarizing a Reddit post and its top comments. Summarize ONLY the content provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided Reddit content in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions."
  ),
});

export type RedditSettings = z.infer<typeof RedditSettingsSchema>;
