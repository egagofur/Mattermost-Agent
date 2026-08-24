// Public Application Service & Facade
export { MattermostAutomationService } from './application/mattermost/services/automation-service';
export type { AutomationServiceOptions } from './application/mattermost/services/automation-service';
export { ActionExecutor } from './application/mattermost/actions';
export type { ActionExecutorDependencies } from './application/mattermost/actions';
export * from './application/mattermost/dto/action-schemas';

// Domain Entities, Types & Errors
export * from './domain/mattermost/entities';
export * from './domain/mattermost/errors';
export type { MattermostProvider } from './domain/mattermost/providers/mattermost-provider.interface';

// Configuration
export * from './config';

// Infrastructure & Providers
export { MattermostApiClient } from './infrastructure/mattermost/api/client';
export type { ApiClientOptions } from './infrastructure/mattermost/api/client';
export { MattermostApiProvider } from './infrastructure/mattermost/api/api-provider';
export { MattermostWebClient } from './infrastructure/mattermost/playwright/web-client';
export type { WebClientOptions } from './infrastructure/mattermost/playwright/web-client';
export { MattermostPlaywrightProvider } from './infrastructure/mattermost/playwright/playwright-provider';
export type { PlaywrightProviderOptions } from './infrastructure/mattermost/playwright/playwright-provider';
export { ChannelResolver } from './infrastructure/mattermost/services/channel-resolver';
export type { ChannelResolverOptions } from './infrastructure/mattermost/services/channel-resolver';
export { ChannelConfigLoader } from './infrastructure/mattermost/services/channel-config-loader';
export type {
  ChannelConfigLoaderOptions,
  ChannelDefinition,
  ChannelDefinitionObject,
  NormalizedChannelMapping,
  RawChannelMappingConfig,
} from './infrastructure/mattermost/services/channel-config-loader';
export { ChannelSyncService } from './infrastructure/mattermost/services/channel-sync-service';
export type { ChannelSyncOptions, ChannelSyncResult } from './infrastructure/mattermost/services/channel-sync-service';
export { IdempotencyManager } from './infrastructure/mattermost/services/idempotency';
export type { IdempotencyOptions } from './infrastructure/mattermost/services/idempotency';
export { ThreadService } from './infrastructure/mattermost/services/thread-service';
export type { ThreadSummary, LastThreadState } from './infrastructure/mattermost/services/thread-service';
export { formatMessageWithAttribution } from './infrastructure/mattermost/services/message-formatter';
export { Logger, defaultLogger } from './infrastructure/mattermost/services/logger';
export type { LogLevel, StructuredLogPayload } from './infrastructure/mattermost/services/logger';
