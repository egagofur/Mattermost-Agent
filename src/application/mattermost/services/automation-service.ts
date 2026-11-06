import { loadConfig, MattermostConfig } from '../../../config/env';
import {
  Channel,
  EditMessageResult,
  FileDownloadResult,
  MentionsResult,
  Post,
  PostContextResult,
  SearchFilterOptions,
  SearchPostsResult,
  SendMessageResult,
  ThreadViewResult,
  UnreadSummaryResult,
  User,
  UserProfileResult,
} from '../../../domain/mattermost/entities';
import { MattermostProvider } from '../../../domain/mattermost/providers/mattermost-provider.interface';
import { MattermostApiClient } from '../../../infrastructure/mattermost/api/client';
import { MattermostApiProvider } from '../../../infrastructure/mattermost/api/api-provider';
import { MattermostWebClient } from '../../../infrastructure/mattermost/playwright/web-client';
import { MattermostPlaywrightProvider } from '../../../infrastructure/mattermost/playwright/playwright-provider';
import { ChannelResolver } from '../../../infrastructure/mattermost/services/channel-resolver';
import { ChannelSyncOptions, ChannelSyncService } from '../../../infrastructure/mattermost/services/channel-sync-service';
import { ThreadService, ThreadSummary } from '../../../infrastructure/mattermost/services/thread-service';
import { CronSchedulerEngine } from '../../../infrastructure/mattermost/cron/cron-scheduler-engine';
import { CronJobSummary } from '../../../infrastructure/mattermost/cron/cron-config-schema';
import { IdempotencyManager } from '../../../infrastructure/mattermost/services/idempotency';
import { Logger } from '../../../infrastructure/mattermost/services/logger';
import { ActionExecutor } from '../actions';
import { ActionResult } from '../dto/action-schemas';

export interface AutomationServiceOptions {
  config?: MattermostConfig;
  provider?: MattermostProvider;
  logger?: Logger;
}

export class MattermostAutomationService {
  private config: MattermostConfig;
  private logger: Logger;
  private provider: MattermostProvider;
  private channelResolver: ChannelResolver;
  private idempotencyManager: IdempotencyManager;
  private actionExecutor: ActionExecutor;
  private webClient?: MattermostWebClient;
  private cronScheduler?: CronSchedulerEngine;

  constructor(options: AutomationServiceOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.logger = options.logger ?? new Logger(this.config.LOG_LEVEL);

    if (options.provider) {
      this.provider = options.provider;
    } else if (this.config.MATTERMOST_PROVIDER === 'playwright') {
      this.webClient = new MattermostWebClient({
        baseUrl: this.config.MATTERMOST_URL,
        profileDir: this.config.MATTERMOST_BROWSER_PROFILE_DIR,
        headless: this.config.MATTERMOST_HEADLESS,
        logger: this.logger,
      });

      this.provider = new MattermostPlaywrightProvider({
        webClient: this.webClient,
        baseUrl: this.config.MATTERMOST_URL,
        defaultTeamName: this.config.MATTERMOST_TEAM_NAME,
        logger: this.logger,
      });
    } else {
      // Default: API Provider
      const apiClient = new MattermostApiClient({
        baseUrl: this.config.MATTERMOST_URL,
        token: this.config.MATTERMOST_TOKEN || '',
        logger: this.logger,
      });

      this.provider = new MattermostApiProvider(apiClient, this.logger);
    }

    this.channelResolver = new ChannelResolver(this.provider, {
      defaultTeamId: this.config.MATTERMOST_TEAM_ID,
      channelsConfigPath: this.config.MATTERMOST_CHANNELS_CONFIG,
      envName: this.config.MATTERMOST_ENV,
      logger: this.logger,
    });

    this.idempotencyManager = new IdempotencyManager({
      logger: this.logger,
    });

    this.actionExecutor = new ActionExecutor({
      provider: this.provider,
      channelResolver: this.channelResolver,
      idempotencyManager: this.idempotencyManager,
      logger: this.logger,
      defaultFrom: this.config.MATTERMOST_DEFAULT_FROM,
      expectedUserId: this.config.MATTERMOST_EXPECTED_USER_ID,
      expectedUsername: this.config.MATTERMOST_EXPECTED_USERNAME,
    });
  }

  /**
   * Executes a domain action payload (e.g. from an AI agent or structured event).
   */
  public async executeAction(payload: unknown): Promise<ActionResult> {
    return this.actionExecutor.execute(payload);
  }

