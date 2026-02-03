// Local dev shim: this repo may be opened without `node_modules` installed.
// Minimal type shims to keep editor/typecheck usable; real types come from installed deps.
declare var process: any;

declare module "pg" {
  export type PoolClient = any;
  export class Pool {
    constructor(opts: any);
    query(sql: string, params?: any[]): Promise<any>;
    connect(): Promise<any>;
  }
}

declare module "uuid" {
  export function v5(name: string, namespace: string): string;
}

declare module "nats" {
  export type NatsConnection = any;
  export type StringCodec = any;
}

declare module "@feedeater/core" {
  export const ContextUpdatedEventSchema: import("zod").ZodSchema<any>;
  export const MessageCreatedEventSchema: import("zod").ZodSchema<any>;
  export const NormalizedMessageSchema: import("zod").ZodSchema<any>;
  export function subjectFor(module: string, event: string): string;
}

declare module "@feedeater/module-sdk" {
  export interface ModuleRuntimeContext {
    moduleName: string;
    modulesDir: string;
    db: any;
    nats: any;
    sc: any;
    getQueue(queueName: string): { add(name: string, data: unknown, opts?: unknown): Promise<unknown> };
    fetchInternalSettings(moduleName: string): Promise<Record<string, unknown>>;
  }

  export type ModuleJobHandler = (params: {
    ctx: ModuleRuntimeContext;
    job: { name: string; data: any; id?: string | number };
  }) => Promise<void | { metrics?: Record<string, unknown> }>;

  export interface ModuleRuntime {
    moduleName: string;
    handlers: Record<string, Record<string, ModuleJobHandler>>;
  }
}
