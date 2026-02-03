/**
 * Signal Module - Runtime Job Handlers
 *
 * Handles scheduled jobs for the Signal module:
 * - collect: Receive new messages from signal-cli daemon
 * - sessionCheck: Verify session health
 * - updateContexts: Generate AI summaries for conversations
 */

import type { ModuleRuntime } from "@feedeater/module-sdk";

import { SignalIngestor, parseSignalSettingsFromInternal } from "./ingest.js";

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
    moduleName: "signal",
    handlers: {
      mod_signal: {
        /**
         * Collect job - receive new messages from signal-cli daemon
         */
        async collect({ ctx }) {
          const raw = await ctx.fetchInternalSettings("signal");
          
          // Check if phone number is configured
          if (!raw.phoneNumber) {
            return {
              metrics: {
                status: "skipped",
                reason: "phoneNumber not configured",
              },
            };
          }

          const settings = parseSignalSettingsFromInternal(raw);

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemContextSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";

          const ingestor = new SignalIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            contextTopK: sys.contextTopK,
            embedDim: sys.embedDim,
          });

          await ingestor.ensureSchema();
          const result = await ingestor.collectAndPersist();

          return {
            metrics: {
              messages_received: result.messagesReceived,
              messages_stored: result.messagesStored,
              reactions_received: result.reactionsReceived,
            },
          };
        },

        /**
         * Session check job - verify signal-cli daemon and session health
         */
        async sessionCheck({ ctx }) {
          const raw = await ctx.fetchInternalSettings("signal");
          
          if (!raw.phoneNumber) {
            return {
              metrics: {
                status: "skipped",
                reason: "phoneNumber not configured",
              },
            };
          }

          const settings = parseSignalSettingsFromInternal(raw);

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemContextSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";

          const ingestor = new SignalIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            contextTopK: sys.contextTopK,
            embedDim: sys.embedDim,
          });

          await ingestor.ensureSchema();
          const result = await ingestor.checkSessionHealth();

          return {
            metrics: {
              session_alive: result.isAlive,
              linked_device_active: result.linkedDeviceActive,
              ...(result.errorMessage ? { error: result.errorMessage } : {}),
            },
          };
        },

        /**
         * Update contexts job - generate AI summaries for active conversations
         */
        async updateContexts({ ctx }) {
          const raw = await ctx.fetchInternalSettings("signal");
          
          if (!raw.phoneNumber) {
            return {
              metrics: {
                status: "skipped",
                reason: "phoneNumber not configured",
              },
            };
          }

          const settings = parseSignalSettingsFromInternal(raw);

          const sysRaw = await ctx.fetchInternalSettings("system");
          const sys = parseSystemContextSettings(sysRaw);
          const apiBaseUrl = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
          const internalToken = process.env.FEED_INTERNAL_TOKEN ?? "";

          const ingestor = new SignalIngestor(settings, ctx.db, ctx.nats, ctx.sc, {
            apiBaseUrl,
            internalToken,
            contextTopK: sys.contextTopK,
            embedDim: sys.embedDim,
          });

          await ingestor.ensureSchema();
          const result = await ingestor.refreshContexts({
            lookbackHours: settings.lookbackHours,
          });

          return {
            metrics: {
              contexts_updated: result.updated,
              summaries_ai: result.aiSummaries,
              summaries_fallback: result.fallbackSummaries,
              embeddings_inserted: result.embeddingsInserted,
              avg_token_rate: result.avgTokenRate ?? null,
            },
          };
        },
      },
    },
  };
}