  /**
   * Performs identity check and validates the authenticated account.
   */
  public async whoami(): Promise<User> {
    const user = await this.actionExecutor.handleWhoami({ action: 'whoami' });
    this.logger.info(`Mattermost authenticated as: ${user.username} (${user.firstName || ''} ${user.lastName || ''})`.trim(), {
      userId: user.id,
      roles: user.roles,
    });
    return user;
  }

  /**
   * Sends a message to a channel as the personal account.
   */
  public async sendMessage(params: {
    channel: string;
    message: string;
    from?: string;
    rootId?: string;
    teamId?: string;
    idempotencyKey?: string;
  }): Promise<SendMessageResult> {
    return this.actionExecutor.handleSendMessage({
      action: 'send_message',
      channel: params.channel,
      message: params.message,
      from: params.from,
      rootId: params.rootId,
      teamId: params.teamId,
      idempotencyKey: params.idempotencyKey,
    });
  }

  /**
   * Replies to an existing thread.
   */
  public async replyToMessage(params: {
    channel: string;
    rootId: string;
    message: string;
    from?: string;
    teamId?: string;
    idempotencyKey?: string;
  }): Promise<SendMessageResult> {
    return this.actionExecutor.handleReplyToMessage({
      action: 'reply_to_message',
      channel: params.channel,
      rootId: params.rootId,
      message: params.message,
      from: params.from,
      teamId: params.teamId,
      idempotencyKey: params.idempotencyKey,
    });
  }

  /**
   * Edits an existing message by post ID or permalink URL.
   */
  public async editMessage(params: {
    postId: string;
    message: string;
    from?: string;
  }): Promise<EditMessageResult> {
    return this.actionExecutor.handleEditMessage({
      action: 'edit_message',
      postId: params.postId,
      message: params.message,
      from: params.from,
    });
  }

  /**
   * Resolves and retrieves channel metadata.
   */
  public async getChannel(channelIdentifier: string, teamId?: string): Promise<Channel> {
    return this.actionExecutor.handleGetChannel({
      action: 'get_channel',
      channel: channelIdentifier,
      teamId,
    });
  }

  /**
   * Discovers all accessible channels from the Mattermost server.
   */
  public async discoverChannels() {
    const syncService = new ChannelSyncService(this.provider, this.logger);
    return syncService.discoverChannels();
  }

  /**
   * Automatically discovers all channels on Mattermost and syncs them to channels.yml.
   */
  public async syncChannels(options?: ChannelSyncOptions) {
    const syncService = new ChannelSyncService(this.provider, this.logger);
    return syncService.syncToYaml(options);
  }

  /**
   * Returns all loaded channel aliases from YAML mapping.
   */
  public listChannelAliases() {
    return this.channelResolver.getAliases();
  }

  /**
   * Enables or disables a channel in channels.yml.
   */
  public toggleChannel(alias: string, enabled: boolean): boolean {
    return this.channelResolver.toggleChannel(alias, enabled);
  }

  /**
   * Reads recent messages from a channel.
   */
  public async readChannel(params: {
    channel: string;
    limit?: number;
    since?: number;
    teamId?: string;
  }): Promise<{ channel: Channel; messages: Post[] }> {
    return this.actionExecutor.handleReadChannel({
      action: 'read_channel',
      channel: params.channel,
      limit: params.limit ?? 30,
      since: params.since,
      teamId: params.teamId,
    });
  }

  /**
   * Discovers and summarizes active threads in a channel.
   */
  public async getThreads(params: {
    channel: string;
    limit?: number;
    query?: string;
    teamId?: string;
  }): Promise<{ channel: Channel; threads: ThreadSummary[] }> {
    const channel = await this.channelResolver.resolve(params.channel, params.teamId);
    const threadService = new ThreadService(this.provider, this.logger);
    const threads = await threadService.getChannelThreads(channel.id, params.limit || 50, params.query);
    return { channel, threads };
  }

  /**
   * Retrieves full sequential messages in a thread from a post ID or permalink URL.
   */
  public async getThread(permalinkOrId: string, limit?: number): Promise<ThreadViewResult> {
    return this.actionExecutor.handleGetThread({
      action: 'get_thread',
      permalinkOrId,
      limit: limit ?? 200,
    });
  }

