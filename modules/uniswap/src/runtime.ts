import type { ModuleRuntime } from "@feedeater/module-sdk";
import { createUniswapListener } from "./uniswap.js";

let started = false;

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "uniswap",
    handlers: {
      mod_uniswap: {
        async listen({ ctx }) {
          if (!started) {
            started = true;
            createUniswapListener({
              nats: ctx.nats as any,
              sc: ctx.sc as any,
              getSetting: ctx.getSetting as any,
              logger: ctx.logger,
            }).catch((err) => {
              ctx.logger?.error?.({ err }, "uniswap listener crashed");
              started = false;
            });
          }
        },
      },
    },
  };
}
