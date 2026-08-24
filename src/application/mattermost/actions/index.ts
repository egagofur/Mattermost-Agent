import { Channel, Post, SendMessageResult, User } from '../../../domain/mattermost/entities';
import {
  MattermostAuthenticationError,
  MattermostError,
  MattermostIdentityMismatchError,
  MattermostValidationError,
} from '../../../domain/mattermost/errors';
import { MattermostProvider } from '../../../domain/mattermost/providers/mattermost-provider.interface';
import { ChannelResolver } from '../../../infrastructure/mattermost/services/channel-resolver';
import { IdempotencyManager } from '../../../infrastructure/mattermost/services/idempotency';
import { Logger, defaultLogger } from '../../../infrastructure/mattermost/services/logger';
import { formatMessageWithAttribution } from '../../../infrastructure/mattermost/services/message-formatter';
import { ThreadService } from '../../../infrastructure/mattermost/services/thread-service';
import {
  ActionResult,
  GetChannelAction,
  MattermostAction,
  MattermostActionSchema,
  ReadChannelAction,
  ReplyToMessageAction,
  SendMessageAction,
  WhoamiAction,
} from '../dto/action-schemas';

export interface ActionExecutorDependencies {
  provider: MattermostProvider;
  channelResolver: ChannelResolver;
  idempotencyManager: IdempotencyManager;
  threadService?: ThreadService;
  logger?: Logger;
  defaultFrom?: string;
  expectedUserId?: string;
  expectedUsername?: string;
}

export class ActionExecutor {
  private provider: MattermostProvider;
  private channelResolver: ChannelResolver;
  private idempotencyManager: IdempotencyManager;
  private threadService: ThreadService;
  private logger: Logger;
  private defaultFrom?: string;
  private expectedUserId?: string;
  private expectedUsername?: string;

  constructor(deps: ActionExecutorDependencies) {
    this.provider = deps.provider;
    this.channelResolver = deps.channelResolver;
    this.idempotencyManager = deps.idempotencyManager;
    this.logger = deps.logger ?? defaultLogger;
    this.threadService = deps.threadService ?? new ThreadService(deps.provider, this.logger);
    this.defaultFrom = deps.defaultFrom;
    this.expectedUserId = deps.expectedUserId;
    this.expectedUsername = deps.expectedUsername;
  }

  public setProvider(provider: MattermostProvider): void {
    this.provider = provider;
    this.channelResolver.setProvider(provider);
  }

