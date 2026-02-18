import { z } from "zod";

export const AerodromeBaseSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  rpcUrl: z.string().default("ws://192.168.0.134:8646"),
  whaleThreshold: z.number().positive().default(50000),
  watchedPools: z
    .array(z.string())
    .default([
      "0xcDAC0d6c6C59727a65F871236188350531885C43", // WETH/USDC volatile
      "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d", // USDC/USDbC stable
      "0x44Ecc644449fC3a9858d2007CaA8CFAa4C561f91", // WETH/cbETH
    ]),
});

export type AerodromeBaseSettings = z.infer<typeof AerodromeBaseSettingsSchema>;
