import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { connect, StringCodec } from "nats";
import { Pool } from "pg";

import { NormalizedMessageSchema, createSettingsClient } from "@feedeater/core";
import { discoverModules } from "./modules/discovery.js";
import type { ModuleManifest } from "./modules/types.js";
import type { ModuleRuntimeContext, ModuleRuntime } from "@feedeater/module-sdk";
import { loadModuleRuntime } from "./modules/runtime.js";

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

requiredEnv("DATABASE_URL");
const DATABASE_URL = requiredEnv("DATABASE_URL");

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const sc = StringCodec();

async function main() {
  const nc = await connect({ servers: NATS_URL });
  // eslint-disable-next-line no-console
  console.log("[worker] connected to nats");

  const db = new Pool({ connectionString: DATABASE_URL });

  const settingsClient = createSettingsClient({ apiBaseUrl: API_BASE_URL });
  const apiBase = API_BASE_URL.replace(/\/+$/, "");
  const fetchSettings = async (moduleName: string) => {
    const res = await fetch(`${apiBase}/api/internal/settings/${encodeURIComponent(moduleName)}`, {
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    if (!res.ok) throw new Error(`internal settings fetch failed (${res.status})`);
    const data = (await res.json()) as { settings: Array<{ key: string; value: string | null }> };
    const out: Record<string, unknown> = {};
    for (const s of data.settings) out[s.key] = s.value;
    return out;
  };

  const modules = await discoverModules(MODULES_DIR);
  // eslint-disable-next-line no-console
  console.log(`[worker] discovered modules: ${modules.map((m) => m.name).join(", ") || "(none)"}`);

  const queuesByName = new Map<string, Queue>();
  const getQueue = (name: string) => {
    let q = queuesByName.get(name);
    if (!q) {
      q = new Queue(name, { connection: redis });
      queuesByName.set(name, q);
    }
    return q;
  };

  const runtimeByModule = new Map<string, ModuleRuntime>();
  for (const m of modules) {
    const entry = m.runtime?.entry;
    if (!entry) {
      // eslint-disable-next-line no-console
      console.log(`[worker] module ${m.name} has no runtime.entry; skipping runtime load`);
      continue;
    }
    const rt = await loadModuleRuntime({ modulesDir: MODULES_DIR, moduleName: m.name, runtimeEntry: entry });
    runtimeByModule.set(m.name, rt);
  }

  const baseCtx: Omit<ModuleRuntimeContext, "moduleName"> = {
    modulesDir: MODULES_DIR,
    db: db as any,
    nats: nc as any,
    sc: sc as any,
    getQueue: (q: string) => getQueue(q) as any,
    fetchInternalSettings: fetchSettings,
  };

  // Schedule repeat jobs declared by modules.
  for (const mod of modules) {
    for (const job of mod.jobs ?? []) {
      if (job.schedule) {
        await getQueue(job.queue).add(
          job.name,
          { __module: mod.name },
          { repeat: { pattern: job.schedule }, removeOnComplete: true, removeOnFail: 100 }
        );
      }
    }
  }

  // NATS → queue triggers
  const natsSubs: Array<{ subject: string; queue: string; jobName: string; moduleName: string }> = [];
  for (const mod of modules) {
    for (const j of mod.jobs ?? []) {
      if (j.triggeredBy) natsSubs.push({ subject: j.triggeredBy, queue: j.queue, jobName: j.name, moduleName: mod.name });
    }
  }

  for (const s of natsSubs) {
    const sub = nc.subscribe(s.subject);
    (async () => {
      for await (const m of sub) {
        try {
          const parsed = NormalizedMessageSchema.parse(JSON.parse(sc.decode(m.data)));
          await getQueue(s.queue).add(
            s.jobName,
            { __module: s.moduleName, trigger: { subject: s.subject, messageId: parsed.id } },
            { removeOnComplete: true, removeOnFail: 100 }
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[worker] failed to enqueue triggered job", err);
        }
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[worker] subscription loop crashed", err);
    });
  }

  // Job dispatchers per queue.
  const makeProcessor = (queueName: string) => async (job: any) => {
    const moduleName = String(job?.data?.__module ?? "");
    if (!moduleName) throw new Error(`Job missing __module (queue=${queueName} name=${job?.name ?? "unknown"})`);

    const rt = runtimeByModule.get(moduleName);
    if (!rt) throw new Error(`No runtime loaded for module ${moduleName}`);

    const handler = rt.handlers?.[queueName]?.[String(job.name)];
    if (!handler) throw new Error(`No handler for module=${moduleName} queue=${queueName} job=${String(job.name)}`);

    const ctx: ModuleRuntimeContext = { ...(baseCtx as any), moduleName };
    await handler({ ctx, job: { name: String(job.name), data: job.data, id: job.id } });
  };

  for (const qName of queuesByName.keys()) {
    const w = new Worker(qName, makeProcessor(qName), { connection: redis });
    w.on("failed", (job: unknown, err: unknown) => {
      // eslint-disable-next-line no-console
      const id = (job as any)?.id ?? "unknown";
      console.error(`[worker] job failed queue=${qName} id=${id}`, err);
    });
  }

  // Keep the legacy settings client referenced to avoid tree-shaking issues in some bundlers.
  void settingsClient;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal", err);
  process.exit(1);
});


