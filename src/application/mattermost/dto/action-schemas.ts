import { z } from 'zod';

export const SendMessageActionSchema = z.object({
  action: z.literal('send_message'),
  channel: z.string().min(1, 'Channel is required.'),
  message: z.string().min(1, 'Message cannot be empty.'),
  from: z.string().optional(),
  rootId: z.string().optional(),
  teamId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export const ReplyToMessageActionSchema = z.object({
  action: z.literal('reply_to_message'),
  channel: z.string().min(1, 'Channel is required.'),
  rootId: z.string().min(1, 'Root ID is required to reply to a thread.'),
  message: z.string().min(1, 'Message cannot be empty.'),
  from: z.string().optional(),
  teamId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export const ReadChannelActionSchema = z.object({
  action: z.literal('read_channel'),
  channel: z.string().min(1, 'Channel is required.'),
  limit: z.number().int().min(1).max(100).optional().default(30),
  since: z.number().int().positive().optional(),
  teamId: z.string().optional(),
});

export const GetChannelActionSchema = z.object({
  action: z.literal('get_channel'),
  channel: z.string().min(1, 'Channel is required.'),
  teamId: z.string().optional(),
});

export const WhoamiActionSchema = z.object({
  action: z.literal('whoami'),
});

export const MattermostActionSchema = z.discriminatedUnion('action', [
  SendMessageActionSchema,
  ReplyToMessageActionSchema,
  ReadChannelActionSchema,
  GetChannelActionSchema,
  WhoamiActionSchema,
]);

export type SendMessageAction = z.infer<typeof SendMessageActionSchema>;
export type ReplyToMessageAction = z.infer<typeof ReplyToMessageActionSchema>;
export type ReadChannelAction = z.infer<typeof ReadChannelActionSchema>;
export type GetChannelAction = z.infer<typeof GetChannelActionSchema>;
export type WhoamiAction = z.infer<typeof WhoamiActionSchema>;
export type MattermostAction = z.infer<typeof MattermostActionSchema>;

export interface ActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
