import * as fs from 'fs';
import * as path from 'path';
import {
  MentionsResult,
  Post,
  PostContextResult,
  SearchFilterOptions,
  SearchPostsResult,
  ThreadPostItem,
  ThreadViewResult,
  UserMentionItem,
} from '../../../domain/mattermost/entities';
import {
  MattermostAuthenticationError,
  MattermostAuthorizationError,
  MattermostError,
  MattermostValidationError,
} from '../../../domain/mattermost/errors';
import { MattermostProvider } from '../../../domain/mattermost/providers/mattermost-provider.interface';
import { resolveAppPath } from '../../../config/paths';
import { Logger, defaultLogger } from './logger';
import { UserCacheService } from './user-cache';

export interface ThreadSummary {
  index: number;
  rootId: string;
  channelId: string;
  authorId: string;
  createdAt: Date;
  relativeTime: string;
  messageSnippet: string;
  fullMessage: string;
  replyCount: number;
  lastReplyAt?: Date;
  lastReplyRelativeTime?: string;
  lastReplySnippet?: string;
  lastReplyAuthorId?: string;
}

export interface LastThreadState {
  messageId: string;
  channelId: string;
  rootId?: string;
  channelName?: string;
  updatedAt: string;
}

export class ThreadService {
  private provider: MattermostProvider;
  private logger: Logger;
  private stateFilePath: string;
  private userCache: UserCacheService;

  constructor(provider: MattermostProvider, logger?: Logger, stateDir?: string, userCache?: UserCacheService) {
    this.provider = provider;
    this.logger = logger ?? defaultLogger;
    const baseDir = stateDir ? resolveAppPath(stateDir) : resolveAppPath('data');
    this.stateFilePath = path.join(baseDir, 'last_thread.json');
    this.userCache = userCache ?? new UserCacheService(this.provider, this.logger);
  }

