import { z } from "zod";

export const ReplaySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  speedMultiplier: z.number().min(1).max(10000).default(100),
  filterModules: z.string().default("[]"),
  batchSize: z.number().min(1).max(10000).default(1000),
});

export type ReplaySettings = z.infer<typeof ReplaySettingsSchema>;
