import { z } from "zod";

export const BlueskySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  identifier: z.string().min(1),
  appPassword: z.string().min(1),
  serviceUrl: z.string().url().default("https://bsky.social"),
  lookbackHours: z.number().positive().default(24),
  contextPrompt: z.string().default(
    "You are summarizing the provided Bluesky posts/thread. Summarize ONLY the posts provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided posts in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions."
  ),
  nonThreadContextTemplate: z.string().default("Post by {author}"),
});

export type BlueskySettings = z.infer<typeof BlueskySettingsSchema>;
