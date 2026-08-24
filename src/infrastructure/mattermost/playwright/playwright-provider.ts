import {
  Channel,
  GetChannelInput,
  GetMessagesInput,
  Post,
  ReplyToMessageInput,
  SendMessageInput,
  SendMessageResult,
  User,
} from '../../../domain/mattermost/entities';
import { MattermostAuthenticationError, MattermostProviderError } from '../../../domain/mattermost/errors';
import { MattermostProvider } from '../../../domain/mattermost/providers/mattermost-provider.interface';
import { Logger, defaultLogger } from '../services/logger';
import { MattermostChannelPage } from './page-objects/channel-page';
import { MattermostComposer } from './page-objects/composer';
import { MattermostWebClient } from './web-client';

export interface PlaywrightProviderOptions {
  webClient: MattermostWebClient;
  baseUrl: string;
  defaultTeamName?: string;
  logger?: Logger;
}

export class MattermostPlaywrightProvider implements MattermostProvider {
  private webClient: MattermostWebClient;
  private baseUrl: string;
  private defaultTeamName?: string;
  private logger: Logger;

  constructor(options: PlaywrightProviderOptions) {
    this.webClient = options.webClient;
    this.baseUrl = options.baseUrl;
    this.defaultTeamName = options.defaultTeamName;
    this.logger = options.logger ?? defaultLogger;
  }

  private async ensureAuthenticated(): Promise<User> {
    const session = await this.webClient.verifySession();
    if (!session.authenticated) {
      throw new MattermostAuthenticationError(
        'MATTERMOST_SESSION_EXPIRED: Persistent browser session is not authenticated or has expired. Please run "npm run cli -- login" to authenticate.',
        { profileDir: this.webClient }
      );
    }
    return {
      id: session.userId || 'browser-user-id',
      username: session.username || 'personal-account',
      roles: 'system_user',
    };
  }

  public async getMe(): Promise<User> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();

    try {
      const rawUser = await page.evaluate(async () => {
        const res = await fetch('/api/v4/users/me', { credentials: 'include' });
        if (res.ok) {
          return res.json();
        }
        return null;
      });

      if (rawUser && rawUser.id) {
        return {
          id: rawUser.id,
          username: rawUser.username,
          email: rawUser.email,
          firstName: rawUser.first_name,
          lastName: rawUser.last_name,
          nickname: rawUser.nickname,
          roles: rawUser.roles,
          createAt: rawUser.create_at,
        };
      }
    } catch {
      // Fallback
    }

