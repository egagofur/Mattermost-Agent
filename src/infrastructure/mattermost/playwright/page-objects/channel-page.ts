import { Page } from 'playwright';
import { MattermostChannelNotFoundError, MattermostProviderError } from '../../../../domain/mattermost/errors';
import { Logger, defaultLogger } from '../../services/logger';

export class MattermostChannelPage {
  private page: Page;
  private baseUrl: string;
  private logger: Logger;

  private readonly CHANNEL_HEADER_SELECTORS = [
    '#channelHeaderTitle',
    '[data-testid="channel-header-title"]',
    '.channel-header__title',
    'h1.channel-header__title',
  ];

  private readonly POST_SELECTORS = [
    '.post',
    '[data-testid="postView"]',
    '.post__body',
  ];

  constructor(page: Page, baseUrl: string, logger?: Logger) {
    this.page = page;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.logger = logger ?? defaultLogger;
  }

  public async navigateToChannel(channelName: string, teamName?: string): Promise<void> {
    const cleanChannel = channelName.trim().replace(/^~/, '');
    const isTeamId = teamName && /^[a-z0-9]{26}$/i.test(teamName);
    const effectiveTeam = isTeamId ? 'dot-indonesia' : teamName;
    const targetUrl = effectiveTeam
      ? `${this.baseUrl}/${encodeURIComponent(effectiveTeam)}/channels/${encodeURIComponent(cleanChannel)}`
      : `${this.baseUrl}/channels/${encodeURIComponent(cleanChannel)}`;

    this.logger.debug(`Navigating to channel URL: ${targetUrl}`);
    await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await this.waitForLoaded(cleanChannel);
  }

  public async waitForLoaded(channelIdentifier?: string): Promise<void> {
    // Check if redirected to login
    const currentUrl = this.page.url();
    if (currentUrl.includes('/login')) {
      throw new MattermostProviderError(
        'MATTERMOST_SESSION_EXPIRED: Redirected to login page. Please re-authenticate browser session.',
        'AUTHENTICATION_EXPIRED'
      );
    }

    // Wait for channel header or composer
    try {
      await Promise.race([
        this.page.waitForSelector('#post_textbox', { timeout: 15000 }),
        this.page.waitForSelector('#channelHeaderTitle', { timeout: 15000 }),
        this.page.waitForSelector('[data-testid="channel-header-title"]', { timeout: 15000 }),
      ]);
    } catch {
      // Check if page shows 404 or channel not found
      const pageText = await this.page.textContent('body');
      if (pageText?.includes("doesn't exist") || pageText?.includes('channel cannot be found')) {
        throw new MattermostChannelNotFoundError(channelIdentifier || 'unknown');
      }
      throw new MattermostProviderError(
        `Failed waiting for channel to load (${channelIdentifier || 'unknown'}).`,
        'CHANNEL_LOAD_TIMEOUT'
      );
    }
  }

  public async getChannelTitle(): Promise<string> {
    for (const selector of this.CHANNEL_HEADER_SELECTORS) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 1000 })) {
          const text = await el.innerText();
          if (text) return text.trim();
        }
      } catch {
        // try next
      }
    }
    return '';
  }

  public async getRecentPosts(limit = 10): Promise<Array<{ id: string; message: string; author: string; timestamp: Date }>> {
    const results: Array<{ id: string; message: string; author: string; timestamp: Date }> = [];

    try {
      const posts = await this.page.locator('.post').all();
      const recentPosts = posts.slice(-limit);

      for (const postEl of recentPosts) {
        const id = (await postEl.getAttribute('id')) || `post_${Date.now()}`;
        const messageEl = postEl.locator('.post__body, [data-testid="postContent"]').first();
        const authorEl = postEl.locator('.user-popover, .post__user-name').first();
        const timeEl = postEl.locator('time, .post__time').first();

        const message = (await messageEl.isVisible().catch(() => false)) ? (await messageEl.innerText()).trim() : '';
        const author = (await authorEl.isVisible().catch(() => false)) ? (await authorEl.innerText()).trim() : 'unknown';
        const timeText = (await timeEl.isVisible().catch(() => false)) ? (await timeEl.getAttribute('datetime')) || '' : '';

        if (message) {
          results.push({
            id: id.replace(/^post_/, ''),
            message,
            author,
            timestamp: timeText ? new Date(timeText) : new Date(),
          });
        }
      }
    } catch (err) {
      this.logger.debug('Error reading recent posts from DOM', { error: String(err) });
    }

    return results;
  }
}
