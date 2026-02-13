import type { ModuleRuntime } from "@feedeater/module-sdk";
import { createPolygonDexListener } from "./polygon-dex.js";

let started = false;

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "polygon-dex",
    handlers: {
      mod_polygon_dex: {
        async listen({ ctx }: { ctx: any }) {
          if (!started) {
            started = true;
            createPolygonDexListener({
              nats: ctx.nats as any,
              sc: ctx.sc as any,
              getSetting: ctx.getSetting as any,
              logger: ctx.logger,
            }).catch((err) => {
              ctx.logger?.error?.({ err }, "polygon-dex listener crashed");
              started = false;
            });
          }
        },
      },
    },
  };
}
