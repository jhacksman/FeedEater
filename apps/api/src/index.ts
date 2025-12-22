import express from "express";
import { Queue } from "bullmq";
import IORedis from "ioredis";

import { createBullBoardRouter } from "./bullboard.js";
import { getModuleSettings, getModuleSettingsInternal, putModuleSetting } from "./settings.js";
import { discoverModules } from "./modules.js";

const PORT = Number(process.env.PORT ?? "4000");
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const MODULES_DIR = process.env.FEED_MODULES_DIR ?? "/app/modules";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

requiredEnv("NATS_URL");
requiredEnv("DATABASE_URL");
requiredEnv("FEED_SETTINGS_KEY");
requiredEnv("FEED_INTERNAL_TOKEN");

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

async function createBullBoardQueues() {
  const modules = await discoverModules(MODULES_DIR);
  const names = new Set<string>();
  for (const m of modules) for (const q of m.queues ?? []) names.add(q);
  if (names.size === 0) names.add("mod:example");
  return [...names].sort().map((q) => new Queue(q, { connection: redis }));
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Permit embedding BullBoard inside the main UI (same-origin iframe).
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  next();
});

app.get("/api/health", async (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/modules", async (_req, res) => {
  const modules = await discoverModules(MODULES_DIR);
  res.json({ modules });
});

app.get("/api/settings/:module", getModuleSettings);
app.put("/api/settings/:module/:key", putModuleSetting);
app.get("/api/internal/settings/:module", getModuleSettingsInternal);

createBullBoardQueues()
  .then((queues) => {
    app.use("/bullboard", createBullBoardRouter(queues));
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[api] failed to initialize bullboard queues", err);
  });

app.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${PORT}`);
});