  /**
   * Formats a timestamp into a human-friendly relative time (e.g. "2m ago", "1h ago").
   */
  public static formatRelativeTime(dateInput: Date | number): string {
    const timestamp = typeof dateInput === 'number' ? dateInput : dateInput.getTime();
    const diffMs = Date.now() - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 45) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay === 1) return 'yesterday';
    if (diffDay < 30) return `${diffDay}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  /**
   * Extracts post ID from Mattermost permalink URL (e.g. https://mattermost.com/team/pl/31ewigbaoigepj5qsh3xb9bbjo).
   */
  public static extractPostIdFromPermalink(input: string): string | null {
    if (!input) return null;
    const trimmed = input.trim();

    // Direct 26-char post hash
    if (/^[a-z0-9]{26}$/i.test(trimmed)) {
      return trimmed;
    }

    // Permalink matching: /pl/<id> or /posts/<id> or #<id> (exact 26-char hash)
    const match = trimmed.match(/(?:\/pl\/|\/posts\/|#)([a-z0-9]{26})(?![a-z0-9])/i);
    if (match && match[1]) {
      return match[1];
    }

    return null;
  }

  /**
   * Fetches channel messages and groups them into organized thread summaries.
   */
  public async getChannelThreads(channelId: string, limit = 50, filterQuery?: string): Promise<ThreadSummary[]> {
    this.logger.debug(`Fetching threads for channel '${channelId}' (limit: ${limit})...`);
    const posts = await this.provider.getMessages({ channelId, limit });

    if (!posts || posts.length === 0) {
      return [];
    }

    const threadRoots = new Map<string, Post>();
    const threadReplies = new Map<string, Post[]>();

    // 1. Group into roots and replies
    for (const post of posts) {
      if (post.deleteAt && post.deleteAt > 0) continue;

      if (!post.rootId || post.rootId === '' || post.rootId === post.id) {
        // It's a thread root starter
        if (!threadRoots.has(post.id)) {
          threadRoots.set(post.id, post);
        }
      } else {
        // It's a reply
        const existing = threadReplies.get(post.rootId) || [];
        existing.push(post);
        threadReplies.set(post.rootId, existing);

        // If root post itself was outside the initial window, create a proxy placeholder
        if (!threadRoots.has(post.rootId)) {
          threadRoots.set(post.rootId, {
            id: post.rootId,
            channelId: post.channelId,
            userId: post.userId,
            message: '(Thread started in earlier message)',
            createAt: post.createAt,
            updateAt: post.updateAt,
          });
        }
      }
    }

    // 2. Build thread summaries
    const summaries: ThreadSummary[] = [];

    for (const [rootId, rootPost] of threadRoots.entries()) {
      const replies = threadReplies.get(rootId) || [];
      replies.sort((a, b) => a.createAt - b.createAt);

      const latestReply = replies.length > 0 ? replies[replies.length - 1] : undefined;
      const createdAt = new Date(rootPost.createAt);
      const lastReplyAt = latestReply ? new Date(latestReply.createAt) : undefined;

      const fullMessage = rootPost.message || '';
      const messageSnippet = fullMessage.replace(/\n+/g, ' ').trim().slice(0, 120);

      summaries.push({
        index: 0, // Assigned after sorting
        rootId,
        channelId: rootPost.channelId,
        authorId: rootPost.userId,
        createdAt,
        relativeTime: ThreadService.formatRelativeTime(createdAt),
        messageSnippet: messageSnippet || '(No text content)',
        fullMessage,
        replyCount: replies.length,
        lastReplyAt,
        lastReplyRelativeTime: lastReplyAt ? ThreadService.formatRelativeTime(lastReplyAt) : undefined,
        lastReplySnippet: latestReply ? latestReply.message.replace(/\n+/g, ' ').trim().slice(0, 90) : undefined,
        lastReplyAuthorId: latestReply?.userId,
      });
    }

    // 3. Sort by latest activity (lastReplyAt or createdAt descending)
    summaries.sort((a, b) => {
      const timeA = a.lastReplyAt ? a.lastReplyAt.getTime() : a.createdAt.getTime();
      const timeB = b.lastReplyAt ? b.lastReplyAt.getTime() : b.createdAt.getTime();
      return timeB - timeA;
    });

    // 4. Assign 1-indexed numbers
    summaries.forEach((s, idx) => {
      s.index = idx + 1;
    });

    // 5. Apply filter query if specified
    if (filterQuery && filterQuery.trim()) {
      const q = filterQuery.toLowerCase().trim();
      return summaries.filter(
        (s) =>
          s.fullMessage.toLowerCase().includes(q) ||
          s.rootId.toLowerCase().includes(q) ||
          (s.lastReplySnippet && s.lastReplySnippet.toLowerCase().includes(q))
      );
    }

    return summaries;
  }

  /**
   * Resolves a human-friendly thread target (shortcut :1, permalink, search query, or ID)
   * into a verified 26-character Mattermost post ID.
   */
  public async resolveRootId(params: {
    channelId: string;
    targetIdentifier?: string;
    findQuery?: string;
    defaultRootId?: string;
  }): Promise<string> {
    const { channelId, targetIdentifier, findQuery, defaultRootId } = params;

    // 1. Check for last-thread shortcut (:last / --last)
    if (targetIdentifier === ':last' || targetIdentifier === '--last' || targetIdentifier === 'last') {
      const last = this.getLastThread();
      if (last && last.messageId) {
        this.logger.debug(`Resolved ':last' shortcut to post '${last.messageId}'`);
        return last.rootId || last.messageId;
      }
      throw new MattermostValidationError('No recent thread found in session history. Please provide a thread ID or shortcut.');
    }

    // 2. Direct Permalink URL
    if (targetIdentifier && targetIdentifier.includes('http')) {
      const extracted = ThreadService.extractPostIdFromPermalink(targetIdentifier);
      if (extracted) {
        this.logger.debug(`Extracted post ID '${extracted}' from permalink URL`);
        return extracted;
      }
    }

    // 3. Search query filter
    if (findQuery || (targetIdentifier && (targetIdentifier.startsWith('find:') || targetIdentifier.startsWith('search:')))) {
      const query = findQuery || targetIdentifier!.replace(/^(find|search):/, '');
      this.logger.debug(`Searching thread with keyword: '${query}' in channel '${channelId}'...`);
      const threads = await this.getChannelThreads(channelId, 50, query);
      if (threads.length > 0) {
        this.logger.info(`Matched thread #${threads[0].index} (${threads[0].rootId}) for query '${query}'`);
        return threads[0].rootId;
      }
      throw new MattermostValidationError(
        `No thread matching search query '${query}' was found in channel '${channelId}'. Run 'mattermost threads ${channelId}' to see active threads.`
      );
    }

    // 4. Numbered shortcut (:1, 1, :2, :latest)
    if (targetIdentifier) {
      const clean = targetIdentifier.trim().toLowerCase();
      if (clean === ':latest' || clean === 'latest' || clean === ':1' || clean === '1') {
        const threads = await this.getChannelThreads(channelId, 10);
        if (threads.length > 0) {
          this.logger.debug(`Resolved ':latest' / ':1' to top thread '${threads[0].rootId}'`);
          return threads[0].rootId;
        }
        throw new MattermostValidationError(`No active threads found in channel '${channelId}'.`);
      }

      const matchNum = clean.match(/^:?(\d+)$/);
      if (matchNum) {
        const index = parseInt(matchNum[1], 10);
        const threads = await this.getChannelThreads(channelId, Math.max(index + 5, 20));
        const found = threads.find((t) => t.index === index);
        if (found) {
          this.logger.debug(`Resolved shortcut ':${index}' to thread '${found.rootId}'`);
          return found.rootId;
        }
        throw new MattermostValidationError(
          `Thread number [${index}] not found. Only ${threads.length} threads available in channel '${channelId}'.`
        );
      }

      // 5. Direct 26-char hash
      if (/^[a-z0-9]{26}$/i.test(clean)) {
        return clean;
      }
    }

    // 6. Sticky default root ID from YAML
    if (defaultRootId) {
      this.logger.debug(`Using configured default_root_id '${defaultRootId}'`);
      return defaultRootId;
    }

    throw new MattermostValidationError(
      `Invalid thread identifier '${targetIdentifier}'. Provide a 26-char ID, shortcut (:1, :latest), permalink, or use --find "<query>".`
    );
  }

  /**
   * Saves the most recently sent message/thread info into local state.
   */
  public saveLastThread(state: LastThreadState): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // Non-critical cache
    }
  }

  /**
   * Retrieves the most recently created message/thread info from local state.
   */
  public getLastThread(): LastThreadState | null {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        return JSON.parse(raw) as LastThreadState;
      }
    } catch {
      // Ignored
    }
    return null;
  }

  /**
   * Retrieves and formats the full sequential thread view for a given post permalink or ID.
   */
  public async getThreadView(permalinkOrId: string, options?: { limit?: number }): Promise<ThreadViewResult> {
    const postId = ThreadService.extractPostIdFromPermalink(permalinkOrId);
    if (!postId) {
      throw new MattermostValidationError(`Invalid post identifier or permalink: '${permalinkOrId}'`);
    }

    this.logger.debug(`Fetching thread view for post ID '${postId}'...`);
    const rawThread = await this.provider.getPostThread(postId);

    if (!rawThread || !rawThread.posts || Object.keys(rawThread.posts).length === 0) {
      throw new MattermostValidationError(`No thread found for post '${postId}'.`);
    }

    // 1. Filter out deleted posts and sort chronologically
    const allPosts = Object.values(rawThread.posts).filter((p) => !p.deleteAt || p.deleteAt === 0);
    allPosts.sort((a, b) => a.createAt - b.createAt);

    // 2. Identify root post (first post without rootId, or matches postId, or oldest post)
    const rootPost = allPosts.find((p) => !p.rootId || p.rootId === '') || allPosts[0];
    const rootId = rootPost ? (rootPost.rootId || rootPost.id) : postId;
    const channelId = rootPost?.channelId || '';

    // 3. Truncation calculation
    const limit = options?.limit ?? 200;
    const totalPosts = allPosts.length;
    const truncated = totalPosts > limit;
    const selectedPosts = truncated ? allPosts.slice(0, limit) : allPosts;

    // 4. Batch resolve usernames
    const userIds = selectedPosts.map((p) => p.userId);
    await this.userCache.resolveUsers(userIds);

    const posts: ThreadPostItem[] = selectedPosts.map((p) => ({
      id: p.id,
      rootId: p.rootId || undefined,
      channelId: p.channelId,
      userId: p.userId,
      username: this.userCache.getUsername(p.userId),
      createAt: p.createAt,
      updateAt: p.updateAt,
      message: p.message,
      files: p.files && p.files.length > 0 ? p.files : undefined,
      reactions: p.reactions && p.reactions.length > 0 ? p.reactions : undefined,
    }));

    return {
      rootId,
      channelId,
      totalPosts,
      truncated,
      posts,
    };
  }

  /**
   * Retrieves posts mentioning the authenticated user with status on whether user already replied.
   */
  public async getMentions(options?: { since?: number; limit?: number; teamId?: string }): Promise<MentionsResult> {
    const me = await this.provider.getMe();
    this.userCache.primeUser(me);

    const username = me.username;
    if (!username) {
      throw new MattermostValidationError('Cannot search mentions: authenticated user does not have a valid username.');
    }
    const searchTerms = `@${username}`;
    this.logger.debug(`Searching posts mentioning '${searchTerms}'...`);

    const searchResults = await this.provider.searchPosts(searchTerms, { teamId: options?.teamId });

    // 1. Filter by since (default 24h)
    const since = options?.since ?? (Date.now() - 24 * 60 * 60 * 1000);
    const limit = options?.limit ?? 50;

    const filtered = (searchResults || [])
      .filter((p) => (!p.deleteAt || p.deleteAt === 0) && p.createAt >= since)
      .sort((a, b) => b.createAt - a.createAt)
      .slice(0, limit);

    if (filtered.length === 0) {
      return { total: 0, mentions: [] };
    }

    // 2. Batch resolve usernames
    const userIds = filtered.map((p) => p.userId);
    await this.userCache.resolveUsers(userIds);

    // 3. Check hasReplied for each thread
    const threadPostsCache = new Map<string, Post[]>();
    const repliedMap = new Map<string, boolean>();
    const warnings: string[] = [];

    for (const post of filtered) {
      const rootId = post.rootId || post.id;
      let threadPosts = threadPostsCache.get(rootId);

      if (!threadPosts) {
        try {
          const threadRes = await this.provider.getPostThread(rootId);
          if (threadRes && threadRes.posts) {
            threadPosts = Object.values(threadRes.posts).filter((p) => !p.deleteAt || p.deleteAt === 0);
          } else {
            threadPosts = [];
          }
        } catch (err) {
          if (err instanceof MattermostAuthenticationError || err instanceof MattermostAuthorizationError) {
            throw err;
          }
          warnings.push(`Failed to fetch thread posts for root post '${rootId}': ${err instanceof Error ? err.message : String(err)}`);
          threadPosts = [];
        }
        threadPostsCache.set(rootId, threadPosts);
      }

      // Check if current user has replied in this thread after the mention
      const hasReplied = threadPosts.some(
        (p) => p.userId === me.id && p.id !== post.id && p.createAt >= post.createAt
      );
      repliedMap.set(post.id, hasReplied);
    }

    const mentions: UserMentionItem[] = filtered.map((p) => ({
      id: p.id,
      rootId: p.rootId || undefined,
      channelId: p.channelId,
      userId: p.userId,
      username: this.userCache.getUsername(p.userId),
      message: p.message,
      createAt: p.createAt,
      hasReplied: repliedMap.get(p.id) || false,
    }));

    return {
      total: mentions.length,
      mentions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Searches posts across channels matching terms and filters (from, in, after, before).
   */
  public async searchPosts(options: SearchFilterOptions): Promise<SearchPostsResult> {
    const parts: string[] = [];
    if (options.terms && options.terms.trim()) {
      parts.push(options.terms.trim());
    }
    if (options.from && options.from.trim()) {
      parts.push(`from:${options.from.trim().replace(/^@/, '')}`);
    }
    if (options.in && options.in.trim()) {
      parts.push(`in:${options.in.trim().replace(/^~/, '')}`);
    }
    if (options.after && options.after.trim()) {
      parts.push(`after:${options.after.trim()}`);
    }
    if (options.before && options.before.trim()) {
      parts.push(`before:${options.before.trim()}`);
    }

    const query = parts.join(' ').trim();
    if (!query) {
      throw new MattermostValidationError('Search query cannot be empty. Provide terms, from, in, after, or before filter.');
    }

    this.logger.debug(`Searching posts with query: '${query}'...`);
    const searchResults = await this.provider.searchPosts(query, {
      teamId: options.teamId,
      isOrSearch: options.isOrSearch,
    });

    const limit = options.limit ?? 20;
    const filtered = (searchResults || [])
      .filter((p) => !p.deleteAt || p.deleteAt === 0)
      .slice(0, limit);

    const userIds = filtered.map((p) => p.userId);
    await this.userCache.resolveUsers(userIds);

    const posts: ThreadPostItem[] = filtered.map((p) => ({
      id: p.id,
      rootId: p.rootId || undefined,
      channelId: p.channelId,
      userId: p.userId,
      username: this.userCache.getUsername(p.userId),
      createAt: p.createAt,
      updateAt: p.updateAt,
      message: p.message,
      files: p.files && p.files.length > 0 ? p.files : undefined,
      reactions: p.reactions && p.reactions.length > 0 ? p.reactions : undefined,
    }));

    return {
      total: posts.length,
      query,
      posts,
    };
  }

  /**
   * Retrieves a single post and its surrounding contextual posts (before and after) in the same channel.
   */
  public async getPostWithContext(postIdOrPermalink: string, contextCount = 3): Promise<PostContextResult> {
    const postId = ThreadService.extractPostIdFromPermalink(postIdOrPermalink);
    if (!postId) {
      throw new MattermostValidationError(`Invalid post identifier or permalink: '${postIdOrPermalink}'`);
    }

    this.logger.debug(`Fetching post '${postId}' with context (count: ${contextCount})...`);

    // 1. Fetch target post
    let targetPost: Post;
    if (this.provider.getPost) {
      targetPost = await this.provider.getPost(postId);
    } else {
      const thread = await this.provider.getPostThread(postId);
      if (!thread || !thread.posts || !thread.posts[postId]) {
        throw new MattermostValidationError(`Post '${postId}' not found.`);
      }
      targetPost = thread.posts[postId];
    }

    if (targetPost.deleteAt && targetPost.deleteAt > 0) {
      throw new MattermostValidationError(`Post '${postId}' has been deleted.`);
    }

    // 2. Fetch context posts (before and after in channel)
    let rawBefore: Post[] = [];
    let rawAfter: Post[] = [];

    if (contextCount > 0 && this.provider.getChannelPosts) {
      const [beforeList, afterList] = await Promise.all([
        this.provider.getChannelPosts(targetPost.channelId, { before: targetPost.id, limit: contextCount }),
        this.provider.getChannelPosts(targetPost.channelId, { after: targetPost.id, limit: contextCount }),
      ]);
      rawBefore = (beforeList || []).filter((p) => (!p.deleteAt || p.deleteAt === 0) && p.id !== targetPost.id);
      rawAfter = (afterList || []).filter((p) => (!p.deleteAt || p.deleteAt === 0) && p.id !== targetPost.id);
    }

    // Sort chronologically ascending
    rawBefore.sort((a, b) => a.createAt - b.createAt);
    rawAfter.sort((a, b) => a.createAt - b.createAt);

    // 3. Resolve usernames
    const allUserIds = [
      targetPost.userId,
      ...rawBefore.map((p) => p.userId),
      ...rawAfter.map((p) => p.userId),
    ];
    await this.userCache.resolveUsers(allUserIds);

    const mapPostItem = (p: Post): ThreadPostItem => ({
      id: p.id,
      rootId: p.rootId || undefined,
      channelId: p.channelId,
      userId: p.userId,
      username: this.userCache.getUsername(p.userId),
      createAt: p.createAt,
      updateAt: p.updateAt,
      message: p.message,
      files: p.files && p.files.length > 0 ? p.files : undefined,
      reactions: p.reactions && p.reactions.length > 0 ? p.reactions : undefined,
    });

    return {
      post: mapPostItem(targetPost),
      before: rawBefore.map(mapPostItem),
      after: rawAfter.map(mapPostItem),
      totalContextPosts: rawBefore.length + rawAfter.length,
    };
  }
}

