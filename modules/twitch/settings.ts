import { z } from "zod";

export const TwitchSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  userAccessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  userId: z.string().min(1),
  collectVods: z.boolean().default(true),
  collectClips: z.boolean().default(true),
  lookbackHours: z.number().positive().default(168), // 1 week
  contextPrompt: z.string().default(
    "You are summarizing Twitch content. Summarize ONLY the provided stream/video/clip information. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided Twitch content in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions."
  ),
});

export type TwitchSettings = z.infer<typeof TwitchSettingsSchema>;
