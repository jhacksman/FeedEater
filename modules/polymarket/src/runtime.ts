import type { ModuleRuntime } from "@feedeater/module-sdk";

import { PolymarketIngestor, parsePolymarketSettingsFromInternal } from "./ingest.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "polymarket",
    handlers: {
      mod_polymarket: {
        async collect({ ctx }) {
          const raw = await ctx.fetchInternalSettings("polymarket");
          const settings = parsePolymarketSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new PolymarketIngestor(settings, ctx.db, ctx.nats, ctx.sc);

          await ingestor.ensureSchema();
          const result = await ingestor.collectAndPersist();

          return {
            metrics: {
              events_updated: result.eventsUpdated,
              markets_updated: result.marketsUpdated,
              messages_published: result.messagesPublished,
            },
          };
        },

        async updateContexts({ ctx }) {
          const raw = await ctx.fetchInternalSettings("polymarket");
          const settings = parsePolymarketSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new PolymarketIngestor(settings, ctx.db, ctx.nats, ctx.sc);

          await ingestor.ensureSchema();
          const result = await ingestor.refreshContexts();

          return {
            metrics: {
              contexts_updated: result.updated,
            },
          };
        },
      },
    },
  };
}
