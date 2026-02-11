import type { ModuleRuntime } from "@feedeater/module-sdk";

import { PolymarketIngestor, parsePolymarketSettingsFromInternal } from "./ingest.js";

function parseSystemContextSettings(raw: Record<string, unknown>) {
  const contextTopK = raw.context_top_k ? Number(raw.context_top_k) : 20;
  const embedDim = raw.ollama_embed_dim ? Number(raw.ollama_embed_dim) : 4096;
  return {
    contextTopK: Number.isFinite(contextTopK) && contextTopK > 0 ? contextTopK : 20,
    embedDim: Number.isFinite(embedDim) && embedDim > 0 ? embedDim : 4096,
  };
}

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

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemContextSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";
          const ingestor = new PolymarketIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            contextTopK: sys.contextTopK,
            embedDim: sys.embedDim,
          });

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

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemContextSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";
          const ingestor = new PolymarketIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            contextTopK: sys.contextTopK,
            embedDim: sys.embedDim,
          });

          await ingestor.ensureSchema();
          const result = await ingestor.refreshContexts({ lookbackHours: settings.lookbackHours });

          return {
            metrics: {
              contexts_updated: result.updated,
              contexts_ai: result.aiSummaries,
              contexts_fallback: result.fallbackSummaries,
              embeddings_inserted: result.embeddingsInserted,
              avg_token_rate: result.avgTokenRate ?? null,
            },
          };
        },
      },
    },
  };
}
