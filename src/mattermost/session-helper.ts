import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

export interface ResolvedAuthSession {
  token: string;
  source: 'env_token' | 'browser_session';
  userId?: string;
  username?: string;
}

/**
 * Automatically resolves a valid Mattermost authentication token by checking:
 * 1. Explicit MATTERMOST_TOKEN environment variable or parameter.
 * 2. Persistent Playwright browser session (`MMAUTHTOKEN` cookie from `./data/mattermost-browser`).
 */
export async function resolveAuthSession(options?: {
  explicitToken?: string;
  profileDir?: string;
}): Promise<ResolvedAuthSession> {
  // 1. Check explicit token
  const envToken = options?.explicitToken || process.env.MATTERMOST_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return {
      token: envToken.trim(),
      source: 'env_token',
    };
  }

  // 2. Check persistent browser session directory
  const profileDir = options?.profileDir || path.resolve(process.cwd(), './data/mattermost-browser');
  if (fs.existsSync(profileDir)) {
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
      });

      const cookies = await context.cookies();
      const authCookie = cookies.find((c) => c.name === 'MMAUTHTOKEN');
      const userCookie = cookies.find((c) => c.name === 'MMUSERID');

      await context.close();

      if (authCookie && authCookie.value && authCookie.value.trim().length > 0) {
        return {
          token: authCookie.value.trim(),
          source: 'browser_session',
          userId: userCookie?.value,
        };
      }
    } catch (err: any) {
      console.warn(`[WARN] Could not read browser session cookies: ${err.message}`);
    }
  }

  throw new Error(
    'No active Mattermost session or token found.\n' +
      'Please do one of the following:\n' +
      ' 1. Log in via browser: npm run cli -- login\n' +
      ' 2. Or set MATTERMOST_TOKEN in your .env file with a Personal Access Token.'
  );
}
