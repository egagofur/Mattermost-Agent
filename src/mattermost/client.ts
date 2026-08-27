export interface MattermostUser {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  roles?: string;
}

export interface MattermostChannel {
  id: string;
  name: string;
  display_name: string;
  type: string;
  team_id?: string;
}

export interface MattermostPost {
  id: string;
  create_at: number;
  update_at?: number;
  delete_at?: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  props?: Record<string, unknown>;
  type?: string;
}

export interface MattermostPostsResponse {
  order: string[];
  posts: Record<string, MattermostPost>;
}

export interface CreatePostParams {
  channel_id: string;
  message: string;
  root_id?: string;
}

export interface MattermostClientOptions {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
}

export class MattermostClient {
  private baseUrl: string;
  private token: string;
  private fetch: typeof fetch;

  constructor(options: MattermostClientOptions) {
    if (!options.baseUrl) throw new Error('MattermostClient requires baseUrl.');
    if (!options.token) throw new Error('MattermostClient requires token.');

    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetch = options.fetchFn || globalThis.fetch;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/api/v4${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      ...(options.headers || {}),
    };

    let res: Response;
    try {
      res = await this.fetch(url, { ...options, headers });
    } catch (err: any) {
      throw new Error(`Mattermost network request failed to ${endpoint}: ${err.message}`);
    }

    if (!res.ok) {
      let errMsg = `HTTP ${res.status} ${res.statusText}`;
      try {
        const errorJson = await res.json();
        if (errorJson?.message) {
          errMsg = `${errMsg}: ${errorJson.message}`;
        }
      } catch {}
      throw new Error(`Mattermost API error on ${endpoint} (${errMsg})`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * Retrieves the authenticated user profile.
   */
  public async getMe(): Promise<MattermostUser> {
    return this.request<MattermostUser>('/users/me');
  }

  /**
   * Retrieves all channels accessible to the authenticated user.
   */
  public async getMyChannels(): Promise<MattermostChannel[]> {
    return this.request<MattermostChannel[]>('/users/me/channels');
  }

  /**
   * Retrieves recent posts for a specific channel.
   */
  public async getChannelPosts(
    channelId: string,
    options: { since?: number; page?: number; perPage?: number } = {}
  ): Promise<MattermostPostsResponse> {
    const params = new URLSearchParams();
    if (options.since) params.append('since', options.since.toString());
    if (options.page !== undefined) params.append('page', options.page.toString());
    if (options.perPage !== undefined) params.append('per_page', options.perPage.toString());

    const qs = params.toString();
    const endpoint = `/channels/${channelId}/posts${qs ? `?${qs}` : ''}`;
    return this.request<MattermostPostsResponse>(endpoint);
  }

  /**
   * Retrieves all posts in a thread starting from the root post.
   */
  public async getPostThread(postId: string): Promise<MattermostPostsResponse> {
    return this.request<MattermostPostsResponse>(`/posts/${postId}/thread`);
  }

  /**
   * Creates a new post or replies to an existing thread.
   */
  public async createPost(params: CreatePostParams): Promise<MattermostPost> {
    return this.request<MattermostPost>('/posts', {
      method: 'POST',
      body: JSON.stringify({
        channel_id: params.channel_id,
        message: params.message,
        root_id: params.root_id || '',
      }),
    });
  }
}
