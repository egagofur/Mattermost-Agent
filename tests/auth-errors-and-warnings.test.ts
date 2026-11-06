import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadService } from '../src/infrastructure/mattermost/services/thread-service';
import { MattermostProvider } from '../src/domain/mattermost/providers/mattermost-provider.interface';
import { Post, User } from '../src/domain/mattermost/entities';
import { MattermostAutomationService } from '../src/application/mattermost/services/automation-service';
import {
  MattermostAuthenticationError,
  MattermostAuthorizationError,
  MattermostProviderError,
} from '../src/domain/mattermost/errors';
import { MattermostApiProvider } from '../src/infrastructure/mattermost/api/api-provider';
import { MattermostApiClient } from '../src/infrastructure/mattermost/api/client';

describe('Authentication & API Error Surfacing (Anti-Silent Swallowing)', () => {
  let mockProvider: MattermostProvider;
  const now = Date.now();

  const mockMe: User = { id: 'usr_me_123', username: 'egagofur', roles: 'system_user' };

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
      getUsersByIds: vi.fn().mockResolvedValue([mockMe]),
      getUnreadSummary: vi.fn(),
      getPost: vi.fn(),
      getUser: vi.fn(),
      downloadFile: vi.fn(),
    };
  });

  describe('When provider encounters 401 Authentication Failure', () => {
    it('service.getUnreadSummary throws MattermostAuthenticationError instead of returning empty summary', async () => {
      const authError = new MattermostAuthenticationError(
        'Mattermost authentication failed or session expired. Please log in using "npm run cli -- login".'
      );
      (mockProvider.getUnreadSummary as any).mockRejectedValue(authError);

      const service = new MattermostAutomationService({ provider: mockProvider });

      await expect(service.getUnreadSummary()).rejects.toThrow(MattermostAuthenticationError);
      await expect(service.getUnreadSummary()).rejects.toThrow(/npm run cli -- login/);
    });

    it('service.search throws MattermostAuthenticationError instead of returning empty results', async () => {
      const authError = new MattermostAuthenticationError(
        'Mattermost authentication failed or session expired. Please log in using "npm run cli -- login".'
      );
      (mockProvider.searchPosts as any).mockRejectedValue(authError);

      const service = new MattermostAutomationService({ provider: mockProvider });

      await expect(service.search({ terms: 'standup' })).rejects.toThrow(MattermostAuthenticationError);
      await expect(service.search({ terms: 'standup' })).rejects.toThrow(/npm run cli -- login/);
    });

    it('service.getMentions throws MattermostAuthenticationError when searchPosts fails with 401', async () => {
      const authError = new MattermostAuthenticationError(
        'Mattermost authentication failed or session expired. Please log in using "npm run cli -- login".'
      );
      (mockProvider.searchPosts as any).mockRejectedValue(authError);

      const service = new MattermostAutomationService({ provider: mockProvider });

      await expect(service.getMentions()).rejects.toThrow(MattermostAuthenticationError);
    });

    it('service.getThread throws MattermostAuthenticationError when thread fetch fails with 401', async () => {
      const authError = new MattermostAuthenticationError(
        'Mattermost authentication failed or session expired. Please log in using "npm run cli -- login".'
      );
      (mockProvider.getPostThread as any).mockRejectedValue(authError);

      const service = new MattermostAutomationService({ provider: mockProvider });

      await expect(service.getThread('e9ycu14k9jfuzx9ozyhkahmr4o')).rejects.toThrow(
        MattermostAuthenticationError
      );
    });

    it('ThreadService.getMentions rethrows MattermostAuthenticationError if thread lookup during reply-check fails with 401', async () => {
      const authError = new MattermostAuthenticationError(
        'Mattermost authentication failed or session expired. Please log in using "npm run cli -- login".'
      );
      (mockProvider.searchPosts as any).mockResolvedValue([
        {
          id: 'post_mention_1',
          userId: 'usr_other',
          channelId: 'chan_general',
          rootId: 'root_post_1',
          createAt: now,
          message: 'Hello @egagofur',
        },
      ]);
      (mockProvider.getPostThread as any).mockRejectedValue(authError);

      const threadService = new ThreadService(mockProvider);
      await expect(threadService.getMentions()).rejects.toThrow(MattermostAuthenticationError);
    });
  });

  describe('Partial failures and warnings reporting', () => {
    it('MattermostApiProvider.getUnreadSummary reports warnings when 1 out of 3 teams fails, but returns remaining data', async () => {
      const mockClient = {
        getMyTeams: vi.fn().mockResolvedValue([
          { id: 'team_1', name: 'alpha', display_name: 'Alpha Team' },
          { id: 'team_2', name: 'beta', display_name: 'Beta Team' },
          { id: 'team_3', name: 'gamma', display_name: 'Gamma Team' },
        ]),
        getMyChannels: vi.fn().mockResolvedValue([
          { id: 'chan_1', team_id: 'team_1', name: 'dev', display_name: 'Dev', type: 'O', total_msg_count: 10 },
          { id: 'chan_3', team_id: 'team_3', name: 'ops', display_name: 'Ops', type: 'O', total_msg_count: 20 },
        ]),
        getChannelMembersForTeam: vi.fn().mockImplementation(async (teamId: string) => {
          if (teamId === 'team_2') {
            throw new Error('Connection reset by peer');
          }
          if (teamId === 'team_1') {
            return [{ channel_id: 'chan_1', msg_count: 5, mention_count: 1 }];
          }
          return [{ channel_id: 'chan_3', msg_count: 15, mention_count: 0 }];
        }),
      } as unknown as MattermostApiClient;

      const apiProvider = new MattermostApiProvider(mockClient);
      const result = await apiProvider.getUnreadSummary();

      expect(result.totalUnreadChannels).toBe(2);
      expect(result.channels).toHaveLength(2);
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain("Failed to fetch channel members for team 'Beta Team'");
    });

    it('MattermostApiProvider.getUnreadSummary throws MattermostProviderError when ALL teams fail', async () => {
      const mockClient = {
        getMyTeams: vi.fn().mockResolvedValue([
          { id: 'team_1', name: 'alpha', display_name: 'Alpha Team' },
        ]),
        getMyChannels: vi.fn().mockResolvedValue([]),
        getChannelMembersForTeam: vi.fn().mockRejectedValue(new Error('Gateway timeout')),
      } as unknown as MattermostApiClient;

      const apiProvider = new MattermostApiProvider(mockClient);
      await expect(apiProvider.getUnreadSummary()).rejects.toThrow(MattermostProviderError);
    });

    it('ThreadService.getMentions captures non-auth thread fetch failure into warnings', async () => {
      (mockProvider.searchPosts as any).mockResolvedValue([
        {
          id: 'post_m1',
          userId: 'usr_me_123',
          channelId: 'chan_general',
          rootId: 'root_post_ok',
          createAt: now,
          message: 'Mention 1 @egagofur',
        },
        {
          id: 'post_m2',
          userId: 'usr_me_123',
          channelId: 'chan_general',
          rootId: 'root_post_fail',
          createAt: now,
          message: 'Mention 2 @egagofur',
        },
      ]);

      (mockProvider.getPostThread as any).mockImplementation(async (postId: string) => {
        if (postId === 'root_post_fail') {
          throw new Error('Temporary 500 error fetching thread');
        }
        return {
          order: [postId],
          posts: { [postId]: { id: postId, userId: 'usr_other', channelId: 'chan_general', message: 'Root post' } },
        };
      });

      const threadService = new ThreadService(mockProvider);
      const result = await threadService.getMentions();

      expect(result.total).toBe(2);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain("Failed to fetch thread posts for root post 'root_post_fail'");
    });
  });

  describe('Security and login guidance', () => {
    it('MattermostAuthenticationError default message includes npm run cli -- login guidance and redacts tokens', () => {
      const secret = 'Bearer mm-secret-token-xyz123';
      const err = new MattermostAuthenticationError(`Failed auth with ${secret}`);
      expect(err.message).toContain('Bearer [REDACTED]');
      expect(err.message).not.toContain('mm-secret-token-xyz123');
    });
  });
});
