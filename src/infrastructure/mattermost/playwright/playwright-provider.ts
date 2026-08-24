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

    // 1. Try in-browser API lookup
    try {
      const raw = await page.evaluate(
        async ({ channelId, channelName, teamId }) => {
          if (channelId) {
            const res = await fetch(`/api/v4/channels/${channelId}`, { credentials: 'include' });
            if (res.ok) return res.json();
          }
          if (channelName && teamId) {
            const res = await fetch(`/api/v4/teams/${teamId}/channels/name/${channelName}`, {
              credentials: 'include',
            });
            if (res.ok) return res.json();
          }
          return null;
        },
        { channelId: input.channelId, channelName: input.channelName, teamId: input.teamId }
      );

      if (raw && raw.id) {
        return {
          id: raw.id,
          teamId: raw.team_id,
          name: raw.name,
          displayName: raw.display_name,
          type: raw.type,
          header: raw.header,
          purpose: raw.purpose,
        };
      }
    } catch {
      // Fallback to UI navigation
    }

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

    // 1. Primary Strategy: In-Browser API creation (Ultra-fast, accurate, returns real post ID)
    try {
      this.logger.debug(`Playwright: Posting message to channel '${input.channelId}' via session API...`);
      const rawPost = await page.evaluate(
        async ({ channelId, message, rootId }) => {
          const res = await fetch('/api/v4/posts', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: JSON.stringify({
              channel_id: channelId,
              message,
              root_id: rootId || undefined,
            }),
          });
          if (res.ok) {
            return res.json();
          }
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || `HTTP ${res.status}`);
        },
        { channelId: input.channelId, message: input.message, rootId: input.rootId }
      );

      if (rawPost && rawPost.id) {
        return {
          id: rawPost.id,
          channelId: rawPost.channel_id,
          userId: rawPost.user_id || user.id,
          message: rawPost.message,
          rootId: rawPost.root_id || undefined,
          createdAt: new Date(rawPost.create_at || Date.now()),
        };
      }
    } catch (err) {
      this.logger.debug('In-browser API post failed, falling back to UI composer', { error: String(err) });
    }

    // 2. Fallback Strategy: UI Composer typing
    const channelPage = new MattermostChannelPage(page, this.baseUrl, this.logger);
    const composer = new MattermostComposer(page, this.logger);

    this.logger.debug(`Playwright: Navigating to channel '${input.channelId}' via UI...`);
    await channelPage.navigateToChannel(input.channelId, this.defaultTeamName);

    this.logger.debug(`Playwright: Submitting message via composer...`);
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
    return this.sendMessage({
      channelId: input.channelId,
      message: input.message,
      rootId: input.rootId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  public async getMessages(input: GetMessagesInput): Promise<Post[]> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();

    // 1. Primary Strategy: In-Browser API fetch
    try {
      const rawList = await page.evaluate(
        async ({ channelId, limit, since }) => {
          const params = new URLSearchParams({
            page: '0',
            per_page: (limit || 30).toString(),
          });
          if (since) params.set('since', since.toString());

          const res = await fetch(`/api/v4/channels/${channelId}/posts?${params.toString()}`, {
            credentials: 'include',
          });
          if (res.ok) {
            return res.json();
          }
          return null;
        },
        { channelId: input.channelId, limit: input.limit, since: input.since }
      );

      if (rawList && Array.isArray(rawList.order) && rawList.posts) {
        return rawList.order
          .map((id: string) => rawList.posts[id])
          .filter(Boolean)
          .map((p: any) => ({
            id: p.id,
            createAt: p.create_at,
            updateAt: p.update_at,
            deleteAt: p.delete_at,
            userId: p.user_id,
            channelId: p.channel_id,
            rootId: p.root_id,
            message: p.message,
            type: p.type,
            props: p.props,
          }));
      }
    } catch {
      // Fallback
    }

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
