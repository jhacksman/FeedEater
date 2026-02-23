import type { ModuleRuntimeContext, ModuleRuntime } from "@feedeater/module-sdk";
import { discoverModules } from "./modules/discovery.js";
import { loadModuleRuntime } from "./modules/runtime.js";
import type { ModuleManifest } from "./modules/types.js";

export type { ModuleManifest, ModuleRuntime, ModuleRuntimeContext };

export interface OrchestrateOptions {
  nc: {
    subscribe(subject: string): AsyncIterable<{ data: Uint8Array }>;
    publish(subject: string, data?: Uint8Array): void;
  };
  sc: { encode(s: string): Uint8Array; decode(b: Uint8Array): string };
  modulesDir: string;
  db: ModuleRuntimeContext["db"];
  getQueue: ModuleRuntimeContext["getQueue"];
  fetchInternalSettings: ModuleRuntimeContext["fetchInternalSettings"];
}

export interface OrchestrateResult {
  manifests: ReadonlyArray<ModuleManifest>;
  runtimeByModule: ReadonlyMap<string, ModuleRuntime>;
  dispatchJob(
    moduleName: string,
    queueName: string,
    jobName: string,
    data: unknown,
  ): Promise<void | { metrics?: Record<string, unknown> }>;
}

export async function orchestrate(
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const { nc, sc, modulesDir, db, getQueue, fetchInternalSettings } = opts;

  const manifests = await discoverModules(modulesDir);

  const runtimeByModule = new Map<string, ModuleRuntime>();
  for (const m of manifests) {
    const entry = m.runtime?.entry;
    if (!entry) continue;
    try {
      const rt = await loadModuleRuntime({ modulesDir, moduleName: m.name, runtimeEntry: entry });
      runtimeByModule.set(m.name, rt);
    } catch (err) {
      console.error(`[orchestrate] failed to load runtime for ${m.name}:`, err);
    }
  }

  const makeCtx = (moduleName: string): ModuleRuntimeContext => ({
    modulesDir,
    db,
    nats: nc as ModuleRuntimeContext["nats"],
    sc: sc as ModuleRuntimeContext["sc"],
    getQueue,
    fetchInternalSettings,
    moduleName,
  });

  const natsSubs: Array<{ subject: string; queue: string; jobName: string; moduleName: string }> = [];
  for (const mod of manifests) {
    if (!runtimeByModule.has(mod.name)) continue;
    for (const j of mod.jobs ?? []) {
      if (j.triggeredBy) {
        natsSubs.push({ subject: j.triggeredBy, queue: j.queue, jobName: j.name, moduleName: mod.name });
      }
    }
  }

  for (const s of natsSubs) {
    const sub = nc.subscribe(s.subject);
    const rt = runtimeByModule.get(s.moduleName)!;
    (async () => {
      for await (const m of sub) {
        try {
          const raw = JSON.parse(sc.decode(m.data)) as unknown;
          const handler = rt.handlers[s.queue]?.[s.jobName];
          if (handler) {
            await handler({ ctx: makeCtx(s.moduleName), job: { name: s.jobName, data: raw } });
          }
        } catch (err) {
          console.error(`[orchestrate] trigger error (${s.moduleName}/${s.jobName}):`, err);
        }
      }
    })().catch((err) => {
      console.error(`[orchestrate] subscription loop crashed (${s.subject}):`, err);
    });
  }

  const dispatchJob = async (
    moduleName: string,
    queueName: string,
    jobName: string,
    data: unknown,
  ): Promise<void | { metrics?: Record<string, unknown> }> => {
    const rt = runtimeByModule.get(moduleName);
    if (!rt) throw new Error(`module ${moduleName} not loaded`);
    const handler = rt.handlers[queueName]?.[jobName];
    if (!handler) throw new Error(`no handler for ${moduleName}/${queueName}/${jobName}`);
    return handler({ ctx: makeCtx(moduleName), job: { name: jobName, data } });
  };

  return { manifests, runtimeByModule, dispatchJob };
}
