import { z } from "zod";

export const EventResolverSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  minConfidence: z.number().min(0).max(1).default(0.5),
  textSimilarityWeight: z.number().min(0).max(1).default(0.4),
  embeddingSimilarityWeight: z.number().min(0).max(1).default(0.6),
  lookbackHours: z.number().positive().default(24),
});

export type EventResolverSettings = z.infer<typeof EventResolverSettingsSchema>;
