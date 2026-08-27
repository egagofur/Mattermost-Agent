import { loadAgentConfig, sanitizeAgentConfig } from './config/agent-config';
import { MattermostClient } from './mattermost/client';
import { AgentStateManager } from './state/state-manager';
import { createAIProvider } from './ai/provider';
import { MattermostAgentListener } from './mattermost/listener';

export async function runAgent(): Promise<MattermostAgentListener> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 Starting Mattermost AI Agent (Self-Triggering Personal Account)');
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

  // 4. Initialize AI Provider
  const aiProvider = createAIProvider(config.AI_PROVIDER, config.AI_API_KEY || config.OPENAI_API_KEY || config.GEMINI_API_KEY);

  // 5. Initialize Listener
  const listener = new MattermostAgentListener({
    client,
    stateManager,
    aiProvider,
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
    console.log('[INFO] Mattermost AI Agent stopped.');
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
