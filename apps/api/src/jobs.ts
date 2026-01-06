import type { Request, Response } from "express";
import { Queue } from "bullmq";
import type IORedis from "ioredis";

import { discoverModules } from "./modules.js";

type RunJobBody = {
  module?: unknown;
  job?: unknown;
};

type ModuleManifest = Awaited<ReturnType<typeof discoverModules>>[number];

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

export function postRunJob(params: { modulesDir: string; redis: IORedis.Redis }) {
  // Cache queues per-request-handler instance.
  const queuesByName = new Map<string, Queue>();
  const getQueue = (name: string) => {
    let q = queuesByName.get(name);
    if (!q) {
      q = new Queue(name, { connection: params.redis });
      queuesByName.set(name, q);
    }
    return q;
  };

  return async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as RunJobBody;
      const moduleName = isNonEmptyString(body.module) ? body.module.trim() : "";
      const jobName = isNonEmptyString(body.job) ? body.job.trim() : "";
      if (!moduleName || !jobName) {
        res.status(400).json({ ok: false, error: "Body must include { module: string, job: string }" });
        return;
      }

      const modules = await discoverModules(params.modulesDir);
      const mod = modules.find((m: ModuleManifest) => m.name === moduleName);
      if (!mod) {
        res.status(404).json({ ok: false, error: `Unknown module: ${moduleName}` });
        return;
      }

      const job = (mod.jobs ?? []).find((j) => j.name === jobName);
      if (!job) {
        res.status(404).json({ ok: false, error: `Unknown job: ${moduleName}.${jobName}` });
        return;
      }

      // For safety: only allow manual triggering of scheduled jobs (no payload requirements).
      if (!job.schedule) {
        res.status(400).json({
          ok: false,
          error: `Job ${moduleName}.${jobName} is not scheduled; manual triggering is currently disabled for non-scheduled jobs.`,
        });
        return;
      }

      const q = getQueue(job.queue);
      const created = await q.add(
        job.name,
        { __module: moduleName, manual: true },
        // Keep a small history so BullBoard shows evidence of manual runs.
        { removeOnComplete: 100, removeOnFail: 100 }
      );

      res.json({ ok: true, jobId: created.id, queue: job.queue, job: job.name, module: moduleName });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
}


