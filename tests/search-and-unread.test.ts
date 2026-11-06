import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadService } from '../src/infrastructure/mattermost/services/thread-service';
import { MattermostProvider } from '../src/domain/mattermost/providers/mattermost-provider.interface';
import { Post, User, UnreadSummaryResult } from '../src/domain/mattermost/entities';
import { MattermostAutomationService } from '../src/application/mattermost/services/automation-service';
import { MattermostValidationError } from '../src/domain/mattermost/errors';
import { createMattermostMcpServer } from '../src/mcp/server';
import { MattermostActionSchema } from '../src/application/mattermost/dto/action-schemas';

describe('Phase 2 - Search & Unread Summary Tools', () => {
  let mockProvider: MattermostProvider;
  const now = Date.now();

  const mockUsers: User[] = [
    { id: 'usr_me_123', username: 'egagofur', roles: 'system_user' },
    { id: 'usr_kevin_456', username: 'kevin', roles: 'system_user' },
  ];

  beforeEach(() => {
    mockProvider = {
      getMe: vi.fn().mockResolvedValue(mockUsers[0]),
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
      getUnreadSummary: vi.fn(),
    };
  });

  describe('ThreadService.searchPosts', () => {
    it('formats search query correctly with terms, from, in, after, before modifiers', async () => {
      const threadService = new ThreadService(mockProvider);
      (mockProvider.searchPosts as any).mockResolvedValue([
        {
          id: 'post_search_1',
          createAt: now,
          updateAt: now,
          userId: 'usr_kevin_456',
          channelId: 'chan_general',
          message: 'deploying backend to staging',
        },
      ]);

      const result = await threadService.searchPosts({
        terms: 'staging deploy',
        from: '@kevin',
        in: '~general',
        after: '2026-11-01',
        before: '2026-11-06',
        limit: 10,
      });

      expect(mockProvider.searchPosts).toHaveBeenCalledWith(
        'staging deploy from:kevin in:general after:2026-11-01 before:2026-11-06',
        { teamId: undefined, isOrSearch: undefined }
      );
      expect(result.total).toBe(1);
      expect(result.posts[0].username).toBe('kevin');
      expect(result.posts[0].message).toBe('deploying backend to staging');
    });

    it('throws MattermostValidationError when all search filters are empty', async () => {
      const threadService = new ThreadService(mockProvider);
      await expect(threadService.searchPosts({})).rejects.toThrow(MattermostValidationError);
      await expect(threadService.searchPosts({ terms: '   ' })).rejects.toThrow(MattermostValidationError);
      expect(mockProvider.searchPosts).not.toHaveBeenCalled();
    });

    it('filters out deleted posts and respects custom limit', async () => {
      const threadService = new ThreadService(mockProvider);
      const mockPosts: Post[] = [
        { id: 'p1', createAt: now, updateAt: now, userId: 'usr_kevin_456', channelId: 'c1', message: 'alive 1' },
        { id: 'p2', createAt: now, updateAt: now, userId: 'usr_kevin_456', channelId: 'c1', message: 'deleted', deleteAt: now },
        { id: 'p3', createAt: now, updateAt: now, userId: 'usr_kevin_456', channelId: 'c1', message: 'alive 2' },
        { id: 'p4', createAt: now, updateAt: now, userId: 'usr_kevin_456', channelId: 'c1', message: 'alive 3' },
      ];
      (mockProvider.searchPosts as any).mockResolvedValue(mockPosts);

      const result = await threadService.searchPosts({ terms: 'alive', limit: 2 });
      expect(result.total).toBe(2);
      expect(result.posts.map((p) => p.id)).toEqual(['p1', 'p3']);
    });
  });

  describe('AutomationService.getUnreadSummary', () => {
    it('returns unread summary from provider', async () => {
      const mockSummary: UnreadSummaryResult = {
        totalUnreadChannels: 2,
        channels: [
          {
            channelId: 'chan_urgent',
            channelName: 'urgent-ops',
            displayName: 'Urgent Ops',
            type: 'O',
            unreadCount: 5,
            mentionCount: 2,
            hasMention: true,
          },
          {
            channelId: 'chan_random',
            channelName: 'random',
            displayName: 'Random',
            type: 'O',
            unreadCount: 10,
            mentionCount: 0,
            hasMention: false,
          },
        ],
      };

      (mockProvider.getUnreadSummary as any).mockResolvedValue(mockSummary);
      const automationService = new MattermostAutomationService({ provider: mockProvider });

      const res = await automationService.getUnreadSummary();
      expect(res.totalUnreadChannels).toBe(2);
      expect(res.channels[0].hasMention).toBe(true);
      expect(res.channels[0].channelName).toBe('urgent-ops');
    });

    it('throws if provider does not support getUnreadSummary', async () => {
      delete (mockProvider as any).getUnreadSummary;
      const automationService = new MattermostAutomationService({ provider: mockProvider });
      await expect(automationService.getUnreadSummary()).rejects.toThrow(
        'The configured provider does not support retrieving unread summaries'
      );
    });
  });

  describe('MattermostActionSchema parsing', () => {
    it('parses search action payload successfully', () => {
      const payload = {
        action: 'search',
        terms: 'bugfix',
        from: 'egagofur',
        limit: 15,
      };
      const parsed = MattermostActionSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
    });

    it('parses unread_summary action payload successfully', () => {
      const payload = {
        action: 'unread_summary',
      };
      const parsed = MattermostActionSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
    });
  });

  describe('MCP Tools: mattermost_search and mattermost_unread_summary', () => {
    it('handles mattermost_search MCP call', async () => {
      (mockProvider.searchPosts as any).mockResolvedValue([
        {
          id: 'post_mcp_1',
          createAt: now,
          updateAt: now,
          userId: 'usr_me_123',
          channelId: 'chan_general',
          message: 'release ready',
        },
      ]);
      const automationService = new MattermostAutomationService({ provider: mockProvider });
      const mcpServer = createMattermostMcpServer(automationService);
      const handler = (mcpServer as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_search',
          arguments: {
            terms: 'release ready',
            limit: 5,
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.total).toBe(1);
      expect(content.posts[0].message).toBe('release ready');
    });

    it('handles mattermost_unread_summary MCP call', async () => {
      (mockProvider.getUnreadSummary as any).mockResolvedValue({
        totalUnreadChannels: 1,
        channels: [
          {
            channelId: 'chan_dev',
            channelName: 'development',
            displayName: 'Development',
            type: 'O',
            unreadCount: 3,
            mentionCount: 1,
            hasMention: true,
          },
        ],
      });
      const automationService = new MattermostAutomationService({ provider: mockProvider });
      const mcpServer = createMattermostMcpServer(automationService);
      const handler = (mcpServer as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_unread_summary',
          arguments: {},
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.totalUnreadChannels).toBe(1);
      expect(content.channels[0].channelName).toBe('development');
    });
  });
});
