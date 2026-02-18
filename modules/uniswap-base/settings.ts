import { z } from "zod";

export const UniswapBaseSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  rpcUrl: z.string().default("ws://192.168.0.134:8646"),
  whaleThreshold: z.number().positive().default(50000),
  watchedUniswapPools: z
    .array(z.string())
    .default([
      "0xd0b53D9277642d899DF5C87A3966A349A798F224",
      "0x6c561B446416E1A00E8E93E221854d6eA4171372",
    ]),
});
export type UniswapBaseSettings = z.infer<typeof UniswapBaseSettingsSchema>;
