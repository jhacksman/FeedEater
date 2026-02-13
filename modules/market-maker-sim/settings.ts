import { z } from "zod";

export const MarketMakerSimSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["backtest", "paper"]).default("paper"),
  spreadBps: z.number().positive().default(100),
  positionLimitUsd: z.number().positive().default(10000),
  inventorySkewFactor: z.number().min(0).max(1).default(0.5),
  includeKalshi: z.boolean().default(true),
  includePolymarket: z.boolean().default(true),
  backtestStartTime: z.string().default(""),
  backtestEndTime: z.string().default(""),
  backtestSpeedMultiplier: z.number().positive().default(100),
  initialCapitalUsd: z.number().positive().default(100000),
  riskFreeRate: z.number().min(0).max(1).default(0.05),
});

export type MarketMakerSimSettings = z.infer<typeof MarketMakerSimSettingsSchema>;