  /**
   * Retrieves posts mentioning the authenticated user.
   */
  public async getMentions(params?: {
    since?: number;
    limit?: number;
    teamId?: string;
  }): Promise<MentionsResult> {
    return this.actionExecutor.handleGetMentions({
      action: 'get_mentions',
      since: params?.since,
      limit: params?.limit ?? 50,
      teamId: params?.teamId,
    });
  }

  /**
   * Searches posts matching terms and filters.
   */
  public async search(options: SearchFilterOptions): Promise<SearchPostsResult> {
    return this.actionExecutor.handleSearch({
      action: 'search',
      terms: options.terms,
      from: options.from,
      in: options.in,
      after: options.after,
      before: options.before,
      limit: options.limit ?? 20,
      teamId: options.teamId,
      isOrSearch: options.isOrSearch,
    });
  }

  /**
   * Retrieves summary of unread messages and mentions across channels.
   */
  public async getUnreadSummary(): Promise<UnreadSummaryResult> {
    return this.actionExecutor.handleUnreadSummary();
  }

  /**
   * Retrieves a single post and its surrounding contextual posts in the same channel.
   */
  public async getPostWithContext(postIdOrPermalink: string, context?: number): Promise<PostContextResult> {
    return this.actionExecutor.handleGetPost({
      action: 'get_post',
      postIdOrPermalink,
      context: context ?? 3,
    });
  }

  /**
   * Retrieves profile details for a given username or 26-char user ID.
   */
  public async getUser(usernameOrId: string): Promise<UserProfileResult> {
    return this.actionExecutor.handleGetUser({
      action: 'get_user',
      usernameOrId,
    });
  }

  /**
   * Securely downloads an attachment file to a local directory with path-traversal and file-size guardrails.
   */
  public async downloadFile(params: {
    fileId: string;
    outputDir?: string;
    maxSizeBytes?: number;
  }): Promise<FileDownloadResult> {
    return this.actionExecutor.handleGetFile({
      action: 'get_file',
      fileId: params.fileId,
      outputDir: params.outputDir,
      maxSizeBytes: params.maxSizeBytes,
    });
  }

  /**
   * Resolves channel identifier to Channel object without sending messages (used for previews/safety checks).
   */
  public async resolveChannel(channelIdentifier: string, teamId?: string): Promise<Channel> {
    return this.channelResolver.resolve(channelIdentifier, teamId);
  }

  /**
   * Returns or initializes the CronSchedulerEngine instance.
   */
  public getCronScheduler(): CronSchedulerEngine {
    if (!this.cronScheduler) {
      this.cronScheduler = new CronSchedulerEngine({
        automationService: this,
        logger: this.logger,
      });
    }
    return this.cronScheduler;
  }

  /**
   * Lists all configured cron jobs with current next/last execution status.
   */
  public listCronJobs(): CronJobSummary[] {
    return this.getCronScheduler().listJobSummaries();
  }

  /**
   * Manually runs a specific cron job immediately.
   */
  public async runCronJob(jobName: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return this.getCronScheduler().executeJob(jobName);
  }

  /**
   * Enables or disables a cron job in cron.yml.
   */
  public toggleCronJob(jobName: string, enabled: boolean): boolean {
    return this.getCronScheduler().getConfigLoader().toggleJob(jobName, enabled);
  }

  /**
   * Starts the continuous cron scheduler runner.
   */
  public startCronScheduler(attachSignals = false): void {
    this.getCronScheduler().start(attachSignals);
  }

  /**
   * Stops the continuous cron scheduler runner.
   */
  public stopCronScheduler(): void {
    if (this.cronScheduler) {
      this.cronScheduler.stop();
    }
  }

  /**
   * Interactive login helper for Playwright provider.
   */
  public async interactiveLogin(): Promise<void> {
    if (!this.webClient) {
      this.webClient = new MattermostWebClient({
        baseUrl: this.config.MATTERMOST_URL,
        profileDir: this.config.MATTERMOST_BROWSER_PROFILE_DIR,
        headless: false,
        logger: this.logger,
      });
    }
    await this.webClient.runInteractiveLogin();
  }

  /**
   * Clean up resources (e.g. closing browser session and stopping cron schedules).
   */
  public async close(): Promise<void> {
    if (this.cronScheduler) {
      this.cronScheduler.stop();
    }
    if (this.provider.close) {
      await this.provider.close();
    }
  }
}
