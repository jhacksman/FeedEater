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
import { getModuleSearch } from "./moduleSearch.js";
import { getModuleSummary } from "./moduleSummary.js";
import { getStats } from "./stats.js";
import { getStream } from "./stream.js";
import { getHealthCheck } from "./healthCheck.js";
import { postModuleDisable, postModuleEnable, getModuleConfig, patchModuleConfig, ModuleConfigDb } from "./moduleControl.js";
import { StalenessTracker, getStaleness } from "./staleness.js";
import { recordReconnect, getModuleReconnectsHandler, getReconnectSummaryHandler } from "./reconnects.js";
import { ApiKeyDb, masterKeyAuth, postApiKey, listApiKeys, deleteApiKey } from "./apiKeys.js";
import { UsageTracker, getKeyUsage } from "./usageTracker.js";
import { setDynamicKeyDb, setUsageTracker } from "./middleware/auth.js";
import { getStatusSummary } from "./statusSummary.js";
import { getAlerts } from "./alerts.js";
import { RateLimitDb, adminKeyAuth, listRateLimits, putRateLimit, deleteRateLimit } from "./rateLimitConfig.js";
import { getDataQuality } from "./dataQuality.js";
import { ModuleLogStore, getModuleLogs } from "./moduleLogs.js";
import { StatusHistoryDb, getModuleStatusHistory } from "./moduleStatusHistory.js";
import { postTestAlert } from "./testAlert.js";
import { getModuleDependencies } from "./moduleDependencies.js";
import { postBulkEnable, postBulkDisable } from "./bulkModuleControl.js";
import { ModuleMetricsStore, getModuleMetrics } from "./moduleMetrics.js";
import { VenueStore, getVenues } from "./venues.js";
import { postRestartAll } from "./restartAll.js";
import { getPipelineStatus } from "./pipelineStatus.js";
import { getModuleRuntimeConfig } from "./moduleRuntimeConfig.js";
import { getSystemInfo } from "./systemInfo.js";
import { getModuleEvents } from "./moduleEvents.js";
import { AcknowledgedAlerts, postAcknowledgeAlert, listAcknowledgedAlerts, deleteAcknowledgedAlert } from "./alertAcknowledge.js";
import { getActiveAlerts } from "./activeAlerts.js";
import { PipelineStatsStore, getModulePipelineStats } from "./pipelineStats.js";
import { getSystemDependencies, makeNatsChecker, makePostgresChecker, makeRedisChecker } from "./systemDependencies.js";
import { AlertHistoryStore, getAlertHistory } from "./alertHistory.js";
import { SystemEventStore, getSystemEvents } from "./systemEvents.js";
import { RuntimeConfig, getSystemConfig, patchSystemConfig } from "./systemConfig.js";
import { postSystemFlush } from "./systemFlush.js";
import { getSystemVersion } from "./systemVersion.js";
import { getModuleHealthCheck } from "./moduleHealthCheck.js";
import { getModuleLatency } from "./moduleLatency.js";
import { getModuleThroughput } from "./moduleThroughput.js";
import { getModuleErrors } from "./moduleErrors.js";
import { ReconnectStatsStore, getModuleReconnectStats } from "./moduleReconnectStats.js";
import { ConnectionStatusStore, getModuleConnectionStatus } from "./moduleConnectionStatus.js";
import { UptimeStore, getModuleUptime } from "./moduleUptime.js";
import { getSystemMetrics } from "./systemMetrics.js";
import { getSystemCapacity } from "./systemCapacity.js";
import { BandwidthStore, getSystemBandwidth } from "./systemBandwidth.js";
import { ModuleDataQualityStore, getModuleDataQuality } from "./moduleDataQuality.js";
import { DataFreshnessStore, getModuleDataFreshness } from "./moduleDataFreshness.js";
import { postModuleReset } from "./moduleReset.js";
import { SubscriptionStore, getModuleSubscriptions } from "./moduleSubscriptions.js";
import { DataQualityHistoryStore, getModuleDataQualityHistory } from "./moduleDataQualityHistory.js";
import { AlertConfigStore, getModuleAlertConfig, patchModuleAlertConfig } from "./moduleAlertConfig.js";
import { SnapshotStore, getModuleSnapshot } from "./moduleSnapshot.js";
import { RawFeedStore, getModuleRawFeed } from "./moduleRawFeed.js";
import { QueueStatsStore, getSystemQueues } from "./systemQueues.js";
import { setRateLimitDb } from "./middleware/rateLimit.js";
import { postWebhook, listWebhooks, deleteWebhook, deliverWebhooks, getDeliveries, WebhookDb, DeliveryLog } from "./webhooks.js";
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
const MODULE_DB_PATH = process.env.MODULE_DB_PATH ?? "feedeater-modules.db";
const moduleConfigDb = new ModuleConfigDb(MODULE_DB_PATH);
const disabledModules = new Set<string>(moduleConfigDb.loadDisabled());
const stalenessTracker = new StalenessTracker();
const API_KEY_DB_PATH = process.env.API_KEY_DB_PATH ?? "feedeater-apikeys.db";
const apiKeyDb = new ApiKeyDb(API_KEY_DB_PATH);
setDynamicKeyDb(apiKeyDb);
const USAGE_DB_PATH = process.env.USAGE_DB_PATH ?? "feedeater-usage.db";
const usageTracker = new UsageTracker(USAGE_DB_PATH);
setUsageTracker(usageTracker);
const RATE_LIMIT_DB_PATH = process.env.RATE_LIMIT_DB_PATH ?? "feedeater-rate-limits.db";
const rateLimitDb = new RateLimitDb(RATE_LIMIT_DB_PATH);
setRateLimitDb(rateLimitDb);
const WEBHOOK_DB_PATH = process.env.WEBHOOK_DB_PATH ?? "feedeater-webhooks.db";
const webhookDb = new WebhookDb(WEBHOOK_DB_PATH);
const webhooks: Webhook[] = webhookDb.loadAll();
const moduleLogStore = new ModuleLogStore();
const statusHistoryDb = new StatusHistoryDb(MODULE_DB_PATH);
const deliveryLog = new DeliveryLog();
const moduleMetricsStore = new ModuleMetricsStore();
const venueStore = new VenueStore();
const reconnectStatsStore = new ReconnectStatsStore();
const connectionStatusStore = new ConnectionStatusStore();
const uptimeStore = new UptimeStore();
const queueStatsStore = new QueueStatsStore();
const bandwidthStore = new BandwidthStore();
const moduleDataQualityStore = new ModuleDataQualityStore();
const subscriptionStore = new SubscriptionStore();
const dataQualityHistoryStore = new DataQualityHistoryStore();
const dataFreshnessStore = new DataFreshnessStore();
const pipelineStatsStore = new PipelineStatsStore();
const alertConfigStore = new AlertConfigStore();
const systemEventStore = new SystemEventStore();
const runtimeConfig = new RuntimeConfig();
const snapshotStore = new SnapshotStore();
const rawFeedStore = new RawFeedStore();
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
app.get("/api/modules/search", getModuleSearch({ store: liveStatusStore }));
app.get("/api/modules/summary", getModuleSummary({ store: liveStatusStore }));

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
app.post("/api/modules/:name/disable", postModuleDisable({ getNatsConn, sc: natsSc, disabledModules, db: moduleConfigDb }));
app.post("/api/modules/:name/enable", postModuleEnable({ getNatsConn, sc: natsSc, disabledModules, db: moduleConfigDb }));
app.get("/api/modules/:name/config", getModuleRuntimeConfig({ disabledModules, loadedAt: new Date(serverStartedAt).toISOString() }));
app.patch("/api/modules/:name/config", adminKeyAuth, patchModuleConfig({ db: moduleConfigDb, getNatsConn, sc: natsSc }));
app.get("/api/modules/:name/logs", getModuleLogs({ logStore: moduleLogStore }));
app.get("/api/modules/:name/status/history", getModuleStatusHistory({ historyDb: statusHistoryDb }));
app.post("/api/modules/:name/test-alert", adminKeyAuth, postTestAlert({ webhooks }));
app.get("/api/modules/:name/dependencies", getModuleDependencies({ modulesDir: MODULES_DIR }));
app.post("/api/modules/bulk-enable", postBulkEnable({ getNatsConn, sc: natsSc, disabledModules, db: moduleConfigDb }));
app.post("/api/modules/bulk-disable", postBulkDisable({ getNatsConn, sc: natsSc, disabledModules, db: moduleConfigDb }));
app.get("/api/modules/:name/metrics", getModuleMetrics({ metricsStore: moduleMetricsStore }));
app.get("/api/modules/:name/events", getModuleEvents({ historyDb: statusHistoryDb }));
app.get("/api/modules/:name/health", getModuleHealthCheck({ healthStore: moduleHealthStore, disabledModules, startedAt: serverStartedAt }));
app.get("/api/modules/:name/latency", getModuleLatency({ metricsStore: moduleMetricsStore }));
app.get("/api/modules/:name/throughput", getModuleThroughput({ metricsStore: moduleMetricsStore }));
app.get("/api/modules/:name/errors", getModuleErrors({ logStore: moduleLogStore }));
app.get("/api/modules/:name/uptime", getModuleUptime({ uptimeStore }));
app.get("/api/modules/:name/data-quality", getModuleDataQuality({ qualityStore: moduleDataQualityStore }));
app.get("/api/modules/:name/subscriptions", getModuleSubscriptions({ subscriptionStore }));
app.get("/api/modules/:name/data-quality-history", getModuleDataQualityHistory({ historyStore: dataQualityHistoryStore }));
app.get("/api/modules/:name/data-freshness", getModuleDataFreshness({ freshnessStore: dataFreshnessStore }));
app.get("/api/modules/:name/alert-config", getModuleAlertConfig({ configStore: alertConfigStore }));
app.patch("/api/modules/:name/alert-config", patchModuleAlertConfig({ configStore: alertConfigStore }));
app.get("/api/modules/:name/snapshot", getModuleSnapshot({ snapshotStore }));
app.get("/api/modules/:name/raw-feed", getModuleRawFeed({ rawFeedStore }));
app.post("/api/modules/:name/reset", postModuleReset({ metricsStore: moduleMetricsStore, reconnectStore: reconnectStatsStore }));
app.get("/api/modules/:name/pipeline-stats", getModulePipelineStats({ pipelineStore: pipelineStatsStore }));
app.get("/api/venues", getVenues({ venueStore, disabledModules }));
app.post("/api/modules/restart-all", postRestartAll({ getNatsConn, sc: natsSc, disabledModules }));

