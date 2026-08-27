import { loadAgentConfig, sanitizeAgentConfig } from './config/agent-config';
import { MattermostClient } from './mattermost/client';
import { AgentStateManager } from './state/state-manager';
import { AgentExecutor, MockAgentExecutor } from './agent/executor';
import { MattermostAgentListener } from './mattermost/listener';
import { createAIProvider } from './ai/provider';

/**
 * Creates the appropriate task executor.
 *
 * 🔌 EXTENSION POINT FOR FUTURE HERMES INTEGRATION:
 * When Hermes is developed, replace or extend this factory to return `new HermesAgentExecutor(...)`.
 * The Mattermost listener layer remains completely decoupled and untouched.
 */
export function createDefaultExecutor(config: ReturnType<typeof loadAgentConfig>): AgentExecutor {
  if (config.AI_PROVIDER === 'openai' || config.AI_PROVIDER === 'gemini') {
    const aiProvider = createAIProvider(config.AI_PROVIDER, config.AI_API_KEY || config.OPENAI_API_KEY || config.GEMINI_API_KEY);
    return {
      execute: async (task) => {
        const response = await aiProvider.generate(task.instruction, task.threadContext);
        return { success: true, message: response };
      },
    };
  }

  // Default: MockAgentExecutor for local dev, MVP, and Hermes testing
  return new MockAgentExecutor();
}

export async function runAgent(customExecutor?: AgentExecutor): Promise<MattermostAgentListener> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 Starting Mattermost Agent (Interface & Integration Layer)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Load configuration (fails fast if missing required env vars)
  const config = loadAgentConfig();
  console.log('[INFO] Loaded configuration:', sanitizeAgentConfig(config));

  // 2. Initialize Mattermost REST Client
  const client = new MattermostClient({
    baseUrl: config.MATTERMOST_URL,
    token: config.MATTERMOST_TOKEN,
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
