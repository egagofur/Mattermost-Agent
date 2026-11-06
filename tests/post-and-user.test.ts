import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadService } from '../src/infrastructure/mattermost/services/thread-service';
import { MattermostProvider } from '../src/domain/mattermost/providers/mattermost-provider.interface';
import { Post, User, UserProfileResult } from '../src/domain/mattermost/entities';
import { MattermostAutomationService } from '../src/application/mattermost/services/automation-service';
import { MattermostValidationError } from '../src/domain/mattermost/errors';
import { createMattermostMcpServer } from '../src/mcp/server';
import { MattermostActionSchema } from '../src/application/mattermost/dto/action-schemas';

describe('Phase 2 - Post Context & User Profile Tools', () => {
  let mockProvider: MattermostProvider;
  const now = Date.now();
  const targetPostId = '31ewigbaoigepj5qsh3xb9bbjo';

  const mockUsers: User[] = [
    { id: 'usr_me_123', username: 'egagofur', roles: 'system_user' },
    { id: 'usr_kevin_456', username: 'kevin', roles: 'system_user' },
    { id: 'usr_ahmad_789', username: 'ahmad', roles: 'system_user' },
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
      getPost: vi.fn(),
      getChannelPosts: vi.fn(),
      getUser: vi.fn(),
    };
  });

  describe('ThreadService.getPostWithContext', () => {
    it('retrieves target post and context before/after with resolved usernames', async () => {
      const targetPost: Post = {
        id: targetPostId,
        channelId: 'chan_main_123',
        userId: 'usr_me_123',
        message: 'Main target message',
        createAt: now,
        updateAt: now,
      };

      const beforePosts: Post[] = [
        {
          id: 'p_before_1',
          channelId: 'chan_main_123',
          userId: 'usr_kevin_456',
          message: 'Previous message from kevin',
          createAt: now - 10000,
          updateAt: now - 10000,
        },
      ];

      const afterPosts: Post[] = [
        {
          id: 'p_after_1',
          channelId: 'chan_main_123',
          userId: 'usr_ahmad_789',
          message: 'Following message from ahmad',
          createAt: now + 10000,
          updateAt: now + 10000,
        },
      ];

      (mockProvider.getPost as any).mockResolvedValue(targetPost);
      (mockProvider.getChannelPosts as any).mockImplementation(async (_chanId: string, opts: any) => {
        if (opts.before) return beforePosts;
        if (opts.after) return afterPosts;
        return [];
      });

      const threadService = new ThreadService(mockProvider);
      const result = await threadService.getPostWithContext(targetPostId, 3);

      expect(mockProvider.getPost).toHaveBeenCalledWith(targetPostId);
      expect(result.post.id).toBe(targetPostId);
      expect(result.post.username).toBe('egagofur');
      expect(result.before.length).toBe(1);
      expect(result.before[0].username).toBe('kevin');
      expect(result.after.length).toBe(1);
      expect(result.after[0].username).toBe('ahmad');
      expect(result.totalContextPosts).toBe(2);
    });

    it('extracts post ID from full permalink URL correctly', async () => {
      const permalink = `https://workspace.dot.co.id/dot-indonesia/pl/${targetPostId}`;
      const targetPost: Post = {
        id: targetPostId,
        channelId: 'chan_main_123',
        userId: 'usr_me_123',
        message: 'From permalink',
        createAt: now,
        updateAt: now,
      };
      (mockProvider.getPost as any).mockResolvedValue(targetPost);
      (mockProvider.getChannelPosts as any).mockResolvedValue([]);

      const threadService = new ThreadService(mockProvider);
      const result = await threadService.getPostWithContext(permalink, 0);

      expect(result.post.id).toBe(targetPostId);
      expect(mockProvider.getChannelPosts).not.toHaveBeenCalled();
    });

    it('throws validation error if post is deleted (deleteAt > 0)', async () => {
      const targetPost: Post = {
        id: targetPostId,
        channelId: 'chan_main_123',
        userId: 'usr_me_123',
        message: 'Deleted post',
        createAt: now,
        updateAt: now,
        deleteAt: now,
      };
      (mockProvider.getPost as any).mockResolvedValue(targetPost);

      const threadService = new ThreadService(mockProvider);
      await expect(threadService.getPostWithContext(targetPostId)).rejects.toThrow(
        `Post '${targetPostId}' has been deleted.`
      );
    });
  });

  describe('AutomationService.getUser', () => {
    it('fetches user profile successfully', async () => {
      const mockProfile: UserProfileResult = {
        id: 'usr_kevin_456',
        username: 'kevin',
        email: 'kevin@example.com',
        firstName: 'Kevin',
        lastName: 'San',
        position: 'Backend Lead',
        roles: 'system_user',
      };
      (mockProvider.getUser as any).mockResolvedValue(mockProfile);

      const automationService = new MattermostAutomationService({ provider: mockProvider });
      const result = await automationService.getUser('@kevin');

      expect(mockProvider.getUser).toHaveBeenCalledWith('@kevin');
      expect(result.username).toBe('kevin');
      expect(result.position).toBe('Backend Lead');
    });
  });

  describe('MattermostActionSchema parsing', () => {
    it('parses get_post action payload successfully', () => {
      const payload = {
        action: 'get_post',
        postIdOrPermalink: targetPostId,
        context: 5,
      };
      const parsed = MattermostActionSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
    });

    it('parses get_user action payload successfully', () => {
      const payload = {
        action: 'get_user',
        usernameOrId: 'egagofur',
      };
      const parsed = MattermostActionSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
    });
  });

  describe('MCP Tools: mattermost_get_post and mattermost_get_user', () => {
    it('handles mattermost_get_post MCP call', async () => {
      (mockProvider.getPost as any).mockResolvedValue({
        id: targetPostId,
        channelId: 'chan_1',
        userId: 'usr_me_123',
        message: 'Hello post MCP',
        createAt: now,
        updateAt: now,
      });
      (mockProvider.getChannelPosts as any).mockResolvedValue([]);

      const automationService = new MattermostAutomationService({ provider: mockProvider });
      const mcpServer = createMattermostMcpServer(automationService);
      const handler = (mcpServer as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_get_post',
          arguments: {
            postIdOrPermalink: targetPostId,
            context: 2,
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.post.id).toBe(targetPostId);
      expect(content.post.message).toBe('Hello post MCP');
    });

    it('handles mattermost_get_user MCP call', async () => {
      (mockProvider.getUser as any).mockResolvedValue({
        id: 'usr_ahmad_789',
        username: 'ahmad',
        position: 'QA Engineer',
      });

      const automationService = new MattermostAutomationService({ provider: mockProvider });
      const mcpServer = createMattermostMcpServer(automationService);
      const handler = (mcpServer as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_get_user',
          arguments: {
            usernameOrId: 'ahmad',
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.username).toBe('ahmad');
      expect(content.position).toBe('QA Engineer');
    });
  });
});
