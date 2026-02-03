import type { ModuleRuntime } from "@feedeater/module-sdk";

import { RSSIngestor, parseRSSSettingsFromInternal } from "./ingest.js";

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
    moduleName: "rss",
    handlers: {
      mod_rss: {
        /**
         * Poll RSS/Atom feeds that are due for checking
         */
        async poll({ ctx }) {
          const raw = await ctx.fetchInternalSettings("rss");
          const settings = parseRSSSettingsFromInternal(raw);
          if (!settings.enabled) return;

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemContextSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";

          const ingestor = new RSSIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            contextTopK: sys.contextTopK,
            embedDim: sys.embedDim,
          });

          await ingestor.ensureSchema();
          const result = await ingestor.pollFeeds();

          return {
            metrics: {
              feeds_polled: result.feedsPolled,
              entries_inserted: result.entriesInserted,
              feeds_unchanged: result.feedsUnchanged,
              feeds_errored: result.feedsErrored,
            },
          };
        },

        /**
         * Refresh AI context summaries for feeds with recent entries
         */
        async updateContexts({ ctx }) {
          const raw = await ctx.fetchInternalSettings("rss");
          const settings = parseRSSSettingsFromInternal(raw);
          if (!settings.enabled) return;

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemContextSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";

          const ingestor = new RSSIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            contextTopK: sys.contextTopK,
            embedDim: sys.embedDim,
          });

          await ingestor.ensureSchema();
          const result = await ingestor.refreshContexts({ lookbackDays: 7 });

          return {
            metrics: {
              contexts_updated: result.updated,
              ai_summaries: result.aiSummaries,
              embeddings_inserted: result.embeddingsInserted,
            },
          };
        },

        /**
         * Remove old entries past retention period
         */
        async cleanup({ ctx }) {
          const raw = await ctx.fetchInternalSettings("rss");
          const settings = parseRSSSettingsFromInternal(raw);
          if (!settings.enabled) return;

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemContextSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";

          const ingestor = new RSSIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            contextTopK: sys.contextTopK,
            embedDim: sys.embedDim,
          });

          await ingestor.ensureSchema();
          const result = await ingestor.cleanup();

          return {
            metrics: {
              entries_deleted: result.entriesDeleted,
              embeddings_deleted: result.embeddingsDeleted,
            },
          };
        },
      },
    },
  };
}
