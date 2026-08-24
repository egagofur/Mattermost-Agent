import * as fs from 'fs';
import * as path from 'path';
import { Post } from '../../../domain/mattermost/entities';
import { MattermostError, MattermostValidationError } from '../../../domain/mattermost/errors';
import { MattermostProvider } from '../../../domain/mattermost/providers/mattermost-provider.interface';
import { Logger, defaultLogger } from './logger';

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

  constructor(provider: MattermostProvider, logger?: Logger, stateDir?: string) {
    this.provider = provider;
    this.logger = logger ?? defaultLogger;
    const baseDir = stateDir || path.resolve(process.cwd(), 'data');
    this.stateFilePath = path.join(baseDir, 'last_thread.json');
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

    // Permalink matching: /pl/<id> or /posts/<id> or #<id>
    const match = trimmed.match(/(?:\/pl\/|\/posts\/|#)([a-z0-9]{26})/i);
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
}