const checkPostgres = async (): Promise<boolean> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
};
app.get("/api/pipeline/status", getPipelineStatus({ stalenessTracker, metricsStore: moduleMetricsStore, disabledModules, getNatsConn, checkPostgres }));
app.get("/api/modules/:name/reconnects", getModuleReconnectStats({ store: reconnectStatsStore }));
app.get("/api/modules/:name/connection-status", getModuleConnectionStatus({ connectionStore: connectionStatusStore }));
app.get("/api/reconnects", getReconnectSummaryHandler());
app.get("/api/staleness", getStaleness({ tracker: stalenessTracker }));
app.get("/api/status/summary", getStatusSummary({ stalenessTracker, disabledModules, webhooks, deliveryLog, apiKeyDb, getNatsConn }));
app.get("/api/alerts", getAlerts({ stalenessTracker, disabledModules }));
app.get("/api/data-quality", getDataQuality({ stalenessTracker, disabledModules }));

const ackedAlerts = new AcknowledgedAlerts();
const alertHistoryStore = new AlertHistoryStore();
app.post("/api/alerts/acknowledge", postAcknowledgeAlert({ store: ackedAlerts }));
app.get("/api/alerts/acknowledged", listAcknowledgedAlerts({ store: ackedAlerts }));
app.delete("/api/alerts/acknowledge", deleteAcknowledgedAlert({ store: ackedAlerts }));
app.get("/api/alerts/active", getActiveAlerts({ stalenessTracker, disabledModules, ackedAlerts }));
app.get("/api/alerts/history", getAlertHistory({ store: alertHistoryStore }));
app.get("/api/system/info", getSystemInfo({ startedAt: serverStartedAt }));
app.get("/api/system/metrics", getSystemMetrics({ metricsStore: moduleMetricsStore, reconnectStore: reconnectStatsStore, uptimeStore }));
app.get("/api/system/bandwidth", getSystemBandwidth({ bandwidthStore }));
app.get("/api/system/capacity", getSystemCapacity({ metricsStore: moduleMetricsStore }));
app.get("/api/system/queues", getSystemQueues({ queueStore: queueStatsStore }));
app.get("/api/system/events", getSystemEvents({ eventStore: systemEventStore }));
app.get("/api/system/config", getSystemConfig({ runtimeConfig, natsUrl: NATS_URL, postgresEnabled: !!process.env.DATABASE_URL, apiPort: PORT, version: "1.0.0" }));
app.patch("/api/system/config", patchSystemConfig({ runtimeConfig }));
app.get("/api/system/version", getSystemVersion({ startedAt: serverStartedAt, buildTime: process.env.BUILD_TIME, gitSha: process.env.GIT_SHA }));
app.post("/api/system/flush", postSystemFlush({ metricsStore: moduleMetricsStore, reconnectStore: reconnectStatsStore }));
app.get("/api/system/dependencies", getSystemDependencies({
  checkers: [
    makeNatsChecker(getNatsConn),
    makePostgresChecker(() => prisma.$queryRaw`SELECT 1`),
    makeRedisChecker(),
  ],
}));

