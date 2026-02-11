import { z } from "zod";

export const GitHubSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  accessToken: z.string().min(1),
  username: z.string().min(1),
  watchedRepos: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    ),
  collectNotifications: z.boolean().default(true),
  collectEvents: z.boolean().default(true),
  collectReleases: z.boolean().default(true),
  lookbackHours: z.number().positive().default(24),
  maxEventsPerPoll: z.number().positive().default(100),
  requestTimeoutSeconds: z.number().positive().default(15),
  contextPrompt: z.string().default(
    "You are summarizing GitHub activity (notifications, events, releases). Summarize ONLY the content provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided GitHub activity in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions."
  ),
});

export type GitHubSettings = z.infer<typeof GitHubSettingsSchema>;
