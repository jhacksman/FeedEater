import type { ModuleRuntime } from "@feedeater/module-sdk";

import { SlackIngestor, parseSlackSettingsFromInternal } from "./ingest.js";

export function createModuleRuntime(): ModuleRuntime {
  return {
    moduleName: "slack",
    handlers: {
      "mod:slack": {
        async collect({ ctx }) {
          const raw = await ctx.fetchInternalSettings("slack");
          const settings = parseSlackSettingsFromInternal(raw);
          if (!settings.enabled) return;

          const ingestor = new SlackIngestor(settings, ctx.db, ctx.nats, ctx.sc);
          await ingestor.ensureSchema();
          await ingestor.collectAndPersist();
        },
      },
    },
  };
}


