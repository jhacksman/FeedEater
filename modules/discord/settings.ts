import { z } from "zod";

export const DiscordSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  botToken: z.string().min(1),
  guildIds: z
    .string()
    .min(1)
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  channelIds: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [])),
  lookbackHours: z.number().positive().default(24),
  includeThreads: z.boolean().default(true),
  excludeBots: z.boolean().default(true),
  channelNameMap: z.string().default("{}"),
  contextPrompt: z.string().default(
    "You are summarizing the provided Discord messages. Summarize ONLY the messages provided. Do not make suggestions, ask questions, or add commentary. Return strict JSON with keys: summary_short and summary_long. summary_short must be <= 128 characters. summary_long should be 1-3 short paragraphs. Do not return empty strings."
  ),
  contextPromptFallback: z.string().default(
    "Summarize ONLY the provided messages in plain text. 1-3 short sentences. Do not return JSON. Do not make suggestions or ask questions."
  ),
});

export type DiscordSettings = z.infer<typeof DiscordSettingsSchema>;
