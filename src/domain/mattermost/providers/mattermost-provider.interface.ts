import {
  Channel,
  EditMessageInput,
  EditMessageResult,
  FileDownloadResult,
  GetChannelInput,
  GetMessagesInput,
  Post,
  ReactionResult,
  ReplyToMessageInput,
  SendMessageInput,
  SendMessageResult,
  UnreadSummaryResult,
  User,
  UserProfileResult,
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
   * Fetches a single post by ID.
   */
  getPost?(postId: string): Promise<Post>;

  /**
   * Fetches context posts in a channel around a specific post (before and/or after).
   */
  getChannelPosts?(channelId: string, options: { before?: string; after?: string; limit?: number }): Promise<Post[]>;

  /**
   * Summarizes all unread channels and mentions for the current user.
   */
  getUnreadSummary?(): Promise<UnreadSummaryResult>;

  /**
   * Adds an emoji reaction to a post.
   */
  addReaction?(postId: string, emojiName: string): Promise<ReactionResult>;

  /**
   * Fetches user profile by username or 26-char ID.
   */
  getUser?(usernameOrId: string): Promise<UserProfileResult>;

  /**
   * Downloads an attachment file by file ID.
   */
  downloadFile?(fileId: string, outputDir: string, maxSizeBytes?: number): Promise<FileDownloadResult>;

  /**
   * Optional cleanup hook for releasing resources (e.g. browser context).
   */
  close?(): Promise<void>;
}
