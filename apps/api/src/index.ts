import express from "express";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { connect, StringCodec } from "nats";

import { createBullBoardRouter } from "./bullboard.js";
import { getModuleSettings, getModuleSettingsInternal, putModuleSetting } from "./settings.js";
import { discoverModules } from "./modules.js";
import { getSlackChannels } from "./slackChannels.js";
import { getLogsStream } from "./logsStream.js";
import { postRunJob } from "./jobs.js";
import { getBusHistory } from "./busHistory.js";

const PORT = Number(process.env.PORT ?? "4000");
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
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

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const natsSc = StringCodec();
let natsConnPromise: Promise<import("nats").NatsConnection> | null = null;

function getNatsConn() {
  if (!natsConnPromise) natsConnPromise = connect({ servers: NATS_URL });
  return natsConnPromise;
}

async function createBullBoardQueues() {
  const modules = await discoverModules(MODULES_DIR);
  const names = new Set<string>();
  for (const m of modules) for (const q of m.queues ?? []) names.add(q);
  if (names.size === 0) names.add("mod_example");
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

// Server-Sent Events: live stream of MessageCreated bus events.
app.get("/api/bus/stream", async (req, res) => {
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

        const payload = {
          subject: m.subject,
          receivedAt: new Date().toISOString(),
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

// Historical bus messages (from Postgres archive).
app.get("/api/bus/history", getBusHistory);

app.get("/api/settings/:module", getModuleSettings);
app.put("/api/settings/:module/:key", putModuleSetting);
app.get("/api/internal/settings/:module", getModuleSettingsInternal);
app.get("/api/modules/slack/channels", getSlackChannels);
app.get("/api/logs/stream", getLogsStream({ getNatsConn, sc: natsSc }));
app.post("/api/jobs/run", postRunJob({ modulesDir: MODULES_DIR, redis }));

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


