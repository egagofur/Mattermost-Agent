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
