import * as fs from 'fs';
import * as path from 'path';
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
} from '../../../domain/mattermost/entities';
import { MattermostValidationError } from '../../../domain/mattermost/errors';
import { MattermostProvider } from '../../../domain/mattermost/providers/mattermost-provider.interface';
import { MattermostApiClient, MattermostRawChannel, MattermostRawPost, MattermostRawUser } from './client';
import { Logger, defaultLogger } from '../services/logger';

export class MattermostApiProvider implements MattermostProvider {
  private client: MattermostApiClient;
  private logger: Logger;

  constructor(client: MattermostApiClient, logger?: Logger) {
    this.client = client;
    this.logger = logger ?? defaultLogger;
  }

  private mapUser(raw: MattermostRawUser): User {
    return {
      id: raw.id,
      username: raw.username,
      email: raw.email,
      firstName: raw.first_name,
      lastName: raw.last_name,
      nickname: raw.nickname,
      roles: raw.roles,
      createAt: raw.create_at,
    };
  }

  private mapChannel(raw: MattermostRawChannel): Channel {
    return {
      id: raw.id,
      teamId: raw.team_id,
      name: raw.name,
      displayName: raw.display_name,
      type: raw.type,
      header: raw.header,
      purpose: raw.purpose,
    };
  }

  private mapPost(raw: MattermostRawPost): Post {
    return {
      id: raw.id,
      createAt: raw.create_at,
      updateAt: raw.update_at,
      deleteAt: raw.delete_at,
      userId: raw.user_id,
      channelId: raw.channel_id,
      rootId: raw.root_id,
      message: raw.message,
      type: raw.type,
      hashtags: raw.hashtags,
      props: raw.props,
      fileIds: raw.file_ids,
      files: raw.metadata?.files?.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mimeType: f.mime_type,
        extension: f.extension,
      })),
      reactions: raw.metadata?.reactions?.map((r) => ({
        userId: r.user_id,
        postId: r.post_id,
        emojiName: r.emoji_name,
        createAt: r.create_at,
      })),
    };
  }

  public async getMe(): Promise<User> {
    const raw = await this.client.getMe();
    return this.mapUser(raw);
  }

  public async getChannel(input: GetChannelInput): Promise<Channel> {
    if (input.channelId) {
      const raw = await this.client.getChannel(input.channelId);
      return this.mapChannel(raw);
    }

    if (input.channelName && input.teamId) {
      const raw = await this.client.getChannelByName(input.teamId, input.channelName);
      return this.mapChannel(raw);
    }

    // Fallback: list channels and search
    const channels = await this.listChannels(input.teamId);
    const targetName = (input.channelName || '').toLowerCase();
    const matched = channels.find(
      (c) => c.name.toLowerCase() === targetName || c.displayName.toLowerCase() === targetName
    );

    if (matched) {
      return matched;
    }

    throw new Error(`Channel '${input.channelName}' not found.`);
  }

  public async listChannels(teamId?: string): Promise<Channel[]> {
    if (teamId) {
      try {
        const userChannels = await this.client.getChannelsForUserInTeam(teamId);
        return userChannels.map((c) => this.mapChannel(c));
      } catch (err) {
        this.logger.debug(`Could not get user channels for team ${teamId}, trying all channels`);
        const allChannels = await this.client.getAllChannelsForTeam(teamId);
        return allChannels.map((c) => this.mapChannel(c));
      }
    }

    // Query user's teams and fetch channels from all of them
    const teams = await this.client.getMyTeams();
    const allChannels: Channel[] = [];

    for (const team of teams) {
      try {
        const channels = await this.client.getChannelsForUserInTeam(team.id);
        allChannels.push(...channels.map((c) => this.mapChannel(c)));
      } catch (err) {
        this.logger.debug(`Could not list channels for team ${team.name} (${team.id})`);
      }
    }

    return allChannels;
  }

  public async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.logger.debug(`Sending message to channel '${input.channelId}'...`);
    const rawPost = await this.client.createPost(input.channelId, input.message, input.rootId);
    return {
      id: rawPost.id,
      channelId: rawPost.channel_id,
      userId: rawPost.user_id,
      message: rawPost.message,
      rootId: rawPost.root_id || undefined,
      createdAt: new Date(rawPost.create_at),
    };
  }

  public async replyToMessage(input: ReplyToMessageInput): Promise<SendMessageResult> {
    this.logger.debug(`Replying to thread '${input.rootId}' in channel '${input.channelId}'...`);
    const rawPost = await this.client.createPost(input.channelId, input.message, input.rootId);
    return {
      id: rawPost.id,
      channelId: rawPost.channel_id,
      userId: rawPost.user_id,
      message: rawPost.message,
      rootId: rawPost.root_id || undefined,
      createdAt: new Date(rawPost.create_at),
    };
  }

  public async editMessage(input: EditMessageInput): Promise<EditMessageResult> {
    this.logger.debug(`Editing message '${input.postId}' via API...`);
    const rawPost = await this.client.patchPost(input.postId, input.message);
    return {
      id: rawPost.id,
      channelId: rawPost.channel_id,
      userId: rawPost.user_id,
      message: rawPost.message,
      updatedAt: new Date(rawPost.update_at || Date.now()),
    };
  }

  public async getMessages(input: GetMessagesInput): Promise<Post[]> {
    const rawList = await this.client.getPostsForChannel(
      input.channelId,
      0,
      input.limit || 30,
      input.since
    );

    // Mattermost returns order: string[] and posts: Record<string, Post>
    return rawList.order
      .map((id) => rawList.posts[id])
      .filter(Boolean)
      .map((p) => this.mapPost(p));
  }

  public async getPostThread(postId: string): Promise<{ order: string[]; posts: Record<string, Post> }> {
    const rawList = await this.client.getPostThread(postId);
    const posts: Record<string, Post> = {};
    for (const [id, rawPost] of Object.entries(rawList.posts || {})) {
      posts[id] = this.mapPost(rawPost);
    }
    return {
      order: rawList.order || [],
      posts,
    };
  }

  public async searchPosts(terms: string, options?: { teamId?: string; isOrSearch?: boolean }): Promise<Post[]> {
    const rawList = await this.client.searchPosts(terms, options?.teamId, options?.isOrSearch);
    if (!rawList || !rawList.order || !rawList.posts) {
      return [];
    }
    return rawList.order.map((id) => this.mapPost(rawList.posts[id])).filter(Boolean);
  }

  public async getUsersByIds(userIds: string[]): Promise<User[]> {
    const rawUsers = await this.client.getUsersByIds(userIds);
    return rawUsers.map((u) => this.mapUser(u));
  }

  public async getUnreadSummary(): Promise<UnreadSummaryResult> {
    const teams = await this.client.getMyTeams();
    const channels = await this.client.getMyChannels();

    let allMembers: any[] = [];
    for (const team of teams) {
      try {
        const members = await this.client.getChannelMembersForTeam(team.id);
        allMembers.push(...members);
      } catch (err) {
        this.logger.debug(`Could not fetch channel members for team ${team.id}`);
      }
    }

    const unreads: any[] = [];
    for (const m of allMembers) {
      const chan = channels.find((c) => c.id === m.channel_id);
      if (chan) {
        const unreadCount = Math.max(0, ((chan as any).total_msg_count || 0) - (m.msg_count || 0));
        const mentionCount = m.mention_count || 0;
        if (unreadCount > 0 || mentionCount > 0) {
          unreads.push({
            channelId: chan.id,
            channelName: chan.name,
            displayName: chan.display_name || chan.name,
            type: chan.type,
            teamId: chan.team_id,
            unreadCount,
            mentionCount,
            hasMention: mentionCount > 0,
          });
        }
      }
    }

    unreads.sort((a, b) => {
      if (a.hasMention !== b.hasMention) return a.hasMention ? -1 : 1;
      if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
      return b.unreadCount - a.unreadCount;
    });

    return {
      totalUnreadChannels: unreads.length,
      channels: unreads,
    };
  }

  public async getPost(postId: string): Promise<Post> {
    const rawPost = await this.client.getPost(postId);
    return this.mapPost(rawPost);
  }

  public async getChannelPosts(
    channelId: string,
    options: { before?: string; after?: string; limit?: number }
  ): Promise<Post[]> {
    const rawList = await this.client.getChannelPostsContext(channelId, {
      before: options.before,
      after: options.after,
      perPage: options.limit,
    });
    if (!rawList || !rawList.order || !rawList.posts) {
      return [];
    }
    return rawList.order.map((id) => this.mapPost(rawList.posts[id])).filter(Boolean);
  }

  public async getUser(usernameOrId: string): Promise<UserProfileResult> {
    const rawUser = await this.client.getUser(usernameOrId);
    return {
      id: rawUser.id,
      username: rawUser.username,
      email: rawUser.email,
      firstName: rawUser.first_name,
      lastName: rawUser.last_name,
      nickname: rawUser.nickname,
      position: rawUser.position,
      roles: rawUser.roles,
      createAt: rawUser.create_at,
    };
  }

  public async downloadFile(fileId: string, outputDir: string, maxSizeBytes?: number): Promise<FileDownloadResult> {
    const cleanId = fileId.trim();
    if (!/^[a-z0-9]{26}$/i.test(cleanId)) {
      throw new MattermostValidationError(`Invalid file ID '${fileId}'. Expected 26-character alphanumeric string.`);
    }

    const info = await this.client.getFileInfo(cleanId);
    if (!info) {
      throw new MattermostValidationError(`File with ID '${cleanId}' not found.`);
    }

    const maxLimit = maxSizeBytes ?? 50 * 1024 * 1024;
    if (info.size && info.size > maxLimit) {
      throw new MattermostValidationError(
        `File size (${info.size} bytes) exceeds maximum allowed limit of ${maxLimit} bytes.`
      );
    }

    const rawName = info.name || `file_${cleanId}`;
    const safeName = path.basename(rawName).replace(/[/\\?%*:|"<>]/g, '_');
    const resolvedDir = path.resolve(outputDir);
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }
    const finalPath = path.resolve(resolvedDir, safeName);
    if (!finalPath.startsWith(resolvedDir)) {
      throw new MattermostValidationError('Path traversal attempt detected in filename.');
    }

    const buffer = await this.client.downloadFileData(cleanId);
    if (buffer.length > maxLimit) {
      throw new MattermostValidationError(
        `Downloaded file size (${buffer.length} bytes) exceeds maximum allowed limit of ${maxLimit} bytes.`
      );
    }

    fs.writeFileSync(finalPath, buffer);
    return {
      fileId: cleanId,
      filename: safeName,
      mimeType: info.mime_type || 'application/octet-stream',
      size: buffer.length,
      savedPath: finalPath,
    };
  }

  public async addReaction(postId: string, emojiName: string): Promise<ReactionResult> {
    const me = await this.getMe();
    const cleanEmoji = emojiName.trim().replace(/^:|:$/g, '');
    const raw = await this.client.addReaction(me.id, postId, cleanEmoji);
    return {
      userId: raw.user_id,
      postId: raw.post_id,
      emojiName: raw.emoji_name,
      createAt: raw.create_at || Date.now(),
    };
  }
}
