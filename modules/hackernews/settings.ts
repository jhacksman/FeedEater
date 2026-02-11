import { z } from "zod";

export const HackerNewsSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  feedTypes: z
    .string()
    .default("top,best,new,ask,show")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  maxStoriesPerFeed: z.number().positive().default(30),
  lookbackHours: z.number().positive().default(24),
  includeComments: z.boolean().default(false),
  maxCommentsPerStory: z.number().positive().default(5),
  requestTimeoutSeconds: z.number().positive().default(15),
  contextPrompt: z.string().default(
    "You are summarizing Hacker News stories and discussions. Summarize ONLY the content provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided Hacker News content in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions."
  ),
});

export type HackerNewsSettings = z.infer<typeof HackerNewsSettingsSchema>;
