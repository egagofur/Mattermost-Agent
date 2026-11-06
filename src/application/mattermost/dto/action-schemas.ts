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

export const EditMessageActionSchema = z.object({
  action: z.literal('edit_message'),
  postId: z.string().min(1, 'Post ID or permalink is required.'),
  message: z.string().min(1, 'Message cannot be empty.'),
  from: z.string().optional(),
});

export const GetThreadActionSchema = z.object({
  action: z.literal('get_thread'),
  permalinkOrId: z.string().min(1, 'Post permalink or ID is required.'),
  limit: z.number().int().min(1).max(500).optional().default(200),
});

export const GetMentionsActionSchema = z.object({
  action: z.literal('get_mentions'),
  since: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  teamId: z.string().optional(),
});

export const SearchActionSchema = z.object({
  action: z.literal('search'),
  terms: z.string().optional(),
  from: z.string().optional(),
  in: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional().default(20),
  teamId: z.string().optional(),
  isOrSearch: z.boolean().optional(),
});

export const UnreadSummaryActionSchema = z.object({
  action: z.literal('unread_summary'),
});

export const GetPostActionSchema = z.object({
  action: z.literal('get_post'),
  postIdOrPermalink: z.string().min(1, 'Post permalink or ID is required.'),
  context: z.number().int().min(0).max(50).optional().default(3),
});

export const GetUserActionSchema = z.object({
  action: z.literal('get_user'),
  usernameOrId: z.string().min(1, 'Username or user ID is required.'),
});

export const GetFileActionSchema = z.object({
  action: z.literal('get_file'),
  fileId: z.string().min(1, 'File ID is required.'),
  outputDir: z.string().optional(),
  maxSizeBytes: z.number().int().positive().optional(),
});

export const MattermostActionSchema = z.discriminatedUnion('action', [
  SendMessageActionSchema,
  ReplyToMessageActionSchema,
  EditMessageActionSchema,
  ReadChannelActionSchema,
  GetChannelActionSchema,
  WhoamiActionSchema,
  GetThreadActionSchema,
  GetMentionsActionSchema,
  SearchActionSchema,
  UnreadSummaryActionSchema,
  GetPostActionSchema,
  GetUserActionSchema,
  GetFileActionSchema,
]);

export type SendMessageAction = z.infer<typeof SendMessageActionSchema>;
export type ReplyToMessageAction = z.infer<typeof ReplyToMessageActionSchema>;
export type EditMessageAction = z.infer<typeof EditMessageActionSchema>;
export type ReadChannelAction = z.infer<typeof ReadChannelActionSchema>;
export type GetChannelAction = z.infer<typeof GetChannelActionSchema>;
export type WhoamiAction = z.infer<typeof WhoamiActionSchema>;
export type GetThreadAction = z.infer<typeof GetThreadActionSchema>;
export type GetMentionsAction = z.infer<typeof GetMentionsActionSchema>;
export type SearchAction = z.infer<typeof SearchActionSchema>;
export type UnreadSummaryAction = z.infer<typeof UnreadSummaryActionSchema>;
export type GetPostAction = z.infer<typeof GetPostActionSchema>;
export type GetUserAction = z.infer<typeof GetUserActionSchema>;
export type GetFileAction = z.infer<typeof GetFileActionSchema>;
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
