import {
  MattermostAuthenticationError,
  MattermostAuthorizationError,
  MattermostChannelNotFoundError,
  MattermostError,
  MattermostNetworkError,
  MattermostRateLimitError,
} from '../../../domain/mattermost/errors';
import { Logger, defaultLogger } from '../services/logger';

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: Logger;
}

export interface MattermostRawUser {
  id: string;
  username: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  roles?: string;
  create_at?: number;
}

export interface MattermostRawTeam {
  id: string;
  name: string;
  display_name: string;
  description?: string;
}

export interface MattermostRawChannel {
  id: string;
  team_id?: string;
  name: string;
  display_name: string;
  type: string;
  header?: string;
  purpose?: string;
}

export interface MattermostRawPost {
  id: string;
  create_at: number;
  update_at: number;
  delete_at?: number;
  user_id: string;
  channel_id: string;
  root_id?: string;
  message: string;
  type?: string;
  hashtags?: string;
  props?: Record<string, unknown>;
  file_ids?: string[];
  metadata?: {
    files?: Array<{
      id: string;
      name: string;
      size?: number;
      mime_type?: string;
      extension?: string;
    }>;
    reactions?: Array<{
      user_id: string;
      post_id: string;
      emoji_name: string;
      create_at?: number;
    }>;
  };
}

export interface MattermostRawPostList {
  order: string[];
  posts: Record<string, MattermostRawPost>;
}