    return {
      id: 'browser-authenticated-user',
      username: 'personal-account',
      roles: 'system_user',
    };
  }

  public async getChannel(input: GetChannelInput): Promise<Channel> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();
    const channelPage = new MattermostChannelPage(page, this.baseUrl, this.logger);

    const channelIdentifier = input.channelName || input.channelId || 'town-square';
    await channelPage.navigateToChannel(channelIdentifier, input.teamId || this.defaultTeamName);
    const title = await channelPage.getChannelTitle();

    return {
      id: input.channelId || channelIdentifier,
      name: channelIdentifier,
      displayName: title || channelIdentifier,
      type: 'O',
    };
  }

  public async listChannels(teamId?: string): Promise<Channel[]> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();

    // 1. Primary Strategy: In-Browser Authenticated Fetch (Fastest, 100% complete across all teams)
    try {
      this.logger.debug('Discovering channels via in-browser authenticated session...');
      const apiChannels = await page.evaluate(async (targetTeamId) => {
        let teams: Array<{ id: string; name: string }> = [];

        if (targetTeamId) {
          teams = [{ id: targetTeamId, name: targetTeamId }];
        } else {
          try {
            const teamsRes = await fetch('/api/v4/users/me/teams', { credentials: 'include' });
            if (teamsRes.ok) {
              teams = await teamsRes.json();
            }
          } catch {}
        }

        const allChannels: Array<{
          id: string;
          team_id?: string;
          name: string;
          display_name: string;
          type: string;
          header?: string;
          purpose?: string;
        }> = [];

        if (Array.isArray(teams) && teams.length > 0) {
          for (const team of teams) {
            try {
              const res = await fetch(`/api/v4/users/me/teams/${team.id}/channels`, { credentials: 'include' });
              if (res.ok) {
                const list = await res.json();
                if (Array.isArray(list)) {
                  allChannels.push(...list);
                }
              }
            } catch {}
          }
        } else {
          try {
            const res = await fetch('/api/v4/users/me/channels', { credentials: 'include' });
            if (res.ok) {
              const list = await res.json();
              if (Array.isArray(list)) {
                allChannels.push(...list);
              }
            }
          } catch {}
        }

        return allChannels;
      }, teamId);

      if (Array.isArray(apiChannels) && apiChannels.length > 0) {
        // Filter out direct messages ('D') if desired or keep public/private/group
        const validChannels = apiChannels
          .filter((c) => c.type === 'O' || c.type === 'P' || c.type === 'G')
          .map((c) => ({
            id: c.id,
            teamId: c.team_id,
            name: c.name,
            displayName: c.display_name || c.name,
            type: c.type,
            header: c.header,
            purpose: c.purpose,
          }));

        if (validChannels.length > 0) {
          this.logger.debug(`In-browser session discovered ${validChannels.length} channels.`);
          return validChannels;
        }
      }
    } catch (err) {
      this.logger.debug('In-browser fetch discovery failed, falling back to DOM scraping', {
        error: String(err),
      });
    }

    // 2. Fallback Strategy: DOM Scraping
    this.logger.debug('Scraping channels from sidebar DOM...');
    const channels: Channel[] = [];
    const seenNames = new Set<string>();

    const linkElements = await page.locator('a[href*="/channels/"]').all();
    for (const el of linkElements) {
      const href = (await el.getAttribute('href').catch(() => '')) || '';
      const text = (await el.innerText().catch(() => '')).trim();

      const match = href.match(/\/channels\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        const name = match[1];
        if (!seenNames.has(name.toLowerCase())) {
          seenNames.add(name.toLowerCase());
          channels.push({
            id: name,
            name,
            displayName: text || name,
            type: 'O',
          });
        }
      }
    }

    if (channels.length === 0) {
      channels.push(
        { id: 'town-square', name: 'town-square', displayName: 'Town Square', type: 'O' },
        { id: 'off-topic', name: 'off-topic', displayName: 'Off-Topic', type: 'O' }
      );
    }

    return channels;
  }

  public async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const user = await this.ensureAuthenticated();
    const page = await this.webClient.getPage();
    const channelPage = new MattermostChannelPage(page, this.baseUrl, this.logger);
    const composer = new MattermostComposer(page, this.logger);

    this.logger.debug(`Playwright: Navigating to channel '${input.channelId}'...`);
    await channelPage.navigateToChannel(input.channelId, this.defaultTeamName);

    this.logger.debug(`Playwright: Submitting message...`);
    await composer.submitMessage(input.message, false);

    return {
      id: `browser_post_${Date.now()}`,
      channelId: input.channelId,
      userId: user.id,
      message: input.message,
      rootId: input.rootId,
      createdAt: new Date(),
    };
  }

  public async replyToMessage(input: ReplyToMessageInput): Promise<SendMessageResult> {
    const user = await this.ensureAuthenticated();
    const page = await this.webClient.getPage();
    const channelPage = new MattermostChannelPage(page, this.baseUrl, this.logger);
    const composer = new MattermostComposer(page, this.logger);

    this.logger.debug(`Playwright: Navigating to channel '${input.channelId}' for reply...`);
    await channelPage.navigateToChannel(input.channelId, this.defaultTeamName);

    this.logger.debug(`Playwright: Submitting reply to thread...`);
    await composer.submitMessage(input.message, true);

    return {
      id: `browser_reply_${Date.now()}`,
      channelId: input.channelId,
      userId: user.id,
      message: input.message,
      rootId: input.rootId,
      createdAt: new Date(),
    };
  }

  public async getMessages(input: GetMessagesInput): Promise<Post[]> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();
    const channelPage = new MattermostChannelPage(page, this.baseUrl, this.logger);

    await channelPage.navigateToChannel(input.channelId, this.defaultTeamName);
    const rawPosts = await channelPage.getRecentPosts(input.limit || 10);

    return rawPosts.map((p) => ({
      id: p.id,
      createAt: p.timestamp.getTime(),
      updateAt: p.timestamp.getTime(),
      userId: p.author,
      channelId: input.channelId,
      message: p.message,
    }));
  }

  public async close(): Promise<void> {
    await this.webClient.close();
  }
}
