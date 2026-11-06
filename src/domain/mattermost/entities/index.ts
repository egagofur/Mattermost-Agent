export interface User {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  roles?: string;
  createAt?: number;
}

export interface Team {
  id: string;
  name: string;
  displayName: string;
  description?: string;
}

export type ChannelType = 'O' | 'P' | 'D' | 'G' | string; // O: Open/Public, P: Private, D: Direct, G: Group

export interface Channel {
  id: string;
  teamId?: string;
  name: string;
  displayName: string;
  type: ChannelType;
  header?: string;
  purpose?: string;
}

export interface PostAttachment {
  id: string;
  name: string;
  size?: number;
  mimeType?: string;
  extension?: string;
}

export interface PostReaction {
  userId: string;
  postId: string;
  emojiName: string;
  createAt?: number;
}

export interface Post {
  id: string;
  createAt: number;
  updateAt: number;
  deleteAt?: number;
  userId: string;
  channelId: string;
  rootId?: string;
  message: string;
  type?: string;
  hashtags?: string;
  props?: Record<string, unknown>;
  fileIds?: string[];
  files?: PostAttachment[];
  reactions?: PostReaction[];
}

export interface SendMessageInput {
  channelId: string;
  message: string;
  from?: string;
  rootId?: string;
  idempotencyKey?: string;
}

export interface SendMessageResult {
  id: string;
  channelId: string;
  userId: string;
  message: string;
  rootId?: string;
  createdAt: Date;
}

export interface ReplyToMessageInput {
  channelId: string;
  rootId: string;
  message: string;
  from?: string;
  idempotencyKey?: string;
}

export interface GetMessagesInput {
  channelId: string;
  limit?: number;
  since?: number;
}

export interface GetChannelInput {
  channelId?: string;
  channelName?: string;
  teamId?: string;
}

export interface EditMessageInput {
  postId: string; // Mendukung 26-char post ID atau permalink URL
  message: string;
  from?: string; // Optional attribution footer (e.g. "_~ from AI Agent_")
}

export interface EditMessageResult {
  id: string;
  channelId: string;
  userId: string;
  message: string;
  updatedAt: Date;
}

export interface ThreadPostItem {
  id: string;
  rootId?: string;
  channelId: string;
  userId: string;
  username: string;
  createAt: number;
  updateAt?: number;
  message: string;
  files?: PostAttachment[];
  reactions?: PostReaction[];
}

export interface ThreadViewResult {
  rootId: string;
  channelId: string;
  totalPosts: number;
  truncated: boolean;
  posts: ThreadPostItem[];
}

export interface GetMentionsInput {
  since?: number;
  limit?: number;
  teamId?: string;
}

export interface UserMentionItem {
  id: string;
  rootId?: string;
  channelId: string;
  channelName?: string;
  userId: string;
  username: string;
  message: string;
  createAt: number;
  hasReplied: boolean;
}

export interface MentionsResult {
  total: number;
  mentions: UserMentionItem[];
  warnings?: string[];
}

export interface SearchFilterOptions {
  terms?: string;
  from?: string;
  in?: string;
  after?: string;
  before?: string;
  limit?: number;
  teamId?: string;
  isOrSearch?: boolean;
}

export interface SearchPostsResult {
  total: number;
  query: string;
  posts: ThreadPostItem[];
  warnings?: string[];
}

export interface UnreadChannelSummary {
  channelId: string;
  channelName: string;
  displayName: string;
  type: string;
  teamId?: string;
  unreadCount: number;
  mentionCount: number;
  hasMention: boolean;
}

export interface UnreadSummaryResult {
  totalUnreadChannels: number;
  channels: UnreadChannelSummary[];
  warnings?: string[];
}

export interface PostContextResult {
  post: ThreadPostItem;
  before: ThreadPostItem[];
  after: ThreadPostItem[];
  totalContextPosts: number;
}

export interface ReactionResult {
  userId: string;
  postId: string;
  emojiName: string;
  createAt: number;
}

export interface UserProfileResult {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  position?: string;
  roles?: string;
  createAt?: number;
}

export interface FileDownloadResult {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  savedPath: string;
}

