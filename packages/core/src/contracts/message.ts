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
  // Human-readable body.
  Message: z.string().optional(),
  // URL to open when clicking the message.
  FollowMe: z.string().url().optional(),
  From: z.string().optional(),
  Thread: z.string().optional(),
  isDirectMention: z.boolean().default(false),
  isDigest: z.boolean().default(false),
  isSystemMessage: z.boolean().default(false),
  likes: z.number().int().nonnegative().optional(),
  tags: MessageTagsSchema.default({}),
});

export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;


