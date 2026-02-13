declare module "@feedeater/core" {
  export const MessageCreatedEventSchema: import("zod").ZodType<unknown>;
  export const NormalizedMessageSchema: import("zod").ZodType<unknown>;
  export const ContextUpdatedEventSchema: import("zod").ZodType<unknown>;
  export function subjectFor(module: string, event: string): string;
}