export class MattermostApiClient {
  private baseUrl: string;
  private token: string;
  private timeoutMs: number;
  private maxRetries: number;
  private logger: Logger;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 3;
    this.logger = options.logger ?? defaultLogger;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Executes an HTTP request to the Mattermost REST API v4.
   */
  public async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      retryCount?: number;
    } = {}
  ): Promise<T> {
    const { method = 'GET', body, headers = {}, retryCount = 0 } = options;
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...headers,
    };

    try {
      this.logger.debug(`API Request: ${method} ${path}`);

      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        // Handle 204 No Content
        if (response.status === 204) {
          return {} as T;
        }
        return (await response.json()) as T;
      }

      // Read error body safely
      let errorBody: { id?: string; message?: string; detailed_error?: string; status_code?: number } = {};
      try {
        errorBody = (await response.json()) as typeof errorBody;
      } catch {
        // Response wasn't JSON
      }

      const status = response.status;
      const errorMsg = errorBody.message || `HTTP ${status} ${response.statusText}`;

      this.logger.debug(`API Error Response: ${status} for ${method} ${path}`, {
        status,
        errorId: errorBody.id,
        detailedError: errorBody.detailed_error,
      });

      if (status === 401) {
        throw new MattermostAuthenticationError(
          `Mattermost API authentication failed: ${errorMsg}`,
          { status, errorId: errorBody.id }
        );
      }

      if (status === 403) {
        throw new MattermostAuthorizationError(
          `Mattermost API forbidden: ${errorMsg}`,
          { status, errorId: errorBody.id }
        );
      }

      if (status === 404) {
        throw new MattermostChannelNotFoundError(path, {
          status,
          errorId: errorBody.id,
          detailedError: errorBody.detailed_error,
        });
      }

      if (status === 429) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : (retryCount + 1) * 2000;

        if (retryCount < this.maxRetries) {
          this.logger.warn(`Rate limited (429) on ${path}. Retrying after ${retryAfterMs}ms (attempt ${retryCount + 1}/${this.maxRetries})...`);
          await this.sleep(retryAfterMs);
          return this.request<T>(path, { ...options, retryCount: retryCount + 1 });
        }

        throw new MattermostRateLimitError(
          `Rate limit exceeded for Mattermost API: ${errorMsg}`,
          retryAfterMs,
          { status, errorId: errorBody.id }
        );
      }

      // Server error 500, 502, 503, 504
      if (status >= 500) {
        if (retryCount < this.maxRetries) {
          const backoffMs = Math.pow(2, retryCount) * 1000 + Math.random() * 500;
          this.logger.warn(`Server error ${status} on ${path}. Retrying after ${Math.round(backoffMs)}ms (attempt ${retryCount + 1}/${this.maxRetries})...`);
          await this.sleep(backoffMs);
          return this.request<T>(path, { ...options, retryCount: retryCount + 1 });
        }

        throw new MattermostNetworkError(
          `Mattermost server error (${status}): ${errorMsg}`,
          status,
          { errorId: errorBody.id }
        );
      }

      throw new MattermostError(`Mattermost API request failed: ${errorMsg}`, {
        code: errorBody.id || 'API_ERROR',
        statusCode: status,
        isRetryable: false,
        details: errorBody as Record<string, unknown>,
      });
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof MattermostError) {
        throw err;
      }

      // Check if timeout abort
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const networkMessage = isAbort ? `Request timeout after ${this.timeoutMs}ms on ${method} ${path}` : `Network connection error on ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`;

      if (retryCount < this.maxRetries) {
        const backoffMs = Math.pow(2, retryCount) * 1000 + Math.random() * 500;
        this.logger.warn(`${networkMessage}. Retrying after ${Math.round(backoffMs)}ms...`);
        await this.sleep(backoffMs);
        return this.request<T>(path, { ...options, retryCount: retryCount + 1 });
      }

      throw new MattermostNetworkError(networkMessage, isAbort ? 504 : 503, undefined, err);
    }
  }

  public async getMe(): Promise<MattermostRawUser> {
    return this.request<MattermostRawUser>('/api/v4/users/me');
  }

  public async getMyTeams(): Promise<MattermostRawTeam[]> {
    return this.request<MattermostRawTeam[]>('/api/v4/users/me/teams');
  }

  public async getTeamByName(name: string): Promise<MattermostRawTeam> {
    return this.request<MattermostRawTeam>(`/api/v4/teams/name/${encodeURIComponent(name)}`);
  }

  public async getTeam(teamId: string): Promise<MattermostRawTeam> {
    return this.request<MattermostRawTeam>(`/api/v4/teams/${encodeURIComponent(teamId)}`);
  }

  public async getChannel(channelId: string): Promise<MattermostRawChannel> {
    return this.request<MattermostRawChannel>(`/api/v4/channels/${encodeURIComponent(channelId)}`);
  }

  public async getChannelByName(teamId: string, channelName: string): Promise<MattermostRawChannel> {
    return this.request<MattermostRawChannel>(`/api/v4/teams/${encodeURIComponent(teamId)}/channels/name/${encodeURIComponent(channelName)}`);
  }

  public async getChannelsForUserInTeam(teamId: string): Promise<MattermostRawChannel[]> {
    return this.request<MattermostRawChannel[]>(`/api/v4/users/me/teams/${encodeURIComponent(teamId)}/channels`);
  }

  public async getAllChannelsForTeam(teamId: string, page = 0, perPage = 100): Promise<MattermostRawChannel[]> {
    return this.request<MattermostRawChannel[]>(`/api/v4/teams/${encodeURIComponent(teamId)}/channels?page=${page}&per_page=${perPage}`);
  }

  public async createPost(channelId: string, message: string, rootId?: string): Promise<MattermostRawPost> {
    return this.request<MattermostRawPost>('/api/v4/posts', {
      method: 'POST',
      body: {
        channel_id: channelId,
        message,
        root_id: rootId || undefined,
      },
    });
  }

  public async patchPost(postId: string, message: string): Promise<MattermostRawPost> {
    return this.request<MattermostRawPost>(`/api/v4/posts/${encodeURIComponent(postId)}/patch`, {
      method: 'PUT',
      body: {
        id: postId,
        message,
      },
    });
  }

  public async getPostsForChannel(channelId: string, page = 0, perPage = 30, since?: number): Promise<MattermostRawPostList> {
    const params = new URLSearchParams({
      page: page.toString(),
      per_page: perPage.toString(),
    });
    if (since) {
      params.set('since', since.toString());
    }
    return this.request<MattermostRawPostList>(`/api/v4/channels/${encodeURIComponent(channelId)}/posts?${params.toString()}`);
  }

  public async getPostThread(postId: string): Promise<MattermostRawPostList> {
    return this.request<MattermostRawPostList>(`/api/v4/posts/${encodeURIComponent(postId)}/thread`);
  }

  public async searchPosts(terms: string, teamId?: string, isOrSearch = false): Promise<MattermostRawPostList> {
    const path = teamId
      ? `/api/v4/teams/${encodeURIComponent(teamId)}/posts/search`
      : '/api/v4/posts/search';
    return this.request<MattermostRawPostList>(path, {
      method: 'POST',
      body: {
        terms,
        is_or_search: isOrSearch,
      },
    });
  }

  public async getUsersByIds(userIds: string[]): Promise<MattermostRawUser[]> {
    if (!userIds || userIds.length === 0) return [];
    return this.request<MattermostRawUser[]>('/api/v4/users/ids', {
      method: 'POST',
      body: userIds,
    });
  }
}
