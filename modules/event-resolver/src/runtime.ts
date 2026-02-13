import type { ModuleRuntime } from "@feedeater/module-sdk";

import { EventResolver, parseEventResolverSettingsFromInternal } from "./resolver.js";

function parseSystemContextSettings(raw: Record<string, unknown>) {
  const embedDim = raw.ollama_embed_dim ? Number(raw.ollama_embed_dim) : 4096;
  return {
    embedDim: Number.isFinite(embedDim) && embedDim > 0 ? embedDim : 4096,
  };
}

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "event-resolver",
    handlers: {
      mod_event_resolver: {
        async resolveEvents({ ctx }) {
          const raw = await ctx.fetchInternalSettings("event-resolver");
          const settings = parseEventResolverSettingsFromInternal(raw);
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
          const resolver = new EventResolver(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            embedDim: sys.embedDim,
          });

          await resolver.ensureSchema();
          const result = await resolver.resolveEvents();

          return {
            metrics: {
              kalshi_scanned: result.kalshiScanned,
              polymarket_scanned: result.polymarketScanned,
              mappings_created: result.mappingsCreated,
              mappings_updated: result.mappingsUpdated,
              asset_mappings: result.assetMappings,
            },
          };
        },

        async onMessage({ ctx, job }) {
          const raw = await ctx.fetchInternalSettings("event-resolver");
          const settings = parseEventResolverSettingsFromInternal(raw);
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
          const resolver = new EventResolver(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            embedDim: sys.embedDim,
          });

          await resolver.ensureSchema();

          const data = job.data as { sourceModule?: string; ticker?: string; title?: string } | undefined;
          if (!data?.sourceModule || !data?.ticker || !data?.title) {
            return {
              metrics: { skipped: true, reason: "missing message data" },
            };
          }

          const result = await resolver.resolveForMessage({
            sourceModule: data.sourceModule,
            ticker: data.ticker,
            title: data.title,
          });

          return {
            metrics: {
              mappings_created: result.mappingsCreated,
              mappings_updated: result.mappingsUpdated,
            },
          };
        },

        async queryEquivalents({ ctx, job }) {
          const raw = await ctx.fetchInternalSettings("event-resolver");
          const settings = parseEventResolverSettingsFromInternal(raw);

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemContextSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";
          const resolver = new EventResolver(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            embedDim: sys.embedDim,
          });

          await resolver.ensureSchema();

          const data = job.data as { venue?: string; ticker?: string; asset?: string } | undefined;

          if (data?.asset) {
            const mappings = await resolver.queryByAsset(data.asset);
            return { metrics: { results: mappings.length, query: "byAsset" } };
          }

          if (data?.venue && data?.ticker) {
            const mappings = await resolver.queryEquivalents({
              venue: data.venue,
              ticker: data.ticker,
            });
            return { metrics: { results: mappings.length, query: "byVenueTicker" } };
          }

          const stats = await resolver.getMappingStats();
          return { metrics: stats };
        },
      },
    },
  };
}
