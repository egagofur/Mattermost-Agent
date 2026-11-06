import * as fs from 'fs';
import * as path from 'path';
import {
  Channel,
  EditMessageInput,
  EditMessageResult,
  FileDownloadResult,
  GetChannelInput,
  GetMessagesInput,
  Post,
  ReactionResult,
  ReplyToMessageInput,
  SendMessageInput,
  SendMessageResult,
  UnreadSummaryResult,
  User,
  UserProfileResult,
} from '../../../domain/mattermost/entities';
import {
  MattermostAuthenticationError,
  MattermostChannelNotFoundError,
  MattermostProviderError,
  MattermostValidationError,
} from '../../../domain/mattermost/errors';
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
    const channelIdentifier = input.channelName || input.channelId;
    if (!channelIdentifier) {
      throw new MattermostChannelNotFoundError('unknown', { reason: 'No channel name or channel ID provided.' });
    }
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
          const cookieMatch = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]*)/);
          const csrfToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          };
          if (csrfToken) {
            headers['X-CSRF-Token'] = csrfToken;
          }

          const res = await fetch('/api/v4/posts', {
            method: 'POST',
            credentials: 'include',
            headers,
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

  public async editMessage(input: EditMessageInput): Promise<EditMessageResult> {
    const user = await this.ensureAuthenticated();
    const page = await this.webClient.getPage();

    // 1. Primary Strategy: In-browser API patch (Fast & direct)
    try {
      this.logger.debug(`Playwright: Patching post '${input.postId}' via session API...`);
      const rawPost = await page.evaluate(
        async ({ postId, message }) => {
          const cookieMatch = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]*)/);
          const csrfToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          };
          if (csrfToken) {
            headers['X-CSRF-Token'] = csrfToken;
          }

          const res = await fetch(`/api/v4/posts/${encodeURIComponent(postId)}/patch`, {
            method: 'PUT',
            credentials: 'include',
            headers,
            body: JSON.stringify({
              id: postId,
              message,
            }),
          });

          if (res.ok) {
            return res.json();
          }
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || `HTTP ${res.status}`);
        },
        { postId: input.postId, message: input.message }
      );

      if (rawPost && rawPost.id) {
        return {
          id: rawPost.id,
          channelId: rawPost.channel_id,
          userId: rawPost.user_id || user.id,
          message: rawPost.message,
          updatedAt: new Date(rawPost.update_at || Date.now()),
        };
      }
    } catch (err) {
      this.logger.debug('In-browser API edit failed, falling back to UI DOM edit', { error: String(err) });
    }

    // 2. Fallback Strategy: UI Fallback via DOM
    this.logger.debug(`Playwright: Editing post '${input.postId}' via DOM UI...`);
    try {
      const postSelector = `#post_${input.postId}`;
      const postElement = page.locator(postSelector).first();
      await postElement.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

      // Hover over the post to reveal action menu
      await postElement.hover().catch(() => {});

      // Find and click the '...' (dot menu) or edit button
      const dotMenuButton = postElement
        .locator('button[id*="CENTER_button_"], button.post-menu__item, [data-testid*="post_menu"]')
        .first();
      if (await dotMenuButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await dotMenuButton.click();
      }

      // Click Edit action from dropdown menu or button
      const editOption = page
        .locator(`#edit_post_${input.postId}, button:has-text("Edit"), [data-testid="edit_post"]`)
        .first();
      await editOption.click({ timeout: 3000 });

      // Fill in new text
      const editTextbox = page.locator('#edit_textbox').first();
      await editTextbox.waitFor({ state: 'visible', timeout: 5000 });
      await editTextbox.fill(input.message);

      // Submit via Save button
      const saveButton = page.locator('#editButton, button:has-text("Save")').first();
      await saveButton.click({ timeout: 3000 });

      return {
        id: input.postId,
        channelId: 'browser-channel',
        userId: user.id,
        message: input.message,
        updatedAt: new Date(),
      };
    } catch (domErr) {
      throw new MattermostProviderError(
        `Failed to edit post '${input.postId}' via browser session: ${domErr instanceof Error ? domErr.message : String(domErr)}`
      );
    }
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

  public async getPostThread(postId: string): Promise<{ order: string[]; posts: Record<string, Post> }> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();

    try {
      const rawThread = await page.evaluate(async (targetPostId) => {
        const res = await fetch(`/api/v4/posts/${encodeURIComponent(targetPostId)}/thread`, {
          credentials: 'include',
        });
        if (res.ok) {
          return res.json();
        }
        return null;
      }, postId);

      const posts: Record<string, Post> = {};
      if (rawThread && rawThread.posts) {
        for (const [id, p] of Object.entries(rawThread.posts as Record<string, any>)) {
          posts[id] = {
            id: p.id,
            createAt: p.create_at,
            updateAt: p.update_at,
            deleteAt: p.delete_at,
            userId: p.user_id,
            channelId: p.channel_id,
            rootId: p.root_id,
            message: p.message,
            type: p.type,
            hashtags: p.hashtags,
            props: p.props,
            fileIds: p.file_ids,
            files: p.metadata?.files?.map((f: any) => ({
              id: f.id,
              name: f.name,
              size: f.size,
              mimeType: f.mime_type,
              extension: f.extension,
            })),
            reactions: p.metadata?.reactions?.map((r: any) => ({
              userId: r.user_id,
              postId: r.post_id,
              emojiName: r.emoji_name,
              createAt: r.create_at,
            })),
          };
        }
      }

      return {
        order: rawThread?.order || [],
        posts,
      };
    } catch (err) {
      throw new MattermostProviderError(
        `Failed to retrieve thread for post '${postId}' via browser session: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public async searchPosts(terms: string, options?: { teamId?: string; isOrSearch?: boolean }): Promise<Post[]> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();

    try {
      const rawSearch = await page.evaluate(
        async ({ terms, teamId, isOrSearch }) => {
          const url = teamId
            ? `/api/v4/teams/${encodeURIComponent(teamId)}/posts/search`
            : '/api/v4/posts/search';
          const cookieMatch = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]*)/);
          const csrfToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          };
          if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

          const res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({ terms, is_or_search: isOrSearch }),
          });
          if (res.ok) {
            return res.json();
          }
          return null;
        },
        { terms, teamId: options?.teamId, isOrSearch: options?.isOrSearch ?? false }
      );

      if (!rawSearch || !Array.isArray(rawSearch.order) || !rawSearch.posts) {
        return [];
      }

      return rawSearch.order
        .map((id: string) => rawSearch.posts[id])
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
          hashtags: p.hashtags,
          props: p.props,
          fileIds: p.file_ids,
          files: p.metadata?.files?.map((f: any) => ({
            id: f.id,
            name: f.name,
            size: f.size,
            mimeType: f.mime_type,
            extension: f.extension,
          })),
          reactions: p.metadata?.reactions?.map((r: any) => ({
            userId: r.user_id,
            postId: r.post_id,
            emojiName: r.emoji_name,
            createAt: r.create_at,
          })),
        }));
    } catch (err) {
      throw new MattermostProviderError(
        `Failed to search posts for terms '${terms}' via browser session: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public async getUsersByIds(userIds: string[]): Promise<User[]> {
    if (!userIds || userIds.length === 0) return [];
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();

    try {
      const rawUsers = await page.evaluate(async (ids) => {
        const cookieMatch = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]*)/);
        const csrfToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

        const res = await fetch('/api/v4/users/ids', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(ids),
        });
        if (res.ok) {
          return res.json();
        }
        return [];
      }, userIds);

      return (rawUsers || []).map((u: any) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        firstName: u.first_name,
        lastName: u.last_name,
        nickname: u.nickname,
        roles: u.roles,
        createAt: u.create_at,
      }));
    } catch {
      return [];
    }
  }

  public async getUnreadSummary(): Promise<UnreadSummaryResult> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();

    try {
      const res = await page.evaluate(async () => {
        const teamsRes = await fetch('/api/v4/users/me/teams', { credentials: 'include' });
        const teams = teamsRes.ok ? await teamsRes.json() : [];
        const channelsRes = await fetch('/api/v4/users/me/channels', { credentials: 'include' });
        const channels = channelsRes.ok ? await channelsRes.json() : [];

        let allMembers: any[] = [];
        for (const t of teams) {
          const mRes = await fetch(`/api/v4/users/me/teams/${t.id}/channels/members`, { credentials: 'include' });
          if (mRes.ok) {
            const m = await mRes.json();
            allMembers.push(...m);
          }
        }

        const unreads: any[] = [];
        for (const m of allMembers) {
          const chan = channels.find((c: any) => c.id === m.channel_id);
          if (chan) {
            const unreadCount = Math.max(0, (chan.total_msg_count || 0) - (m.msg_count || 0));
            const mentionCount = m.mention_count || 0;
            if (unreadCount > 0 || mentionCount > 0) {
              unreads.push({
                channelId: chan.id,
                channelName: chan.name,
                displayName: chan.display_name || chan.name,
                type: chan.type,
                teamId: chan.team_id || undefined,
                unreadCount,
                mentionCount,
                hasMention: mentionCount > 0,
              });
            }
          }
        }
        return unreads;
      });

      res.sort((a: any, b: any) => {
        if (a.hasMention !== b.hasMention) return a.hasMention ? -1 : 1;
        if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
        return b.unreadCount - a.unreadCount;
      });

      return {
        totalUnreadChannels: res.length,
        channels: res,
      };
    } catch (err) {
      throw new MattermostProviderError(
        `Failed to retrieve unread summary via browser session: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public async getPost(postId: string): Promise<Post> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();
    const rawPost = await page.evaluate(async (targetPostId) => {
      const res = await fetch(`/api/v4/posts/${encodeURIComponent(targetPostId)}`, {
        credentials: 'include',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json();
    }, postId);

    if (!rawPost) {
      throw new MattermostValidationError(`Post not found with ID '${postId}'.`);
    }

    return {
      id: rawPost.id,
      createAt: rawPost.create_at,
      updateAt: rawPost.update_at,
      deleteAt: rawPost.delete_at,
      userId: rawPost.user_id,
      channelId: rawPost.channel_id,
      rootId: rawPost.root_id,
      message: rawPost.message,
      type: rawPost.type,
      hashtags: rawPost.hashtags,
      props: rawPost.props,
      fileIds: rawPost.file_ids,
      files: rawPost.metadata?.files?.map((f: any) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mimeType: f.mime_type,
        extension: f.extension,
      })),
      reactions: rawPost.metadata?.reactions?.map((r: any) => ({
        userId: r.user_id,
        postId: r.post_id,
        emojiName: r.emoji_name,
        createAt: r.create_at,
      })),
    };
  }

  public async getChannelPosts(
    channelId: string,
    options: { before?: string; after?: string; limit?: number }
  ): Promise<Post[]> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();

    const rawList = await page.evaluate(
      async ({ chanId, before, after, limit }) => {
        const params = new URLSearchParams();
        if (limit) params.set('per_page', limit.toString());
        if (before) params.set('before', before);
        if (after) params.set('after', after);
        const res = await fetch(`/api/v4/channels/${encodeURIComponent(chanId)}/posts?${params.toString()}`, {
          credentials: 'include',
        });
        if (!res.ok) return null;
        return res.json();
      },
      { chanId: channelId, before: options.before, after: options.after, limit: options.limit || 30 }
    );

    if (!rawList || !rawList.order || !rawList.posts) {
      return [];
    }

    return rawList.order.map((id: string) => {
      const p = rawList.posts[id];
      return {
        id: p.id,
        createAt: p.create_at,
        updateAt: p.update_at,
        deleteAt: p.delete_at,
        userId: p.user_id,
        channelId: p.channel_id,
        rootId: p.root_id,
        message: p.message,
        type: p.type,
        hashtags: p.hashtags,
        props: p.props,
        fileIds: p.file_ids,
        files: p.metadata?.files?.map((f: any) => ({
          id: f.id,
          name: f.name,
          size: f.size,
          mimeType: f.mime_type,
          extension: f.extension,
        })),
        reactions: p.metadata?.reactions?.map((r: any) => ({
          userId: r.user_id,
          postId: r.post_id,
          emojiName: r.emoji_name,
          createAt: r.create_at,
        })),
      };
    });
  }

  public async getUser(usernameOrId: string): Promise<UserProfileResult> {
    await this.ensureAuthenticated();
    const page = await this.webClient.getPage();
    const clean = usernameOrId.trim().replace(/^@/, '');
    const isId = /^[a-z0-9]{26}$/i.test(clean);

    const rawUser = await page.evaluate(
      async ({ target, isUserId }) => {
        const path = isUserId
          ? `/api/v4/users/${encodeURIComponent(target)}`
          : `/api/v4/users/username/${encodeURIComponent(target)}`;
        const res = await fetch(path, { credentials: 'include' });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        return res.json();
      },
      { target: clean, isUserId: isId }
    );

    if (!rawUser) {
      throw new MattermostValidationError(`User '${usernameOrId}' not found.`);
    }

    return {
      id: rawUser.id,
      username: rawUser.username,
      email: rawUser.email,
      firstName: rawUser.first_name,
      lastName: rawUser.last_name,
      nickname: rawUser.nickname,
      position: rawUser.position,
      roles: rawUser.roles,
      createAt: rawUser.create_at,
    };
  }

  public async downloadFile(fileId: string, outputDir: string, maxSizeBytes?: number): Promise<FileDownloadResult> {
    await this.ensureAuthenticated();
    const cleanId = fileId.trim();
    if (!/^[a-z0-9]{26}$/i.test(cleanId)) {
      throw new MattermostValidationError(`Invalid file ID '${fileId}'. Expected 26-character alphanumeric string.`);
    }

    const context = await this.webClient.getContext();
    const infoRes = await context.request.get(`${this.baseUrl}/api/v4/files/${encodeURIComponent(cleanId)}/info`);
    if (infoRes.status() === 404) {
      throw new MattermostValidationError(`File with ID '${cleanId}' not found.`);
    }
    if (!infoRes.ok()) {
      throw new MattermostProviderError(`Failed to fetch file info: HTTP ${infoRes.status()}`);
    }
    const info = await infoRes.json();

    const maxLimit = maxSizeBytes ?? 50 * 1024 * 1024;
    if (info.size && info.size > maxLimit) {
      throw new MattermostValidationError(
        `File size (${info.size} bytes) exceeds maximum allowed limit of ${maxLimit} bytes.`
      );
    }

    const rawName = info.name || `file_${cleanId}`;
    const safeName = path.basename(rawName).replace(/[/\\?%*:|"<>]/g, '_');
    const resolvedDir = path.resolve(outputDir);
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }
    const finalPath = path.resolve(resolvedDir, safeName);
    if (!finalPath.startsWith(resolvedDir)) {
      throw new MattermostValidationError('Path traversal attempt detected in filename.');
    }

    const dataRes = await context.request.get(`${this.baseUrl}/api/v4/files/${encodeURIComponent(cleanId)}`);
    if (!dataRes.ok()) {
      throw new MattermostProviderError(`Failed to download file data: HTTP ${dataRes.status()}`);
    }
    const buffer = await dataRes.body();
    if (buffer.length > maxLimit) {
      throw new MattermostValidationError(
        `Downloaded file size (${buffer.length} bytes) exceeds maximum allowed limit of ${maxLimit} bytes.`
      );
    }

    fs.writeFileSync(finalPath, buffer);
    return {
      fileId: cleanId,
      filename: safeName,
      mimeType: info.mime_type || 'application/octet-stream',
      size: buffer.length,
      savedPath: finalPath,
    };
  }

  public async addReaction(postId: string, emojiName: string): Promise<ReactionResult> {
    const user = await this.ensureAuthenticated();
    const page = await this.webClient.getPage();
    const cleanEmoji = emojiName.trim().replace(/^:|:$/g, '');

    const raw = await page.evaluate(
      async ({ userId, targetPostId, emoji }) => {
        const cookieMatch = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]*)/);
        const csrfToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        };
        if (csrfToken) {
          headers['X-CSRF-Token'] = csrfToken;
        }

        const res = await fetch('/api/v4/reactions', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            user_id: userId,
            post_id: targetPostId,
            emoji_name: emoji,
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || `HTTP ${res.status}: ${res.statusText}`);
        }

        return res.json();
      },
      { userId: user.id, targetPostId: postId, emoji: cleanEmoji }
    );

    return {
      userId: raw.user_id,
      postId: raw.post_id,
      emojiName: raw.emoji_name,
      createAt: raw.create_at || Date.now(),
    };
  }

  public async close(): Promise<void> {
    await this.webClient.close();
  }
}
