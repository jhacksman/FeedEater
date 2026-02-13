declare module "@feedeater/core" {
  export const MessageCreatedEventSchema: import("zod").ZodType<{
    type: "MessageCreated";
    message: import("zod").infer<typeof NormalizedMessageSchema>;
  }>;
  export const NormalizedMessageSchema: import("zod").ZodType<{
    id: string;
    createdAt: string;
    source: { module: string; stream?: string };
    contextRef?: { ownerModule: string; sourceKey: string };
    Message?: string;
    From?: string;
    isDirectMention: boolean;
    isDigest: boolean;
    isSystemMessage: boolean;
    realtime?: boolean;
    likes?: number;
    tags: Record<string, string | number | boolean>;
  }>;
  export function subjectFor(moduleName: string, event: string): string;
}

declare module "@feedeater/module-sdk" {
  export type ModuleRuntime = {
    moduleName: string;
    handlers: Record<string, Record<string, (params: { ctx: ModuleRuntimeContext; job: { name: string; data: any; id?: string | number } }) => Promise<void | { metrics?: Record<string, unknown> }>>>;
  };
  export type ModuleRuntimeContext = {
    moduleName: string;
    modulesDir: string;
    db: import("pg").Pool;
    nats: import("nats").NatsConnection;
    sc: import("nats").StringCodec;
    getQueue(queueName: string): { add(name: string, data: unknown, opts?: unknown): Promise<unknown> };
    fetchInternalSettings(moduleName: string): Promise<Record<string, unknown>>;
  };
}
