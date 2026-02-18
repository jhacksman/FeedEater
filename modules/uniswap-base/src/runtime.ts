import type { ModuleRuntime } from "@feedeater/module-sdk";
import { UniswapBaseIngestor, parseUniswapBaseSettingsFromInternal } from "./ingest.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "uniswap-base",
    handlers: {
      mod_uniswap_base: {
        async stream({ ctx }) {
          const raw = await ctx.fetchInternalSettings("uniswap-base");
          const settings = parseUniswapBaseSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new UniswapBaseIngestor(settings, ctx.db, ctx.nats, ctx.sc);
          await ingestor.ensureSchema();
          const result = await ingestor.startStreaming();

          return {
            metrics: {
              trades_collected: result.tradesCollected,
              messages_published: result.messagesPublished,
            },
          };
        },

        async collectSwaps({ ctx }) {
          const raw = await ctx.fetchInternalSettings("uniswap-base");
          const settings = parseUniswapBaseSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new UniswapBaseIngestor(settings, ctx.db, ctx.nats, ctx.sc);
          await ingestor.ensureSchema();
          const result = await ingestor.collectRecentSwaps({ lookbackBlocks: 1000 });

          return {
            metrics: {
              trades_collected: result.tradesCollected,
              messages_published: result.messagesPublished,
            },
          };
        },
      },
    },
  };
}
