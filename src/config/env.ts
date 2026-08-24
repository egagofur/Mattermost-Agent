import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env if present
dotenv.config();

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((val) => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const lower = val.toLowerCase().trim();
      return lower === 'true' || lower === '1' || lower === 'yes';
    }
    return true; // default true for headless
  });

export const ConfigSchema = z
  .object({
    MATTERMOST_URL: z
      .string({ required_error: 'MATTERMOST_URL is required.' })
      .url('MATTERMOST_URL must be a valid URL (e.g. https://mattermost.example.com)')
      .transform((url) => url.replace(/\/+$/, '')), // remove trailing slash

    MATTERMOST_PROVIDER: z
      .enum(['api', 'playwright'])
      .default('playwright'),

    MATTERMOST_TOKEN: z.string().optional(),

    MATTERMOST_TEAM_ID: z.string().optional(),
    MATTERMOST_TEAM_NAME: z.string().optional(),

    MATTERMOST_EXPECTED_USER_ID: z.string().optional(),
    MATTERMOST_EXPECTED_USERNAME: z.string().optional(),

    MATTERMOST_CHANNELS_CONFIG: z.string().optional(),
    MATTERMOST_ENV: z.string().optional(),

    MATTERMOST_BROWSER_PROFILE_DIR: z
      .string()
      .default('./data/mattermost-browser')
      .transform((dir) => path.resolve(process.cwd(), dir)),

    MATTERMOST_HEADLESS: booleanFromString.default(true),

    LOG_LEVEL: z
      .enum(['debug', 'info', 'warn', 'error'])
      .default('info'),
  })
  .superRefine((data, ctx) => {
    if (data.MATTERMOST_PROVIDER === 'api' && (!data.MATTERMOST_TOKEN || data.MATTERMOST_TOKEN.trim() === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MATTERMOST_TOKEN is required when MATTERMOST_PROVIDER is "api".',
        path: ['MATTERMOST_TOKEN'],
      });
    }
  });

export type MattermostConfig = z.infer<typeof ConfigSchema>;

/**
 * Loads and validates configuration from environment variables or custom overrides.
 */
export function loadConfig(overrides?: Partial<Record<string, string | boolean | undefined>>): MattermostConfig {
  const rawEnv = {
    MATTERMOST_URL: process.env.MATTERMOST_URL,
    MATTERMOST_PROVIDER: process.env.MATTERMOST_PROVIDER,
    MATTERMOST_TOKEN: process.env.MATTERMOST_TOKEN,
    MATTERMOST_TEAM_ID: process.env.MATTERMOST_TEAM_ID,
    MATTERMOST_TEAM_NAME: process.env.MATTERMOST_TEAM_NAME,
    MATTERMOST_EXPECTED_USER_ID: process.env.MATTERMOST_EXPECTED_USER_ID,
    MATTERMOST_EXPECTED_USERNAME: process.env.MATTERMOST_EXPECTED_USERNAME,
    MATTERMOST_CHANNELS_CONFIG: process.env.MATTERMOST_CHANNELS_CONFIG,
    MATTERMOST_ENV: process.env.MATTERMOST_ENV,
    MATTERMOST_BROWSER_PROFILE_DIR: process.env.MATTERMOST_BROWSER_PROFILE_DIR,
    MATTERMOST_HEADLESS: process.env.MATTERMOST_HEADLESS,
    LOG_LEVEL: process.env.LOG_LEVEL,
    ...overrides,
  };

  const parsed = ConfigSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((i) => ` - [${i.path.join('.')}]: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid Mattermost Configuration:\n${errorDetails}`);
  }

  return parsed.data;
}

/**
 * Returns a sanitized copy of the config safe for logging.
 */
export function sanitizeConfig(config: MattermostConfig): Record<string, unknown> {
  return {
    ...config,
    MATTERMOST_TOKEN: config.MATTERMOST_TOKEN ? '[REDACTED]' : undefined,
  };
}
