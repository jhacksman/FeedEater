declare module "@feedeater/core" {
  export const MessageCreatedEventSchema: import("zod").ZodType<{
    type: "MessageCreated";
    message: NormalizedMessage;
  }>;
  export const NormalizedMessageSchema: import("zod").ZodType<NormalizedMessage>;
  export const ContextUpdatedEventSchema: import("zod").ZodType<unknown>;
  export function subjectFor(module: string, event: string): string;

  export interface NormalizedMessage {
    id: string;
    createdAt: string;
    source: { module: string; stream?: string };
    contextRef?: { ownerModule: string; sourceKey: string };
    Message?: string;
    From?: string;
    isDirectMention: boolean;
    isDigest: boolean;
    isSystemMessage: boolean;
    likes?: number;
    tags?: Record<string, unknown>;
  }
}

declare module "@feedeater/module-sdk" {
  import type { Pool } from "pg";
  import type { NatsConnection, StringCodec } from "nats";

  export interface JobContext {
    db: Pool;
    nats: NatsConnection;
    sc: StringCodec;
    fetchInternalSettings(module: string): Promise<Record<string, unknown>>;
  }

  export interface JobHandler {
    (params: { ctx: JobContext }): Promise<{ metrics?: Record<string, unknown> }>;
  }

  export interface ModuleRuntime {
    moduleName: string;
    handlers: Record<string, Record<string, JobHandler>>;
  }
}
