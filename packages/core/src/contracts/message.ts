import { z } from "zod";

export const MessageTagValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type MessageTagValue = z.infer<typeof MessageTagValueSchema>;

export const MessageTagsSchema = z.record(MessageTagValueSchema);
export type MessageTags = z.infer<typeof MessageTagsSchema>;

export const NormalizedMessageSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  source: z.object({
    module: z.string(),
    stream: z.string().optional(),
  }),
  content: z.object({
    text: z.string().optional(),
    url: z.string().url().optional(),
  }),
  tags: MessageTagsSchema.default({}),
});

export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;


