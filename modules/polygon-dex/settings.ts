import { z } from "zod";

export const PolygonDexSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  rpcUrl: z.string().default("wss://polygon-mainnet.infura.io/ws/v3/b5ef538a6a4e4b799dad3b097ede45e7"),
  whaleThreshold: z.number().positive().default(50000),
  watchedQuickswapPools: z
    .array(z.string())
    .default([
      "0x45dDa9cb7c25131DF268515131f647d726f50608",
      "0xAE81FAc689A1b4b1e06e7ef4a2ab4CD8aC0A087D",
    ]),
});
export type PolygonDexSettings = z.infer<typeof PolygonDexSettingsSchema>;
