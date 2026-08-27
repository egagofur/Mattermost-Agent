import { loadAgentConfig, sanitizeAgentConfig } from './config/agent-config';
import { MattermostClient } from './mattermost/client';
import { AgentStateManager } from './state/state-manager';
import { AgentExecutor, MockAgentExecutor, HermesAgentExecutor } from './agent/executor';
import { MattermostAgentListener } from './mattermost/listener';
import { createAIProvider } from './ai/provider';
import { resolveAuthSession } from './mattermost/session-helper';

/**
 * Creates the appropriate task executor based on configuration.
 */
export function createDefaultExecutor(config: ReturnType<typeof loadAgentConfig>): AgentExecutor {
  if (config.AI_PROVIDER === 'hermes') {
    return new HermesAgentExecutor({
      cliPath: config.HERMES_CLI_PATH,
      invocationMode: config.HERMES_INVOCATION_MODE,
      containerName: config.HERMES_CONTAINER_NAME,
      apiUrl: config.HERMES_API_URL,
      model: config.HERMES_MODEL,
      yolo: config.HERMES_YOLO,
    });
  }

  if (config.AI_PROVIDER === 'openai' || config.AI_PROVIDER === 'gemini') {
    const aiProvider = createAIProvider(config.AI_PROVIDER, config.AI_API_KEY || config.OPENAI_API_KEY || config.GEMINI_API_KEY);
    return {
      execute: async (task) => {
        const response = await aiProvider.generate(task.instruction, task.threadContext);
        return { success: true, message: response };
      },
    };
  }

  // Default: MockAgentExecutor for local dev & testing
  return new MockAgentExecutor();
}

export async function runAgent(customExecutor?: AgentExecutor): Promise<MattermostAgentListener> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 Starting Mattermost Agent (Interface & Integration Layer)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Load configuration
  const config = loadAgentConfig();
  console.log('[INFO] Loaded configuration:', sanitizeAgentConfig(config));

  // 2. Automatically resolve authentication (from MATTERMOST_TOKEN or browser session)
  const authSession = await resolveAuthSession({
    explicitToken: config.MATTERMOST_TOKEN,
    profileDir: config.MATTERMOST_BROWSER_PROFILE_DIR,
  });

  if (authSession.source === 'browser_session') {
    console.log('[INFO] Using active session token from Playwright browser profile.');
  }

  // 3. Initialize Mattermost REST Client
  const client = new MattermostClient({
    baseUrl: config.MATTERMOST_URL,
    token: authSession.token,
  });

  // 3. Initialize Local State Manager
  const stateManager = new AgentStateManager({
    filePath: config.STATE_FILE_PATH,
  });

  // 4. Initialize Task Executor (MockAgentExecutor by default, ready for Hermes)
  const executor = customExecutor || createDefaultExecutor(config);

  // 5. Initialize Listener
  const listener = new MattermostAgentListener({
    client,
    stateManager,
    executor,
    username: config.MATTERMOST_USERNAME,
    pollIntervalSeconds: config.MATTERMOST_POLL_INTERVAL,
  });

  // 6. Verify authentication & start polling loop
  await listener.initialize();
  await listener.start();

  // 7. Setup graceful shutdown handlers
  const shutdown = () => {
    console.log('\n[INFO] Graceful shutdown requested...');
    listener.stop();
    stateManager.save();
    console.log('[INFO] Mattermost Agent stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return listener;
}

// Auto-run if executed directly
if (require.main === module) {
  runAgent().catch((err) => {
    console.error(`\n❌ [FATAL] Agent failed to start: ${err.message}`);
    process.exit(1);
  });
}
