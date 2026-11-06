import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MattermostProvider } from '../src/domain/mattermost/providers/mattermost-provider.interface';
import { MattermostAutomationService } from '../src/application/mattermost/services/automation-service';
import { createMattermostMcpServer } from '../src/mcp/server';
import { MattermostActionSchema } from '../src/application/mattermost/dto/action-schemas';
import { Channel } from '../src/domain/mattermost/entities';

describe('Phase 2 - Reaction Tool & MCP Write Approval Guard', () => {
  let mockProvider: MattermostProvider;
  const samplePostId = '31ewigbaoigepj5qsh3xb9bbjo';
  const sampleChannel: Channel = {
    id: 'chan_general_123',
    name: 'general',
    displayName: 'General',
    type: 'O',
  };

  beforeEach(() => {
    mockProvider = {
      getMe: vi.fn().mockResolvedValue({ id: 'usr_me', username: 'egagofur', roles: 'system_user' }),
      getChannel: vi.fn().mockResolvedValue(sampleChannel),
      listChannels: vi.fn().mockResolvedValue([sampleChannel]),
      sendMessage: vi.fn().mockResolvedValue({
        id: 'msg_1',
        channelId: sampleChannel.id,
        userId: 'usr_me',
        message: 'Hello',
        createdAt: new Date(),
      }),
      replyToMessage: vi.fn().mockResolvedValue({
        id: 'msg_reply_1',
        channelId: sampleChannel.id,
        rootId: samplePostId,
        userId: 'usr_me',
        message: 'Reply',
        createdAt: new Date(),
      }),
      editMessage: vi.fn().mockResolvedValue({
        id: samplePostId,
        channelId: sampleChannel.id,
        userId: 'usr_me',
        message: 'Edited',
        updatedAt: new Date(),
      }),
      getMessages: vi.fn().mockResolvedValue([]),
      getPostThread: vi.fn(),
      searchPosts: vi.fn(),
      addReaction: vi.fn().mockResolvedValue({
        userId: 'usr_me',
        postId: samplePostId,
        emojiName: 'white_check_mark',
        createAt: Date.now(),
      }),
    };
  });

  describe('MCP Write Approval Guard for All Write Tools', () => {
    it('mattermost_send_message: returns draft_preview and blocks call without approved: true', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const server = createMattermostMcpServer(service);
      const handler = (server as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_send_message',
          arguments: {
            channel: 'general',
            message: 'Deploying to production',
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.status).toBe('draft_preview');
      expect(content.requiresApproval).toBe(true);
      expect(content.preview.channel).toBe('general');
      expect(content.preview.message).toBe('Deploying to production');
      expect(mockProvider.sendMessage).not.toHaveBeenCalled();
    });

    it('mattermost_send_message: dispatches and sends message when approved: true', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const server = createMattermostMcpServer(service);
      const handler = (server as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_send_message',
          arguments: {
            channel: 'general',
            message: 'Deploying to production',
            approved: true,
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.success).toBe(true);
      expect(mockProvider.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('mattermost_reply_thread: returns draft_preview and blocks call without approved: true', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const server = createMattermostMcpServer(service);
      const handler = (server as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_reply_thread',
          arguments: {
            channel: 'general',
            rootId: samplePostId,
            message: 'Looks great!',
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.status).toBe('draft_preview');
      expect(content.requiresApproval).toBe(true);
      expect(mockProvider.replyToMessage).not.toHaveBeenCalled();
      expect(mockProvider.sendMessage).not.toHaveBeenCalled();
    });

    it('mattermost_reply_thread: dispatches reply when approved: true', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const server = createMattermostMcpServer(service);
      const handler = (server as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_reply_thread',
          arguments: {
            channel: 'general',
            rootId: samplePostId,
            message: 'Looks great!',
            approved: true,
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.success).toBe(true);
      expect(mockProvider.replyToMessage).toHaveBeenCalledTimes(1);
    });

    it('mattermost_edit_message: returns draft_preview and blocks call without approved: true', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const server = createMattermostMcpServer(service);
      const handler = (server as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_edit_message',
          arguments: {
            postId: samplePostId,
            message: 'Updated content',
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.status).toBe('draft_preview');
      expect(content.requiresApproval).toBe(true);
      expect(mockProvider.editMessage).not.toHaveBeenCalled();
    });

    it('mattermost_edit_message: dispatches edit when approved: true', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const server = createMattermostMcpServer(service);
      const handler = (server as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_edit_message',
          arguments: {
            postId: samplePostId,
            message: 'Updated content',
            approved: true,
          },
        },
      });

      expect(res.isError).toBeFalsy();
      expect(mockProvider.editMessage).toHaveBeenCalledTimes(1);
    });

    it('mattermost_add_reaction: returns draft_preview and blocks call without approved: true', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const server = createMattermostMcpServer(service);
      const handler = (server as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_add_reaction',
          arguments: {
            postIdOrPermalink: samplePostId,
            emojiName: 'white_check_mark',
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.status).toBe('draft_preview');
      expect(content.requiresApproval).toBe(true);
      expect(content.preview.emojiName).toBe('white_check_mark');
      expect(mockProvider.addReaction).not.toHaveBeenCalled();
    });

    it('mattermost_add_reaction: dispatches reaction when approved: true', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const server = createMattermostMcpServer(service);
      const handler = (server as any)._requestHandlers.get('tools/call');

      const res = await handler({
        method: 'tools/call',
        params: {
          name: 'mattermost_add_reaction',
          arguments: {
            postIdOrPermalink: samplePostId,
            emojiName: 'white_check_mark',
            approved: true,
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const content = JSON.parse(res.content[0].text);
      expect(content.success).toBe(true);
      expect(mockProvider.addReaction).toHaveBeenCalledWith(samplePostId, 'white_check_mark');
    });
  });

  describe('AddReactionActionSchema & AutomationService execution', () => {
    it('parses add_reaction action payload successfully', () => {
      const payload = {
        action: 'add_reaction',
        postIdOrPermalink: samplePostId,
        emojiName: ':thumbsup:',
      };
      const parsed = MattermostActionSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
    });

    it('executes add_reaction via executeAction directly (CLI/API mode)', async () => {
      const service = new MattermostAutomationService({ provider: mockProvider });
      const result = await service.executeAction({
        action: 'add_reaction',
        postIdOrPermalink: samplePostId,
        emojiName: 'eyes',
      });

      expect(result.success).toBe(true);
      expect(mockProvider.addReaction).toHaveBeenCalledWith(samplePostId, 'eyes');
    });
  });
});