const rlDeps = { db: rateLimitDb, defaultLimit: 100 };
app.get("/api/rate-limits", adminKeyAuth, listRateLimits(rlDeps));
app.put("/api/rate-limits/:key", adminKeyAuth, putRateLimit(rlDeps));
app.delete("/api/rate-limits/:key", adminKeyAuth, deleteRateLimit(rlDeps));

app.post("/api/keys", masterKeyAuth, postApiKey({ db: apiKeyDb }));
app.get("/api/keys", masterKeyAuth, listApiKeys({ db: apiKeyDb }));
app.delete("/api/keys/:id", masterKeyAuth, deleteApiKey({ db: apiKeyDb }));
app.get("/api/keys/:id/usage", masterKeyAuth, getKeyUsage({ tracker: usageTracker }));

app.post("/api/webhooks", postWebhook({ webhooks, db: webhookDb }));
app.get("/api/webhooks", listWebhooks({ webhooks }));
app.delete("/api/webhooks/:id", deleteWebhook({ webhooks, db: webhookDb }));
app.get("/api/webhooks/:id/deliveries", getDeliveries({ webhooks, deliveryLog }));

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
          stalenessTracker.updateModuleSeen(moduleName);
          moduleMetricsStore.recordMessage(moduleName);
          venueStore.recordMessage(moduleName);
          moduleLogStore.record(moduleName, "info", `Message received on ${m.subject}`);
          statusHistoryDb.record(moduleName, "started", `Message received on ${m.subject}`);

          let data: unknown = null;
          try {
            data = JSON.parse(natsSc.decode(m.data));
          } catch {
            data = { raw: natsSc.decode(m.data) };
          }
          snapshotStore.record(moduleName, m.subject, data);
          deliverWebhooks(webhooks, moduleName, data, deliveryLog).catch(() => {});
        }
      }
    })();

    const reconnectSub = nc.subscribe("feedeater.*.reconnecting");
    (async () => {
      for await (const m of reconnectSub) {
        const parts = m.subject.split(".");
        const moduleName = parts[1];
        if (moduleName && !disabledModules.has(moduleName)) {
          liveStatusStore.recordReconnect(moduleName);
          recordReconnect(moduleName);
          reconnectStatsStore.record(moduleName);
          moduleLogStore.record(moduleName, "warn", `WebSocket reconnecting for ${moduleName}`);
          statusHistoryDb.record(moduleName, "reconnected", `WebSocket reconnecting for ${moduleName}`);
        }
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
