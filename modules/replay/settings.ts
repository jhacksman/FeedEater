import { z } from "zod";

export const ReplaySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  replaySpeed: z.number().positive().default(10),
  startTime: z.string().default(""),
  endTime: z.string().default(""),
  includeKalshi: z.boolean().default(true),
  includePolymarket: z.boolean().default(true),
  replayChannelPrefix: z.string().default("replay"),
});

export type ReplaySettings = z.infer<typeof ReplaySettingsSchema>;
