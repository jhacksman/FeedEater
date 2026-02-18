import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { connect, StringCodec } from "nats";
import { prisma } from "@feedeater/db";
import { getModuleSettings, getModuleSettingsInternal, putModuleSetting } from "./settings.js";
import { getAiTags, postAiEmbedding, postAiSummary } from "./ai.js";
import { getContextMessages, getContextsHistory, getContextsStream } from "./contexts.js";
import { discoverModules } from "./modules.js";
import { getSlackChannels } from "./slackChannels.js";
import { getLogsStream } from "./logsStream.js";
import { getJobsStatus, postRunJob } from "./jobs.js";
import { getBusHistory } from "./busHistory.js";
import { registerPredictionDataRoutes } from "./predictionData.js";
import { registerCexDataRoutes } from "./cexData.js";
import { ModuleHealthStore, getModuleHealth } from "./moduleHealth.js";
import { getDashboard } from "./dashboard.js";
import { getHistory } from "./history.js";
import { getExport } from "./export.js";
import { postModuleRestart } from "./moduleRestart.js";
import { LiveStatusStore, getStatus } from "./status.js";
import { apiKeyAuth } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { getMetrics } from "./metrics.js";
import { getModuleList } from "./moduleList.js";
import { getStats } from "./stats.js";
import { getStream } from "./stream.js";
import { getHealthCheck } from "./healthCheck.js";
import { postModuleDisable, postModuleEnable } from "./moduleControl.js";
import { postWebhook, listWebhooks, deleteWebhook, deliverWebhooks } from "./webhooks.js";
import type { Webhook } from "./webhooks.js";

const PORT = Number(process.env.PORT ?? "4000");
const MODULES_DIR = process.env.FEED_MODULES_DIR ?? "/app/modules";
const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

requiredEnv("NATS_URL");
requiredEnv("DATABASE_URL");
requiredEnv("FEED_SETTINGS_KEY");
requiredEnv("FEED_INTERNAL_TOKEN");
const natsSc = StringCodec();
const moduleHealthStore = new ModuleHealthStore();
const liveStatusStore = new LiveStatusStore();
const disabledModules = new Set<string>();
const webhooks: Webhook[] = [];
let natsConnPromise: Promise<import("nats").NatsConnection> | null = null;

function getNatsConn() {
  if (!natsConnPromise) natsConnPromise = connect({ servers: NATS_URL });
  return natsConnPromise;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Permit embedding internal UI panels (same-origin iframe).
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  next();
});

app.use(apiKeyAuth);
app.use(rateLimit);

app.get("/", getDashboard);

