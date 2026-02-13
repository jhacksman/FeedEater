import { z } from "zod";

export const ArbitrumDexSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  rpcUrl: z.string().default("wss://arbitrum-mainnet.infura.io/ws/v3/7792954778014ea7a9d6b88268ef912c"),
  whaleThreshold: z.number().positive().default(50000),
  watchedUniswapPools: z
    .array(z.string())
    .default([
      "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443", // WETH/USDC V3 0.05%
      "0xC6962004f452bE9203591991D15f6b388e09E8D0", // WETH/USDT V3 0.05%
      "0x641C00A822e8b671738d32a431a4Fb6074E5c79d", // WBTC/WETH V3 0.3%
    ]),
  enableGmx: z.boolean().default(true),
});

export type ArbitrumDexSettings = z.infer<typeof ArbitrumDexSettingsSchema>;
