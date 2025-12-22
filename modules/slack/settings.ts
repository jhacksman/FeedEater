import { z } from "zod";

export const SlackSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  botToken: z.string().min(1),
  channelIds: z
    .string()
    .min(1)
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  lookbackHours: z.number().positive().default(24),
  includeThreads: z.boolean().default(true),
  excludeBots: z.boolean().default(true),
});

export type SlackSettings = z.infer<typeof SlackSettingsSchema>;


