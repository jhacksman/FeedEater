import { z } from "zod";

export const UniswapSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  rpcUrl: z.string().default("ws://localhost:8546"),
  whaleThreshold: z.number().positive().default(50000),
  watchedPairs: z
    .array(z.string())
    .default([
      "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", // WETH/USDC V3 0.05%
      "0x11b815efB8f581194ae5486326430326078dF15A", // WETH/USDT V3 0.05%
      "0xCBCdF9626bC03E24f779434178A73a0B4bad62eD", // WBTC/WETH V3 0.3%
    ]),
  filterMode: z
    .enum(["all", "weth_only", "stablecoin_only", "top_pools", "custom"])
    .default("all"),
  customTokenFilter: z
    .array(z.string())
    .default([]),
  topPoolCount: z.number().positive().default(50),
});
export type UniswapSettings = z.infer<typeof UniswapSettingsSchema>;
