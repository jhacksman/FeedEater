import type { ModuleRuntime } from "@feedeater/module-sdk";
import { createPolygonDexListener } from "./polygon-dex.js";
import type { PolygonDexCollector } from "./polygon-dex.js";

let started = false;
let collector: PolygonDexCollector | null = null;

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "polygon-dex",
    handlers: {
      mod_polygon_dex: {
        async listen({ ctx }: { ctx: { nats: unknown; sc: unknown; getSetting: unknown; logger?: { info?: (msg: string, meta?: unknown) => void; warn?: (msg: string, meta?: unknown) => void; error?: (msg: string, meta?: unknown) => void } } }) {
          if (!started) {
            started = true;
            try {
              collector = await createPolygonDexListener({
                nats: ctx.nats as Parameters<typeof createPolygonDexListener>[0]["nats"],
                sc: ctx.sc as Parameters<typeof createPolygonDexListener>[0]["sc"],
                getSetting: ctx.getSetting as Parameters<typeof createPolygonDexListener>[0]["getSetting"],
                logger: ctx.logger,
              });
              const stats = collector.getStats();
              ctx.logger?.info?.("polygon-dex collector started", {
                metrics: {
                  swap_count: stats.swapCount,
                  pool_count: stats.poolCount,
                  token_count: stats.tokenCount,
                },
              });
            } catch (err) {
              ctx.logger?.error?.("polygon-dex listener crashed", { err });
              started = false;
              collector = null;
            }
          } else if (collector) {
            const stats = collector.getStats();
            ctx.logger?.info?.("polygon-dex collector already running", {
              metrics: {
                swap_count: stats.swapCount,
                pool_count: stats.poolCount,
                token_count: stats.tokenCount,
              },
            });
          }
        },
      },
    },
  };
}
