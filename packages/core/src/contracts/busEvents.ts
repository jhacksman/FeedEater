import { z } from "zod";

import { MessageTagValueSchema, NormalizedMessageSchema } from "./message.js";

export const MessageCreatedEventSchema = z.object({
  type: z.literal("MessageCreated"),
  message: NormalizedMessageSchema,
});
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEventSchema>;

export const TagAppendedEventSchema = z.object({
  type: z.literal("TagAppended"),
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  createdByModule: z.string(),
  messageId: z.string().uuid(),
  key: z.string(),
  value: MessageTagValueSchema,
});
export type TagAppendedEvent = z.infer<typeof TagAppendedEventSchema>;

export const BusEventSchema = z.union([MessageCreatedEventSchema, TagAppendedEventSchema]);
export type BusEvent = z.infer<typeof BusEventSchema>;


