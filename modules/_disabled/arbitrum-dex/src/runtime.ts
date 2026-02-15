import type { ModuleRuntime } from "@feedeater/module-sdk";
import { ArbitrumDexIngestor, parseArbitrumDexSettingsFromInternal } from "./ingest.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "arbitrum-dex",
    handlers: {
      mod_arbitrum_dex: {
        async stream({ ctx }) {
          const raw = await ctx.fetchInternalSettings("arbitrum-dex");
          const settings = parseArbitrumDexSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new ArbitrumDexIngestor(settings, ctx.db, ctx.nats, ctx.sc);
          await ingestor.ensureSchema();
          const result = await ingestor.startStreaming();

          return {
            metrics: {
              trades_collected: result.tradesCollected,
              gmx_events_collected: result.gmxEventsCollected,
              messages_published: result.messagesPublished,
            },
          };
        },

        async collectSwaps({ ctx }) {
          const raw = await ctx.fetchInternalSettings("arbitrum-dex");
          const settings = parseArbitrumDexSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new ArbitrumDexIngestor(settings, ctx.db, ctx.nats, ctx.sc);
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
