import type { ModuleRuntime } from "@feedeater/module-sdk";
import { AerodromeBaseIngestor, parseAerodromeBaseSettingsFromInternal } from "./ingest.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "aerodrome-base",
    handlers: {
      mod_aerodrome_base: {
        async stream({ ctx }) {
          const raw = await ctx.fetchInternalSettings("aerodrome-base");
          const settings = parseAerodromeBaseSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new AerodromeBaseIngestor(settings, ctx.db, ctx.nats, ctx.sc);
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
          const raw = await ctx.fetchInternalSettings("aerodrome-base");
          const settings = parseAerodromeBaseSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new AerodromeBaseIngestor(settings, ctx.db, ctx.nats, ctx.sc);
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
