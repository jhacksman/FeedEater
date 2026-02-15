import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { connect, StringCodec } from "nats";
import { Pool } from "pg";
import {
  ContextUpdatedEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  createSettingsClient,
  subjectFor,
} from "@feedeater/core";
import { discoverModules } from "./modules/discovery.js";
import type { ModuleRuntimeContext, ModuleRuntime } from "@feedeater/module-sdk";
import { loadModuleRuntime } from "./modules/runtime.js";
import { startBusArchiver } from "./bus/archiver.js";

type LogLevel = "debug" | "info" | "warn" | "error";
function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return JSON.stringify({ stringifyError: true });
  }
}

function publishLog(nc: import("nats").NatsConnection, sc: import("nats").StringCodec, level: LogLevel, message: string, meta?: unknown) {
  try {
    nc.publish(
      "feedeater.worker.log",
      sc.encode(
        safeJson({
          level,
          module: "worker",
          source: "process",
          at: new Date().toISOString(),
          message,
          meta,
        })
      )
    );
  } catch {
    // ignore
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const NATS_URL = requiredEnv("NATS_URL");
const MODULES_DIR = process.env.FEED_MODULES_DIR ?? "/app/modules";
const API_BASE_URL = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
const INTERNAL_TOKEN = requiredEnv("FEED_INTERNAL_TOKEN");
const DEFAULT_EMBED_DIM = Number(process.env.OLLAMA_EMBED_DIM ?? "4096");
let currentEmbedDim = DEFAULT_EMBED_DIM;

requiredEnv("DATABASE_URL");
const DATABASE_URL = requiredEnv("DATABASE_URL");

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const sc = StringCodec();
const CONTEXT_SUBJECT_WILDCARD = "feedeater.*.contextUpdated";

type JobTrigger = { type: "schedule" | "manual" | "event"; subject?: string; messageId?: string };

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim();
  return typeof err === "string" ? err : safeJson(err);
}

async function ensureContextStorage(
  db: Pool,
  publish: (level: LogLevel, message: string, meta?: unknown) => void,
  embedDim: number
) {
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (err) {
    publish("warn", "failed to ensure pgvector extension", { err: serializeError(err) });
  }

  if (Number.isFinite(embedDim) && embedDim > 0) {
    try {
      await db.query(
        `ALTER TABLE bus_contexts ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    } catch (err) {
      publish("warn", "failed to ensure bus_contexts embedding dimension", { err: serializeError(err) });
    }
  }

  if (Number.isFinite(embedDim) && embedDim <= 2000) {
    try {
      await db.query(
        `
        CREATE INDEX IF NOT EXISTS bus_context_embedding_idx
        ON bus_contexts USING ivfflat (embedding vector_cosine_ops)
        `
      );
    } catch (err) {
      publish("warn", "failed to ensure bus_contexts embedding index", { err: serializeError(err) });
    }
  } else {
    try {
      await db.query(`DROP INDEX IF EXISTS bus_context_embedding_idx`);
    } catch {
      // ignore
    }
    publish("warn", "skipping bus_contexts ivfflat index (embedding dim > 2000)", { embedDim });
  }
}

async function upsertContext(params: {
  db: Pool;
  ownerModule: string;
  sourceKey?: string;
  summaryShort: string;
  summaryLong: string;
  keyPoints: string[];
  embedding?: number[];
  messageId?: string;
}) {
  const summaryShort = params.summaryShort.slice(0, 128);
  const sourceKey = params.sourceKey ?? params.messageId ?? crypto.randomUUID();
  const validEmbedding =
    params.embedding &&
    params.embedding.length > 0 &&
    (!Number.isFinite(currentEmbedDim) || params.embedding.length === currentEmbedDim);
  const embeddingValue = validEmbedding ? `[${params.embedding!.join(",")}]` : "";

  const res = await params.db.query(
    `
    INSERT INTO bus_contexts (
      id, "ownerModule", "sourceKey", "summaryShort", "summaryLong", "keyPoints", embedding, version, "createdAt", "updatedAt"
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      NULLIF($7, '')::vector,
      1, now(), now()
    )
    ON CONFLICT ("ownerModule", "sourceKey") DO UPDATE SET
      "summaryShort" = EXCLUDED."summaryShort",
      "summaryLong" = EXCLUDED."summaryLong",
      "keyPoints" = EXCLUDED."keyPoints",
      embedding = EXCLUDED.embedding,
      "updatedAt" = now(),
      version = bus_contexts.version + 1
    RETURNING id
    `,
    [
      crypto.randomUUID(),
      params.ownerModule,
      sourceKey,
      summaryShort,
      params.summaryLong,
      params.keyPoints,
      embeddingValue,
    ]
  );

  const contextId = res.rows?.[0]?.id as string | undefined;
  if (contextId && params.messageId) {
    await params.db.query(
      `
      INSERT INTO bus_context_messages ("contextId", "messageId", "createdAt")
      VALUES ($1, $2, now())
      ON CONFLICT ("contextId", "messageId") DO NOTHING
      `,
      [contextId, params.messageId]
    );
  }
}

async function recordJobStart(params: {
  db: Pool;
  runId: string;
  moduleName: string;
  queue: string;
  jobName: string;
  trigger: JobTrigger;
}) {
  const triggerJson = params.trigger ?? null;
  await params.db.query(
    `
    INSERT INTO job_runs (
      id, "createdAt", "updatedAt",
      module, job, queue,
      status, "triggerType", "triggerJson",
      "startedAt"
    ) VALUES (
      $1, now(), now(),
      $2, $3, $4,
      'running', $5, $6,
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      status = 'running',
      "updatedAt" = now(),
      "startedAt" = now()
    `,
    [
      params.runId,
      params.moduleName,
      params.jobName,
      params.queue,
      params.trigger.type,
      triggerJson,
    ]
  );

  await params.db.query(
    `
    INSERT INTO job_states (id, module, job, "lastRunAt")
    VALUES ($1, $2, $3, now())
    ON CONFLICT (module, job) DO UPDATE SET "lastRunAt" = EXCLUDED."lastRunAt"
    `,
    [crypto.randomUUID(), params.moduleName, params.jobName]
  );
}

async function recordJobSuccess(params: {
  db: Pool;
  runId: string;
  moduleName: string;
  jobName: string;
  metricsJson?: Record<string, unknown>;
}) {
  await params.db.query(
    `
    UPDATE job_runs
    SET status = 'success', "updatedAt" = now(), "finishedAt" = now(), error = NULL, "metricsJson" = $2
    WHERE id = $1
    `,
    [params.runId, params.metricsJson ?? null]
  );
  await params.db.query(
    `
    UPDATE job_states
    SET "lastSuccessAt" = now(), "lastErrorAt" = NULL, "lastError" = NULL, "lastRunAt" = now(), "lastMetrics" = $3
    WHERE module = $1 AND job = $2
    `,
    [params.moduleName, params.jobName, params.metricsJson ?? null]
  );
}

async function recordJobError(params: { db: Pool; runId: string; moduleName: string; jobName: string; error: string }) {
  await params.db.query(
    `
    UPDATE job_runs
    SET status = 'error', "updatedAt" = now(), "finishedAt" = now(), error = $2
    WHERE id = $1
    `,
    [params.runId, params.error]
  );
  await params.db.query(
    `
    UPDATE job_states
    SET "lastErrorAt" = now(), "lastError" = $3, "lastRunAt" = now()
    WHERE module = $1 AND job = $2
    `,
    [params.moduleName, params.jobName, params.error]
  );
}

async function main() {
  const nc = await connect({ servers: NATS_URL });
  // eslint-disable-next-line no-console
  console.log("[worker] connected to nats");

  try {
    const db = new Pool({ connectionString: DATABASE_URL });
    const settingsClient = createSettingsClient({ apiBaseUrl: API_BASE_URL });
    const apiBase = API_BASE_URL.replace(/\/+$/, "");
    const fetchSettings = async (moduleName: string) => {
      const url = `${apiBase}/api/internal/settings/${encodeURIComponent(moduleName)}`;
      let attempt = 0;
      while (true) {
        attempt++;
        try {
          const res = await fetch(url, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
          if (!res.ok) throw new Error(`internal settings fetch failed (${res.status})`);
          const data = (await res.json()) as { settings: Array<{ key: string; value: string | null }> };
          const out: Record<string, unknown> = {};
          for (const s of data.settings) out[s.key] = s.value;
          if (attempt > 1) publishLog(nc, sc, "info", "internal settings fetch recovered", { moduleName, attempt });
          return out;
        } catch (err) {
          const delay = Math.min(5000, 250 * Math.pow(1.6, attempt - 1));
          publishLog(nc, sc, "warn", "internal settings fetch failed; retrying", {
            moduleName,
            attempt,
            delayMs: Math.floor(delay),
            err: err instanceof Error ? { name: err.name, message: err.message } : err,
          });
          await sleep(delay);
        }
      }
    };

    const sysSettings = await fetchSettings("system");
    const sysEmbedDimRaw = sysSettings.ollama_embed_dim ?? DEFAULT_EMBED_DIM;
    const sysEmbedDim = Number.isFinite(Number(sysEmbedDimRaw)) ? Number(sysEmbedDimRaw) : DEFAULT_EMBED_DIM;
    currentEmbedDim = sysEmbedDim;
    await ensureContextStorage(db, (level, message, meta) => publishLog(nc, sc, level, message, meta), sysEmbedDim);

    // Start append-only archive consumer (JetStream -> Postgres).
    await startBusArchiver({ nc, db, fetchInternalSettings: fetchSettings });

    const modules = await discoverModules(MODULES_DIR);
    // eslint-disable-next-line no-console
    console.log(`[worker] discovered modules: ${modules.map((m) => m.name).join(", ") || "(none)"}`);

    const runtimeByModule = new Map<string, ModuleRuntime>();
    const failedModules: Array<{ name: string; reason: string }> = [];
    for (const m of modules) {
      const entry = m.runtime?.entry;
      if (!entry) {
        // eslint-disable-next-line no-console
        console.log(`[worker] module ${m.name} has no runtime.entry; skipping runtime load`);
        continue;
      }
      try {
        const rt = await loadModuleRuntime({ modulesDir: MODULES_DIR, moduleName: m.name, runtimeEntry: entry });
        runtimeByModule.set(m.name, rt);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failedModules.push({ name: m.name, reason });
        // eslint-disable-next-line no-console
        console.error(`[worker] failed to load: ${m.name} (${reason})`);
        publishLog(nc, sc, "error", `failed to load module: ${m.name}`, { module: m.name, reason });
      }
    }

    const totalWithRuntime = modules.filter((m) => m.runtime?.entry).length;
    const loadedCount = runtimeByModule.size;
    if (failedModules.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[worker] loaded ${loadedCount}/${totalWithRuntime} modules (${failedModules.length} failed)`);
      for (const f of failedModules) {
        // eslint-disable-next-line no-console
        console.log(`[worker] failed to load: ${f.name} (${f.reason})`);
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(`[worker] loaded ${loadedCount}/${totalWithRuntime} modules`);
    }

    const queuesByName = new Map<string, Queue>();
    const getQueue = (name: string) => {
      let q = queuesByName.get(name);
      if (!q) {
        q = new Queue(name, { connection: redis });
        queuesByName.set(name, q);
      }
      return q;
    };

    const baseCtx: Omit<ModuleRuntimeContext, "moduleName"> = {
      modulesDir: MODULES_DIR,
      db: db as any,
      nats: nc as any,
      sc: sc as any,
      getQueue: (q: string) => getQueue(q) as any,
      fetchInternalSettings: fetchSettings,
    };

    const makeCtx = (moduleName: string): ModuleRuntimeContext => ({
      ...(baseCtx as any),
      moduleName,
    });

    // Schedule repeat jobs declared by modules (BullMQ repeatable).
    for (const mod of modules) {
      if (!runtimeByModule.has(mod.name)) continue;
      for (const job of mod.jobs ?? []) {
        if (!job.schedule) continue;
        await getQueue(job.queue).add(
          job.name,
          { __module: mod.name, __trigger: { type: "schedule" } },
          { repeat: { pattern: job.schedule }, removeOnComplete: true, removeOnFail: 100 }
        );
      }
    }

    // NATS → BullMQ queue triggers
    const natsSubs: Array<{ subject: string; queue: string; jobName: string; moduleName: string }> = [];
    for (const mod of modules) {
      if (!runtimeByModule.has(mod.name)) continue;
      for (const j of mod.jobs ?? []) {
        if (j.triggeredBy)
          natsSubs.push({ subject: j.triggeredBy, queue: j.queue, jobName: j.name, moduleName: mod.name });
      }
    }

    for (const s of natsSubs) {
      const sub = nc.subscribe(s.subject);
      (async () => {
        for await (const m of sub) {
          try {
            const raw = JSON.parse(sc.decode(m.data)) as unknown;
            const msg = (() => {
              const env = MessageCreatedEventSchema.safeParse(raw);
              if (env.success) return env.data.message;
              return NormalizedMessageSchema.parse(raw);
            })();
            await getQueue(s.queue).add(
              s.jobName,
              { __module: s.moduleName, trigger: { subject: s.subject, messageId: msg.id } },
              { removeOnComplete: true, removeOnFail: 100 }
            );
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[worker] failed to enqueue triggered job", err);
            publishLog(nc, sc, "error", "failed to enqueue triggered job", err);
          }
        }
      })().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[worker] subscription loop crashed", err);
        publishLog(nc, sc, "error", "subscription loop crashed", err);
      });
    }

    // BullMQ Workers — one per queue, concurrent execution.
    const makeProcessor = (queueName: string) => async (job: { id?: string; name: string; data: Record<string, unknown> }) => {
      const moduleName = String(job.data.__module ?? "");
      if (!moduleName) throw new Error(`Job missing __module (queue=${queueName} name=${job.name})`);

      const runId = String(job.id ?? crypto.randomUUID());
      const trigger: JobTrigger = (job.data.__trigger as JobTrigger) ?? { type: "manual" };
      await recordJobStart({ db, runId, moduleName, queue: queueName, jobName: job.name, trigger });

      const rt = runtimeByModule.get(moduleName);
      if (!rt) throw new Error(`No runtime loaded for module ${moduleName}`);

      const handler = rt.handlers?.[queueName]?.[job.name];
      if (!handler) throw new Error(`No handler for module=${moduleName} queue=${queueName} job=${job.name}`);

      const ctx = makeCtx(moduleName);
      const startedAt = Date.now();
      try {
        const result = await handler({ ctx, job: { name: job.name, data: job.data, id: runId } });
        const durationMs = Date.now() - startedAt;
        const metrics =
          result && typeof result === "object" && "metrics" in result && result.metrics
            ? (result.metrics as Record<string, unknown>)
            : {};
        const metricsJson = { durationMs, ...metrics };
        await recordJobSuccess({ db, runId, moduleName, jobName: job.name, metricsJson });
      } catch (err) {
        const message = serializeError(err);
        publishLog(nc, sc, "error", "job failed", { module: moduleName, queue: queueName, job: job.name, err: message });
        await recordJobError({ db, runId, moduleName, jobName: job.name, error: message });
        throw err;
      }
    };

    for (const qName of queuesByName.keys()) {
      const w = new Worker(qName, makeProcessor(qName), { connection: redis });
      w.on("failed", (job, err) => {
        const id = job?.id ?? "unknown";
        // eslint-disable-next-line no-console
        console.error(`[worker] job failed queue=${qName} id=${id}`, err);
      });
    }

    // eslint-disable-next-line no-console
    console.log(`[worker] BullMQ dispatchers started for queues: ${[...queuesByName.keys()].join(", ") || "(none)"}`);

    const contextSub = nc.subscribe(CONTEXT_SUBJECT_WILDCARD);
    (async () => {
      for await (const m of contextSub) {
        try {
          const raw = JSON.parse(sc.decode(m.data)) as unknown;
          const env = ContextUpdatedEventSchema.parse(raw);
          await upsertContext({
            db,
            ownerModule: env.context.ownerModule,
            sourceKey: env.context.sourceKey,
            summaryShort: env.context.summaryShort,
            summaryLong: env.context.summaryLong,
            keyPoints: env.context.keyPoints ?? [],
            embedding: env.context.embedding,
            messageId: env.messageId,
          });
        } catch (err) {
          publishLog(nc, sc, "warn", "failed to apply context update", { err: serializeError(err) });
        }
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[worker] context subscription loop crashed", err);
      publishLog(nc, sc, "error", "context subscription loop crashed", err);
    });

    // Re-emit Postgres history into NATS for dashboard lookback window.
    const sysSettings2 = await fetchSettings("system");
    const lookbackMinutesRaw = sysSettings2.dashboard_bus_history_minutes;
    const parsedLookbackMinutes =
      lookbackMinutesRaw === null || lookbackMinutesRaw === undefined ? NaN : Number(String(lookbackMinutesRaw).trim());
    const lookbackMinutes = Number.isFinite(parsedLookbackMinutes) && parsedLookbackMinutes >= 0 ? parsedLookbackMinutes : 60;

    await db.query(
      `
      DELETE FROM bus_reemit_dedupe
      WHERE "lastEmittedAt" < (now() - ($1 * INTERVAL '1 minute'))
      `,
      [lookbackMinutes]
    );

    const since = new Date(Date.now() - lookbackMinutes * 60_000);
    const res = await db.query(
      `
      SELECT m.id, m."rawJson"
      FROM bus_messages m
      LEFT JOIN bus_reemit_dedupe d ON d."messageId" = m.id
      WHERE m."createdAt" >= $1 AND d."messageId" IS NULL
      ORDER BY m."createdAt" ASC
      `,
      [since]
    );

    for (const row of res.rows as Array<{ id: string; rawJson: unknown }>) {
      try {
        const msg = NormalizedMessageSchema.parse(row.rawJson);
        const event = MessageCreatedEventSchema.parse({
          type: "MessageCreated",
          message: { ...msg, realtime: false },
        });
        nc.publish(subjectFor(msg.source.module, "messageCreated"), sc.encode(JSON.stringify(event)));
        await db.query(
          `
          INSERT INTO bus_reemit_dedupe ("messageId", "lastEmittedAt")
          VALUES ($1, now())
          ON CONFLICT ("messageId") DO UPDATE SET "lastEmittedAt" = EXCLUDED."lastEmittedAt"
          `,
          [row.id]
        );
      } catch (err) {
        publishLog(nc, sc, "warn", "failed to re-emit bus history", { err: serializeError(err), messageId: row.id });
      }
    }

    // Keep the legacy settings client referenced to avoid tree-shaking issues in some bundlers.
    void settingsClient;
  } catch (err) {
    publishLog(nc, sc, "error", "fatal", err);
    throw err;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal", err);
  process.exit(1);
});


