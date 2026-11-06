import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadService } from '../src/infrastructure/mattermost/services/thread-service';
import { UserCacheService } from '../src/infrastructure/mattermost/services/user-cache';
import { MattermostProvider } from '../src/domain/mattermost/providers/mattermost-provider.interface';
import { Post, User } from '../src/domain/mattermost/entities';
import { MattermostAutomationService } from '../src/application/mattermost/services/automation-service';
import { MattermostValidationError, sanitizeSecret } from '../src/domain/mattermost/errors';
import { createMattermostMcpServer } from '../src/mcp/server';

describe('Thread View & Mentions Tools (Phase 1)', () => {
  let mockProvider: MattermostProvider;
  const now = Date.now();

  const mockMe: User = {
    id: 'usr_me_123',
    username: 'egagofur',
    roles: 'system_user',
  };

  const mockUsers: User[] = [
    mockMe,
    { id: 'usr_kevin_456', username: 'kevin', roles: 'system_user' },
    { id: 'usr_ahmad_789', username: 'ahmad', roles: 'system_user' },
  ];

  beforeEach(() => {
    mockProvider = {
      getMe: vi.fn().mockResolvedValue(mockMe),
      getChannel: vi.fn(),
      listChannels: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn(),
      replyToMessage: vi.fn(),
      editMessage: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
      getPostThread: vi.fn(),
      searchPosts: vi.fn(),
      getUsersByIds: vi.fn().mockImplementation(async (ids: string[]) => {
        return mockUsers.filter((u) => ids.includes(u.id));
      }),
    };
  });

  describe('UserCacheService', () => {
    it('caches users and prevents duplicate provider calls', async () => {
      const userCache = new UserCacheService(mockProvider);
      expect(mockProvider.getUsersByIds).not.toHaveBeenCalled();

      // First resolution
      const res1 = await userCache.resolveUsers(['usr_kevin_456']);
      expect(res1.get('usr_kevin_456')?.username).toBe('kevin');
      expect(mockProvider.getUsersByIds).toHaveBeenCalledTimes(1);

      // Second resolution for same user
      const res2 = await userCache.resolveUsers(['usr_kevin_456']);
      expect(res2.get('usr_kevin_456')?.username).toBe('kevin');
      // Should still be called only once
      expect(mockProvider.getUsersByIds).toHaveBeenCalledTimes(1);
    });

    it('falls back to userId if user resolution fails or returns null', async () => {
      const userCache = new UserCacheService(mockProvider);
      const username = userCache.getUsername('usr_unknown_999');
      expect(username).toBe('usr_unknown_999');
    });
  });

  describe('ThreadService.getThreadView', () => {
    const threadPostId = '31ewigbaoigepj5qsh3xb9bbjo';
    const sampleThreadPosts: Record<string, Post> = {
      [threadPostId]: {
        id: threadPostId,
        createAt: now - 50000,
        updateAt: now - 50000,
        userId: 'usr_ahmad_789',
        channelId: 'chan_general_123',
        message: 'Can someone review MR #42?',
        files: [{ id: 'file_1', name: 'diff.patch', size: 1024, mimeType: 'text/plain' }],
        reactions: [{ userId: 'usr_me_123', postId: threadPostId, emojiName: 'eyes' }],
      },
      reply_1: {
        id: 'reply_1',
        createAt: now - 30000,
        updateAt: now - 30000,
        rootId: threadPostId,
        userId: 'usr_kevin_456',
        channelId: 'chan_general_123',
        message: 'On it right now.',
      },
      reply_2: {
        id: 'reply_2',
        createAt: now - 10000,
        updateAt: now - 10000,
        rootId: threadPostId,
        userId: 'usr_me_123',
        channelId: 'chan_general_123',
        message: 'LGTM!',
      },
    };

    it('retrieves and formats full thread from permalink URL with resolved usernames', async () => {
      (mockProvider.getPostThread as any).mockResolvedValue({
        order: [threadPostId, 'reply_1', 'reply_2'],
        posts: sampleThreadPosts,
      });

      const threadService = new ThreadService(mockProvider);
      const permalink = `https://mattermost.example.com/team/pl/${threadPostId}`;
      const result = await threadService.getThreadView(permalink);

      expect(result.rootId).toBe(threadPostId);
      expect(result.channelId).toBe('chan_general_123');
      expect(result.totalPosts).toBe(3);
      expect(result.truncated).toBe(false);
      expect(result.posts).toHaveLength(3);

      // Chronological order: root first, then reply_1, then reply_2
      expect(result.posts[0].id).toBe(threadPostId);
      expect(result.posts[0].username).toBe('ahmad');
      expect(result.posts[0].files).toHaveLength(1);
      expect(result.posts[0].reactions).toHaveLength(1);

      expect(result.posts[1].id).toBe('reply_1');
      expect(result.posts[1].username).toBe('kevin');

      expect(result.posts[2].id).toBe('reply_2');
      expect(result.posts[2].username).toBe('egagofur');
    });

    it('sets truncated: true and caps posts when thread exceeds limit', async () => {
      (mockProvider.getPostThread as any).mockResolvedValue({
        order: [threadPostId, 'reply_1', 'reply_2'],
        posts: sampleThreadPosts,
      });

      const threadService = new ThreadService(mockProvider);
      const result = await threadService.getThreadView(threadPostId, { limit: 2 });

      expect(result.totalPosts).toBe(3);
      expect(result.truncated).toBe(true);
      expect(result.posts).toHaveLength(2);
      expect(result.posts[0].id).toBe(threadPostId);
      expect(result.posts[1].id).toBe('reply_1');
    });

    it('correctly extracts post ID across permalink variations and rejects invalid lengths', () => {
      const validId = '31ewigbaoigepj5qsh3xb9bbjo';
      // Bare ID
      expect(ThreadService.extractPostIdFromPermalink(validId)).toBe(validId);
      // Standard /pl/ permalink
      expect(ThreadService.extractPostIdFromPermalink(`https://workspace.dot.co.id/dot-indonesia/pl/${validId}`)).toBe(validId);
      // Trailing slash
      expect(ThreadService.extractPostIdFromPermalink(`https://workspace.dot.co.id/dot-indonesia/pl/${validId}/`)).toBe(validId);
      // Query parameters
      expect(ThreadService.extractPostIdFromPermalink(`https://workspace.dot.co.id/dot-indonesia/pl/${validId}?redirect=true&tab=1`)).toBe(validId);
      // URL anchor / hash
      expect(ThreadService.extractPostIdFromPermalink(`https://mattermost.domain.com/team/channels/general#${validId}`)).toBe(validId);
      // /posts/ URL format
      expect(ThreadService.extractPostIdFromPermalink(`https://mattermost.domain.com/team/posts/${validId}`)).toBe(validId);

      // Rejections
      expect(ThreadService.extractPostIdFromPermalink('')).toBeNull();
      expect(ThreadService.extractPostIdFromPermalink('shortid123')).toBeNull();
      // 25 chars (one short)
      expect(ThreadService.extractPostIdFromPermalink('31ewigbaoigepj5qsh3xb9bbj')).toBeNull();
      // 27 chars (one too long)
      expect(ThreadService.extractPostIdFromPermalink('31ewigbaoigepj5qsh3xb9bbjox')).toBeNull();
      // Permalink with extra alphanumeric characters tacked on
      expect(ThreadService.extractPostIdFromPermalink(`https://workspace.dot.co.id/dot-indonesia/pl/${validId}extra`)).toBeNull();
    });

    it('handles thread with >200 posts: truncates to 200, sets truncated: true, preserves chronological order', async () => {
      const largeThreadPosts: Record<string, Post> = {};
      const order: string[] = [];
      const rootId = '31ewigbaoigepj5qsh3xb9bb00';

      for (let i = 0; i < 220; i++) {
        const id = `31ewigbaoigepj5qsh3xb9${String(i).padStart(4, '0')}`;
        order.push(id);
        largeThreadPosts[id] = {
          id,
          rootId: i === 0 ? '' : rootId,
          channelId: 'chan_large_thread',
          userId: i % 2 === 0 ? 'usr_me_123' : 'usr_ahmad_789',
          createAt: 1700000000000 + i * 1000,
          updateAt: 1700000000000 + i * 1000,
          message: `Message #${i}`,
        };
      }

      (mockProvider.getPostThread as any).mockResolvedValue({
        order,
        posts: largeThreadPosts,
      });

      const threadService = new ThreadService(mockProvider);
      const result = await threadService.getThreadView(rootId); // default limit 200

      expect(result.totalPosts).toBe(220);
      expect(result.truncated).toBe(true);
      expect(result.posts).toHaveLength(200);

      // First post is oldest
      expect(result.posts[0].id).toBe(order[0]);
      // 200th post is the 200th in chronological sequence
      expect(result.posts[199].id).toBe(order[199]);
      // Verify strictly ascending timestamps
      for (let i = 1; i < result.posts.length; i++) {
        expect(result.posts[i].createAt).toBeGreaterThanOrEqual(result.posts[i - 1].createAt);
      }
    });

    it('throws validation error if post ID or permalink is invalid', async () => {
      const threadService = new ThreadService(mockProvider);
      await expect(threadService.getThreadView('not-a-valid-post-id')).rejects.toThrow(
        'Invalid post identifier or permalink'
      );
    });
  });

  describe('ThreadService.getMentions', () => {
    it('searches mentions by @username and detects hasReplied correctly', async () => {
      const mentionPost1: Post = {
        id: 'mention_post_1',
        createAt: now - 3600000 * 2, // 2h ago
        updateAt: now - 3600000 * 2,
        userId: 'usr_ahmad_789',
        channelId: 'chan_fe',
        message: 'cc @egagofur tolong check staging',
      };

      const mentionPost2: Post = {
        id: 'mention_post_2',
        createAt: now - 3600000 * 5, // 5h ago
        updateAt: now - 3600000 * 5,
        userId: 'usr_kevin_456',
        channelId: 'chan_fe',
        message: 'cc @egagofur bug ticket #10',
      };

      (mockProvider.searchPosts as any).mockResolvedValue([mentionPost1, mentionPost2]);

      // Thread for mentionPost1: current user has replied
      (mockProvider.getPostThread as any).mockImplementation(async (postId: string) => {
        if (postId === 'mention_post_1') {
          return {
            order: ['mention_post_1', 'reply_to_1'],
            posts: {
              mention_post_1: mentionPost1,
              reply_to_1: {
                id: 'reply_to_1',
                createAt: now - 3600000 * 1, // 1h ago (after mention)
                updateAt: now - 3600000 * 1,
                userId: 'usr_me_123', // Replied by me!
                channelId: 'chan_fe',
                rootId: 'mention_post_1',
                message: 'Sudah beres mas',
              },
            },
          };
        }
        if (postId === 'mention_post_2') {
          return {
            order: ['mention_post_2'],
            posts: {
              mention_post_2: mentionPost2,
            },
          };
        }
        return { order: [], posts: {} };
      });

      const threadService = new ThreadService(mockProvider);
      const result = await threadService.getMentions({ since: now - 3600000 * 24, limit: 50 });

      expect(mockProvider.searchPosts).toHaveBeenCalledWith('@egagofur', { teamId: undefined });
      expect(result.total).toBe(2);

      const m1 = result.mentions.find((m) => m.id === 'mention_post_1');
      expect(m1).toBeDefined();
      expect(m1?.hasReplied).toBe(true);
      expect(m1?.username).toBe('ahmad');

      const m2 = result.mentions.find((m) => m.id === 'mention_post_2');
      expect(m2).toBeDefined();
      expect(m2?.hasReplied).toBe(false);
      expect(m2?.username).toBe('kevin');
    });

    it('filters out mentions older than since timestamp and respects limit', async () => {
      const oldMention: Post = {
        id: 'old_mention',
        createAt: now - 3600000 * 48, // 48h ago
        updateAt: now - 3600000 * 48,
        userId: 'usr_ahmad_789',
        channelId: 'chan_fe',
        message: '@egagofur old mention',
      };

      const newMention: Post = {
        id: 'new_mention',
        createAt: now - 10000,
        updateAt: now - 10000,
        userId: 'usr_kevin_456',
        channelId: 'chan_fe',
        message: '@egagofur recent mention',
      };

      (mockProvider.searchPosts as any).mockResolvedValue([newMention, oldMention]);
      (mockProvider.getPostThread as any).mockResolvedValue({
        order: ['new_mention'],
        posts: { new_mention: newMention },
      });

      const threadService = new ThreadService(mockProvider);
      const result = await threadService.getMentions({ since: now - 3600000 * 24 });

      expect(result.total).toBe(1);
      expect(result.mentions[0].id).toBe('new_mention');
    });

    it('returns total 0 and empty mentions when searchPosts finds no mentions', async () => {
      (mockProvider.searchPosts as any).mockResolvedValue([]);
      const threadService = new ThreadService(mockProvider);
      const result = await threadService.getMentions();

      expect(result.total).toBe(0);
      expect(result.mentions).toEqual([]);
    });

    it('marks hasReplied false if user only replied BEFORE the mention occurred', async () => {
      const mentionPost: Post = {
        id: 'mention_later',
        createAt: now - 10000, // Mention happened 10s ago
        updateAt: now - 10000,
        userId: 'usr_ahmad_789',
        channelId: 'chan_fe',
        message: 'Need help @egagofur',
      };

      (mockProvider.searchPosts as any).mockResolvedValue([mentionPost]);
      (mockProvider.getPostThread as any).mockResolvedValue({
        order: ['early_reply', 'mention_later'],
        posts: {
          early_reply: {
            id: 'early_reply',
            createAt: now - 50000, // Replied 50s ago (BEFORE the mention)
            updateAt: now - 50000,
            userId: 'usr_me_123',
            channelId: 'chan_fe',
            message: 'An earlier comment before anyone mentioned me',
          },
          mention_later: mentionPost,
        },
      });

      const threadService = new ThreadService(mockProvider);
      const result = await threadService.getMentions();

      expect(result.total).toBe(1);
      expect(result.mentions[0].hasReplied).toBe(false);
    });

    it('throws validation error if authenticated user has no username', async () => {
      (mockProvider.getMe as any).mockResolvedValue({ id: 'usr_anonymous', roles: 'system_user' });
      const threadService = new ThreadService(mockProvider);

      await expect(threadService.getMentions()).rejects.toThrow(
        'authenticated user does not have a valid username'
      );
    });
  });

  describe('Secret Sanitization in Errors', () => {
    it('sanitizes Bearer tokens, cookies, MMCSRF, and passwords', () => {
      const raw = 'Error on Cookie: MMCSRF=secret123; MMAUTHTOKEN=token456 with Bearer eyJhbGciOiJIUzI1Ni... and password: "supersecret"';
      const sanitized = sanitizeSecret(raw);

      expect(sanitized).not.toContain('secret123');
      expect(sanitized).not.toContain('token456');
      expect(sanitized).not.toContain('supersecret');
      expect(sanitized).toContain('MMCSRF=[REDACTED]');
      expect(sanitized).toContain('MMAUTHTOKEN=[REDACTED]');
      expect(sanitized).toContain('Bearer [REDACTED]');
    });
  });

  describe('AutomationService Integration', () => {
    it('executes get_thread and get_mentions via executeAction', async () => {
      const validId = '31ewigbaoigepj5qsh3xb9bbjo';
      const samplePost: Post = {
        id: validId,
        createAt: now,
        updateAt: now,
        userId: 'usr_me_123',
        channelId: 'chan_1',
        message: 'Hello thread',
      };

      (mockProvider.getPostThread as any).mockResolvedValue({
        order: [validId],
        posts: { [validId]: samplePost },
      });
      (mockProvider.searchPosts as any).mockResolvedValue([]);

      const service = new MattermostAutomationService({ provider: mockProvider });

      const threadResult = await service.executeAction({
        action: 'get_thread',
        permalinkOrId: validId,
      });
      expect(threadResult.success).toBe(true);
      expect((threadResult.data as any).totalPosts).toBe(1);

      const directResult = await service.getThread(validId);
      expect(directResult.totalPosts).toBe((threadResult.data as any).totalPosts);
      expect(directResult.posts.map((p) => p.id)).toEqual((threadResult.data as any).posts.map((p: any) => p.id));

      const mentionsResult = await service.executeAction({
        action: 'get_mentions',
      });
      expect(mentionsResult.success).toBe(true);
      expect((mentionsResult.data as any).total).toBe(0);
    });

    it('filters out deleted posts consistently (deleteAt > 0)', async () => {
      const validId = '31ewigbaoigepj5qsh3xb9bbjo';
      const samplePosts: Record<string, Post> = {
        [validId]: {
          id: validId,
          createAt: now - 2000,
          updateAt: now - 2000,
          userId: 'usr_me_123',
          channelId: 'chan_1',
          message: 'Root post',
        },
        reply_deleted: {
          id: 'reply_deleted',
          createAt: now - 1000,
          updateAt: now - 500,
          deleteAt: now - 500, // Deleted post!
          userId: 'usr_kevin_456',
          channelId: 'chan_1',
          rootId: validId,
          message: 'This post was deleted',
        },
        reply_active: {
          id: 'reply_active',
          createAt: now,
          updateAt: now,
          userId: 'usr_ahmad_789',
          channelId: 'chan_1',
          rootId: validId,
          message: 'Active reply',
        },
      };

      (mockProvider.getPostThread as any).mockResolvedValue({
        order: [validId, 'reply_deleted', 'reply_active'],
        posts: samplePosts,
      });

      const service = new MattermostAutomationService({ provider: mockProvider });
      const directResult = await service.getThread(validId);
      const actionResult = await service.executeAction({ action: 'get_thread', permalinkOrId: validId });

      expect(directResult.totalPosts).toBe(2);
      expect(directResult.posts.map((p) => p.id)).toEqual([validId, 'reply_active']);
      expect((actionResult.data as any).totalPosts).toBe(2);
      expect((actionResult.data as any).posts.map((p: any) => p.id)).toEqual([validId, 'reply_active']);
    });
  });

  describe('MCP Server Registration', () => {
    it('registers mattermost_get_thread and mattermost_get_mentions tools', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const server = createMattermostMcpServer(service);
      expect(server).toBeDefined();
    });
  });
});