  /**
   * Validates and executes an arbitrary action payload, safely catching and mapping errors.
   */
  public async execute(rawPayload: unknown): Promise<ActionResult> {
    const startTime = Date.now();
    let actionName = 'unknown';

    try {
      // 1. Validate payload
      const parseResult = MattermostActionSchema.safeParse(rawPayload);
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map((i) => `[${i.path.join('.')}] ${i.message}`).join('; ');
        throw new MattermostValidationError(`Invalid action payload: ${issues}`);
      }

      const action = parseResult.data;
      actionName = action.action;

      this.logger.event('mattermost.action.start', {
        action: actionName,
        channel: 'channel' in action ? action.channel : undefined,
      });

      let resultData: unknown;

      switch (action.action) {
        case 'send_message':
          resultData = await this.handleSendMessage(action);
          break;
        case 'reply_to_message':
          resultData = await this.handleReplyToMessage(action);
          break;
        case 'read_channel':
          resultData = await this.handleReadChannel(action);
          break;
        case 'get_channel':
          resultData = await this.handleGetChannel(action);
          break;
        case 'whoami':
          resultData = await this.handleWhoami(action);
          break;
      }

      const durationMs = Date.now() - startTime;
      this.logger.event('mattermost.action.success', {
        action: actionName,
        durationMs,
      });

      return {
        success: true,
        data: resultData,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;

      if (err instanceof MattermostError) {
        this.logger.event('mattermost.action.failed', {
          action: actionName,
          errorCode: err.code,
          durationMs,
        });

        return {
          success: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        };
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.event('mattermost.action.failed', {
        action: actionName,
        errorCode: 'UNHANDLED_ERROR',
        durationMs,
      });

      return {
        success: false,
        error: {
          code: 'UNHANDLED_ERROR',
          message: errorMessage,
        },
      };
    }
  }

  public async handleWhoami(_action: WhoamiAction): Promise<User> {
    const user = await this.provider.getMe();

    // Verify identity if expected ID or username is configured
    if (this.expectedUserId && user.id !== this.expectedUserId) {
      throw new MattermostIdentityMismatchError(this.expectedUserId, user.id);
    }

    if (this.expectedUsername && user.username.toLowerCase() !== this.expectedUsername.toLowerCase()) {
      throw new MattermostAuthenticationError(
        `Authenticated username '${user.username}' does not match expected username '${this.expectedUsername}'.`
      );
    }

    return user;
  }

  public async handleGetChannel(action: GetChannelAction): Promise<Channel> {
    this.logger.event('mattermost.channel.resolve', { channel: action.channel });
    return this.channelResolver.resolve(action.channel, action.teamId);
  }

  public async handleSendMessage(action: SendMessageAction): Promise<SendMessageResult> {
    const resolvedChannel = await this.channelResolver.resolve(action.channel, action.teamId);

    // If channel mapping has default_root_id and no rootId provided, apply it
    let targetRootId = action.rootId;
    if (!targetRootId) {
      const mapping = this.channelResolver.getConfigLoader().getMapping(action.channel);
      if (mapping?.defaultRootId) {
        targetRootId = mapping.defaultRootId;
      }
    }

    const effectiveFrom = action.from !== undefined ? action.from : this.defaultFrom;
    const formattedMessage = formatMessageWithAttribution(action.message, effectiveFrom);

    const idempotencyKey = action.idempotencyKey || `send:${resolvedChannel.id}:${targetRootId || 'root'}:${formattedMessage}`;

    return this.idempotencyManager.execute(idempotencyKey, async () => {
      this.logger.event('mattermost.message.send', {
        channelId: resolvedChannel.id,
        hasRootId: Boolean(targetRootId),
        from: effectiveFrom,
      });

      const result = await this.provider.sendMessage({
        channelId: resolvedChannel.id,
        message: formattedMessage,
        rootId: targetRootId,
        idempotencyKey,
      });

      this.threadService.saveLastThread({
        messageId: result.id,
        channelId: resolvedChannel.id,
        rootId: targetRootId,
        channelName: resolvedChannel.name,
        updatedAt: new Date().toISOString(),
      });

      return result;
    });
  }

  public async handleReplyToMessage(action: ReplyToMessageAction): Promise<SendMessageResult> {
    const resolvedChannel = await this.channelResolver.resolve(action.channel, action.teamId);

    const mapping = this.channelResolver.getConfigLoader().getMapping(action.channel);
    const resolvedRootId = await this.threadService.resolveRootId({
      channelId: resolvedChannel.id,
      targetIdentifier: action.rootId,
      defaultRootId: mapping?.defaultRootId,
    });

    const effectiveFrom = action.from !== undefined ? action.from : this.defaultFrom;
    const formattedMessage = formatMessageWithAttribution(action.message, effectiveFrom);

    const idempotencyKey = action.idempotencyKey || `reply:${resolvedChannel.id}:${resolvedRootId}:${formattedMessage}`;

    return this.idempotencyManager.execute(idempotencyKey, async () => {
      this.logger.event('mattermost.message.send', {
        channelId: resolvedChannel.id,
        rootId: resolvedRootId,
        from: effectiveFrom,
      });

      const result = await this.provider.replyToMessage({
        channelId: resolvedChannel.id,
        rootId: resolvedRootId,
        message: formattedMessage,
        idempotencyKey,
      });

      this.threadService.saveLastThread({
        messageId: result.id,
        channelId: resolvedChannel.id,
        rootId: resolvedRootId,
        channelName: resolvedChannel.name,
        updatedAt: new Date().toISOString(),
      });

      return result;
    });
  }

  public async handleReadChannel(action: ReadChannelAction): Promise<{ channel: Channel; messages: Post[] }> {
    const resolvedChannel = await this.channelResolver.resolve(action.channel, action.teamId);

    const messages = await this.provider.getMessages({
      channelId: resolvedChannel.id,
      limit: action.limit,
      since: action.since,
    });

    return {
      channel: resolvedChannel,
      messages,
    };
  }
}
