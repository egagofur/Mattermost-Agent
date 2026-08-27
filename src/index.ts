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

// Cron & Scheduling Engine
export { CronConfigLoader } from './infrastructure/mattermost/cron/cron-config-loader';
export type { CronConfigLoaderOptions } from './infrastructure/mattermost/cron/cron-config-loader';
export { CronSchedulerEngine } from './infrastructure/mattermost/cron/cron-scheduler-engine';
export type { CronSchedulerEngineOptions } from './infrastructure/mattermost/cron/cron-scheduler-engine';
export { CronStateManager } from './infrastructure/mattermost/cron/cron-state-manager';
export * from './infrastructure/mattermost/cron/cron-config-schema';

// MCP Server (Model Context Protocol)
export { createMattermostMcpServer, runStdioMcpServer } from './mcp/server';

// Web Dashboard & REST API Server
export { MattermostHttpServer, startMattermostHttpServer } from './ui/server';
export type { HttpServerOptions } from './ui/server';

// Mattermost Agent & Task Executor Layer (Hermes-Ready Architecture)
export { MattermostClient } from './mattermost/client';
export type { MattermostClientOptions, MattermostPost, MattermostUser, MattermostChannel } from './mattermost/client';
export { MattermostAgentListener } from './mattermost/listener';
export type { ListenerOptions } from './mattermost/listener';
export { hasMention, extractInstruction, createMentionRegex } from './mattermost/mentions';
export { AgentStateManager } from './state/state-manager';
export type { AgentStateData, StateManagerOptions } from './state/state-manager';
export { createAgentTask } from './agent/task';
export type { AgentTask, ThreadMessage, CreateAgentTaskParams } from './agent/task';
export { MockAgentExecutor } from './agent/executor';
export type { AgentExecutor, AgentResult, MockExecuteHandler } from './agent/executor';
export { OpenAIProvider, GeminiProvider, MockAIProvider, createAIProvider } from './ai/provider';
export type { AIProvider, ThreadContextMessage } from './ai/provider';
export { loadAgentConfig, sanitizeAgentConfig } from './config/agent-config';
export type { AgentConfig } from './config/agent-config';
export { runAgent, createDefaultExecutor } from './agent';


