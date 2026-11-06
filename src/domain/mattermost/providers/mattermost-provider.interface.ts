import {
  Channel,
  EditMessageInput,
  EditMessageResult,
  GetChannelInput,
  GetMessagesInput,
  Post,
  ReplyToMessageInput,
  SendMessageInput,
  SendMessageResult,
  User,
} from '../entities';

export interface MattermostProvider {
  /**
   * Returns details of the currently authenticated user.
   */
  getMe(): Promise<User>;

  /**
   * Retrieves channel metadata by ID or name and team.
   */
  getChannel(input: GetChannelInput): Promise<Channel>;

  /**
   * Lists channels accessible to the user (optionally filtered by team).
   */
  listChannels(teamId?: string): Promise<Channel[]>;

  /**
   * Posts a new message to a channel.
   */
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;

  /**
   * Replies to an existing message thread.
   */
  replyToMessage(input: ReplyToMessageInput): Promise<SendMessageResult>;

  /**
   * Edits an existing message/post.
   */
  editMessage(input: EditMessageInput): Promise<EditMessageResult>;

  /**
   * Reads recent messages from a channel.
   */
  getMessages(input: GetMessagesInput): Promise<Post[]>;

  /**
   * Retrieves raw posts in a thread given a post ID or thread root ID.
   */
  getPostThread(postId: string): Promise<{ order: string[]; posts: Record<string, Post> }>;

  /**
   * Searches posts matching terms (e.g. '@username').
   */
  searchPosts(terms: string, options?: { teamId?: string; isOrSearch?: boolean }): Promise<Post[]>;

  /**
   * Batch fetches user profiles by an array of user IDs.
   */
  getUsersByIds?(userIds: string[]): Promise<User[]>;

  /**
   * Optional cleanup hook for releasing resources (e.g. browser context).
   */
  close?(): Promise<void>;
}
