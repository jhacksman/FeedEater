import type { ModuleRuntime } from "@feedeater/module-sdk";
import { createArbitrumDexListener } from "./arbitrum-dex.js";

let started = false;

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "arbitrum-dex",
    handlers: {
      mod_arbitrum_dex: {
        async listen({ ctx }) {
          if (!started) {
            started = true;
            createArbitrumDexListener({
              nats: ctx.nats as any,
              sc: ctx.sc as any,
              getSetting: ctx.getSetting as any,
              logger: ctx.logger,
            }).catch((err) => {
              ctx.logger?.error?.({ err }, "arbitrum-dex listener crashed");
              started = false;
            });
          }
        },
      },
    },
  };
}