const serverStartedAt = Date.now();
app.get("/api/health", getHealthCheck({ getNatsConn, moduleHealthStore, startedAt: serverStartedAt }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.yaml");

app.get("/api/docs", (_req: Request, res: Response) => {
  try {
    const yaml = readFileSync(openapiPath, "utf-8");
    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    res.send(yaml);
  } catch (err) {
    res.status(500).json({ error: "Failed to read OpenAPI spec" });
  }
});

app.get("/metrics", getMetrics({ store: liveStatusStore }));
app.get("/api/health/modules", getModuleHealth(moduleHealthStore));
app.get("/api/status", getStatus({ store: liveStatusStore, getNatsConn, prisma }));

app.get("/api/modules", getModuleList({ store: liveStatusStore }));

app.get("/api/modules/discover", async (_req: Request, res: Response) => {
  const modules = await discoverModules(MODULES_DIR);
  res.json({ modules });
});

// Server-Sent Events: live stream of MessageCreated bus events.
app.get("/api/bus/stream", async (req: Request, res: Response) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const keepalive = setInterval(() => {
    res.write(`: keepalive ${Date.now()}\n\n`);
  }, 15000);

  const nc = await getNatsConn();
  const sub = nc.subscribe("feedeater.*.messageCreated");

  let closed = false;
  req.on("close", () => {
    closed = true;
    clearInterval(keepalive);
    try {
      sub.unsubscribe();
    } catch {
      // ignore
    }
  });

  (async () => {
    try {
      for await (const m of sub) {
        if (closed) break;

        let data: unknown = null;
        try {
          data = JSON.parse(natsSc.decode(m.data));
        } catch {
          data = { parseError: true };
        }

        let contextSummaryShort: string | null = null;
        try {
          const msg = (data as any)?.message;
          const ref = msg?.contextRef;
          if (ref?.ownerModule && ref?.sourceKey) {
            const ctx = await prisma.busContext.findUnique({
              where: { ownerModule_sourceKey: { ownerModule: String(ref.ownerModule), sourceKey: String(ref.sourceKey) } },
              select: { summaryShort: true },
            });
            contextSummaryShort = ctx?.summaryShort ?? null;
          }
        } catch {
          // ignore
        }

        const payload = {
          subject: m.subject,
          receivedAt: new Date().toISOString(),
          contextSummaryShort,
          data,
        };

        res.write("event: message\n");
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    } catch {
      // likely client disconnected
    } finally {
      clearInterval(keepalive);
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  })();
});

app.get("/api/stats", getStats);
app.get("/api/stream", getStream({ getNatsConn, sc: natsSc }));
app.get("/api/history", getHistory);
app.get("/api/export", getExport);
app.post("/api/modules/:name/restart", postModuleRestart({ getNatsConn, sc: natsSc }));
app.post("/api/modules/:name/disable", postModuleDisable({ getNatsConn, sc: natsSc, disabledModules }));
app.post("/api/modules/:name/enable", postModuleEnable({ getNatsConn, sc: natsSc, disabledModules }));

app.post("/api/webhooks", postWebhook({ webhooks }));
app.get("/api/webhooks", listWebhooks({ webhooks }));
app.delete("/api/webhooks/:id", deleteWebhook({ webhooks }));

// Historical bus messages (from Postgres archive).
app.get("/api/bus/history", getBusHistory);
app.get("/api/contexts/history", getContextsHistory);
app.get("/api/contexts/messages", getContextMessages);
app.get("/api/contexts/stream", getContextsStream({ getNatsConn, sc: natsSc }));

app.get("/api/settings/:module", getModuleSettings);
app.put("/api/settings/:module/:key", putModuleSetting);
app.get("/api/internal/settings/:module", getModuleSettingsInternal);
app.post("/api/internal/ai/summary", postAiSummary());
app.post("/api/internal/ai/embedding", postAiEmbedding());
app.get("/api/internal/ai/tags", getAiTags());
app.get("/api/modules/slack/channels", getSlackChannels);
app.get("/api/logs/stream", getLogsStream({ getNatsConn, sc: natsSc }));
app.get("/api/jobs/status", getJobsStatus({ modulesDir: MODULES_DIR }));
app.post("/api/jobs/run", postRunJob({ modulesDir: MODULES_DIR, getNatsConn, sc: natsSc }));

// Public Data API (v1)
registerPredictionDataRoutes(app);
registerCexDataRoutes(app);

getNatsConn()
  .then(async (nc) => {
    const sub = nc.subscribe("feedeater.*.messageCreated");
    (async () => {
      for await (const m of sub) {
        const parts = m.subject.split(".");
        const moduleName = parts[1];
        if (moduleName && !disabledModules.has(moduleName)) {
          moduleHealthStore.recordMessage(moduleName);
          liveStatusStore.recordMessage(moduleName);

          let data: unknown = null;
          try {
            data = JSON.parse(natsSc.decode(m.data));
          } catch {
            data = { raw: natsSc.decode(m.data) };
          }
          deliverWebhooks(webhooks, moduleName, data).catch(() => {});
        }
      }
    })();

    const reconnectSub = nc.subscribe("feedeater.*.reconnecting");
    (async () => {
      for await (const m of reconnectSub) {
        const parts = m.subject.split(".");
        const moduleName = parts[1];
        if (moduleName && !disabledModules.has(moduleName)) liveStatusStore.recordReconnect(moduleName);
      }
    })();
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[api] module-health NATS subscription failed:", err);
  });

app.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${PORT}`);
});


