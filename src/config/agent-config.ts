import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { z } from 'zod';

// Load .env files if present
dotenv.config();

const pkgRoot = path.resolve(__dirname, '../../');
const homeEnv = path.resolve(process.env.HOME || '', '.mattermost/.env');

if (fs.existsSync(path.resolve(pkgRoot, '.env'))) {
  dotenv.config({ path: path.resolve(pkgRoot, '.env') });
}
if (fs.existsSync(homeEnv)) {
  dotenv.config({ path: homeEnv });
}

export const AgentConfigSchema = z.object({
  MATTERMOST_URL: z
    .string({ required_error: 'MATTERMOST_URL is required.' })
    .min(1, 'MATTERMOST_URL cannot be empty.')
    .url('MATTERMOST_URL must be a valid URL (e.g. https://mattermost.example.com)')
    .transform((url) => url.replace(/\/+$/, '')), // remove trailing slash

  MATTERMOST_TOKEN: z
    .string({ required_error: 'MATTERMOST_TOKEN is required.' })
    .min(1, 'MATTERMOST_TOKEN cannot be empty.'),

  MATTERMOST_USERNAME: z
    .string({ required_error: 'MATTERMOST_USERNAME is required.' })
    .min(1, 'MATTERMOST_USERNAME cannot be empty.')
    .transform((u) => u.replace(/^@/, '').toLowerCase().trim()), // strip leading @ and normalize

  MATTERMOST_POLL_INTERVAL: z
    .union([z.number(), z.string()])
    .optional()
    .default(5)
    .transform((val) => {
      const num = typeof val === 'number' ? val : Number(val);
      return isNaN(num) || num <= 0 ? 5 : num;
    }),

  AI_PROVIDER: z
    .enum(['hermes', 'openai', 'gemini', 'mock'])
    .default('hermes'),

  HERMES_CLI_PATH: z.string().optional().default('hermes'),
  HERMES_INVOCATION_MODE: z.enum(['cli', 'docker', 'http']).default('cli'),
  HERMES_CONTAINER_NAME: z.string().default('hermes-agent'),
  HERMES_API_URL: z.string().default('http://localhost:8000'),
  HERMES_PROFILE: z.literal('mattermost-agent').default('mattermost-agent'),
  HERMES_YOLO: z.literal(false).default(false),

  AI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),

  STATE_FILE_PATH: z
    .string()
    .default('./data/agent-state.json')
    .transform((p) => path.resolve(process.cwd(), p)),

  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Loads and validates configuration for the Mattermost AI Agent.
 * Throws a clean descriptive error if required environment variables are missing.
 */
export function loadAgentConfig(overrides?: Partial<Record<string, string | number | undefined>>): AgentConfig {
  const rawEnv = {
    MATTERMOST_URL: process.env.MATTERMOST_URL,
    MATTERMOST_TOKEN: process.env.MATTERMOST_TOKEN,
    MATTERMOST_USERNAME: process.env.MATTERMOST_USERNAME,
    MATTERMOST_POLL_INTERVAL: process.env.MATTERMOST_POLL_INTERVAL,
    AI_PROVIDER: process.env.AI_PROVIDER,
    HERMES_CLI_PATH: process.env.HERMES_CLI_PATH,
    HERMES_INVOCATION_MODE: process.env.HERMES_INVOCATION_MODE,
    HERMES_CONTAINER_NAME: process.env.HERMES_CONTAINER_NAME,
    HERMES_API_URL: process.env.HERMES_API_URL,
    HERMES_PROFILE: process.env.HERMES_PROFILE,
    HERMES_YOLO: process.env.HERMES_YOLO !== undefined ? process.env.HERMES_YOLO === 'true' || process.env.HERMES_YOLO === '1' : undefined,
    AI_API_KEY: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    STATE_FILE_PATH: process.env.STATE_FILE_PATH,
    LOG_LEVEL: process.env.LOG_LEVEL,
    ...overrides,
  };

  const parsed = AgentConfigSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((i) => ` - [${i.path.join('.')}]: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid Mattermost Agent Configuration:\n${errorDetails}`);
  }

  return parsed.data;
}

/**
 * Sanitizes config object for safe logging without exposing credentials.
 */
export function sanitizeAgentConfig(config: AgentConfig): Record<string, unknown> {
  return {
    MATTERMOST_URL: config.MATTERMOST_URL,
    MATTERMOST_USERNAME: `@${config.MATTERMOST_USERNAME}`,
    MATTERMOST_POLL_INTERVAL: `${config.MATTERMOST_POLL_INTERVAL}s`,
    AI_PROVIDER: config.AI_PROVIDER,
    STATE_FILE_PATH: config.STATE_FILE_PATH,
    MATTERMOST_TOKEN: config.MATTERMOST_TOKEN ? '[REDACTED]' : undefined,
    AI_API_KEY: config.AI_API_KEY ? '[REDACTED]' : undefined,
  };
}
