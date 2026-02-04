import type { ModuleRuntime } from "@feedeater/module-sdk";

import { KalshiIngestor, parseKalshiSettingsFromInternal } from "./ingest.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "kalshi",
    handlers: {
      mod_kalshi: {
        async collect({ ctx }) {
          const raw = await ctx.fetchInternalSettings("kalshi");
          const settings = parseKalshiSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new KalshiIngestor(settings, ctx.db, ctx.nats, ctx.sc);

          await ingestor.ensureSchema();
          const result = await ingestor.collectAndPersist();

          return {
            metrics: {
              markets_updated: result.marketsUpdated,
              trades_collected: result.tradesCollected,
              messages_published: result.messagesPublished,
            },
          };
        },

        async updateContexts({ ctx }) {
          const raw = await ctx.fetchInternalSettings("kalshi");
          const settings = parseKalshiSettingsFromInternal(raw);
          if (!settings.enabled) {
            return {
              metrics: {
                skipped: true,
                reason: "module disabled",
              },
            };
          }

          const ingestor = new KalshiIngestor(settings, ctx.db, ctx.nats, ctx.sc);

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
