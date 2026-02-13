import { z } from "zod";

export const AromerSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  minConfidence: z.number().min(0).max(1).default(0.6),
  venueWeights: z.string().default("{}"),
  positionSizeUsd: z.number().min(0).default(1000),
  maxPositionSizeUsd: z.number().min(0).default(5000),
  maxConcurrentPositions: z.number().min(1).default(10),
  maxDailyLossUsd: z.number().min(0).default(5000),
  signalThresholdPct: z.number().min(0).default(0.5),
  signalDecayMs: z.number().min(0).default(60000),
  slippageBps: z.number().min(0).default(10),
  feesBps: z.number().min(0).default(25),
  latencyMs: z.number().min(0).default(200),
  initialCapitalUsd: z.number().min(0).default(100000),
  riskFreeRate: z.number().min(0).max(1).default(0.05),
});

export type AromerSettings = z.infer<typeof AromerSettingsSchema>;
