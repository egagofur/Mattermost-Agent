import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MattermostAutomationService } from '../src/application/mattermost/services/automation-service';
import { MattermostProvider } from '../src/domain/mattermost/providers/mattermost-provider.interface';
import { MattermostChannelNotFoundError } from '../src/domain/mattermost/errors';
import { loadConfig } from '../src/config/env';

describe('MattermostAutomationService', () => {
  let mockProvider: MattermostProvider;

  beforeEach(() => {
    mockProvider = {
      getMe: vi.fn().mockResolvedValue({
        id: 'usr_correct_123',
        username: 'egagofur',
        roles: 'system_user',
      }),
      getChannel: vi.fn().mockResolvedValue({
        id: 'chan_eng_1234567890abcdef',
        name: 'engineering',
        displayName: 'Engineering',
        type: 'O',
      }),
      listChannels: vi.fn().mockResolvedValue([
        {
          id: 'chan_eng_1234567890abcdef',
          name: 'engineering',
          displayName: 'Engineering',
          type: 'O',
        },
      ]),
      sendMessage: vi.fn().mockResolvedValue({
        id: 'post_123',
        channelId: 'chan_eng_1234567890abcdef',
        userId: 'usr_correct_123',
        message: 'Test message',
        createdAt: new Date(),
      }),
      replyToMessage: vi.fn().mockResolvedValue({
        id: 'post_124',
        channelId: 'chan_eng_1234567890abcdef',
        userId: 'usr_correct_123',
        rootId: 'post_123',
        message: 'Test reply',
        createdAt: new Date(),
      }),
      editMessage: vi.fn().mockResolvedValue({
        id: 'wou41djpziyw9kgngtjzy9s1be',
        channelId: 'chan_eng_1234567890abcdef',
        userId: 'usr_correct_123',
        message: 'Edited message content',
        updatedAt: new Date(),
      }),
      getMessages: vi.fn().mockResolvedValue([]),
    };
  });

  it('runs whoami successfully', async () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'token-123',
      MATTERMOST_EXPECTED_USER_ID: 'usr_correct_123',
    });

    const service = new MattermostAutomationService({ config, provider: mockProvider });
    const user = await service.whoami();

    expect(user.id).toBe('usr_correct_123');
    expect(user.username).toBe('egagofur');
  });

  it('fails whoami when expected user ID does not match', async () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'token-123',
      MATTERMOST_EXPECTED_USER_ID: 'usr_different_456',
    });

    const service = new MattermostAutomationService({ config, provider: mockProvider });
    await expect(service.whoami()).rejects.toThrow(/does not match expected user ID/);
  });

  it('sends message and resolves channel name', async () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'token-123',
    });

    const service = new MattermostAutomationService({ config, provider: mockProvider });
    const result = await service.sendMessage({
      channel: 'engineering',
      message: 'MR !123 ready',
    });

    expect(result.id).toBe('post_123');
    expect(result.channelId).toBe('chan_eng_1234567890abcdef');
    expect(mockProvider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'chan_eng_1234567890abcdef',
        message: 'MR !123 ready',
      })
    );
  });

  it('throws MattermostChannelNotFoundError and does NOT send message when channel does not exist', async () => {
    (mockProvider.getChannel as any).mockRejectedValue(new Error('Channel not found'));
    (mockProvider.listChannels as any).mockResolvedValue([]);

    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'token-123',
    });

    const service = new MattermostAutomationService({ config, provider: mockProvider });
    await expect(
      service.sendMessage({
        channel: 'ghost-channel-xyz',
        message: 'This message must never be sent',
      })
    ).rejects.toThrow(MattermostChannelNotFoundError);

    expect(mockProvider.sendMessage).not.toHaveBeenCalled();
  });

  it('executes structured action payload safely returning ActionResult', async () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'token-123',
    });

    const service = new MattermostAutomationService({ config, provider: mockProvider });
    const actionResult = await service.executeAction({
      action: 'send_message',
      channel: 'engineering',
      message: 'Automated notification',
    });

    expect(actionResult.success).toBe(true);
    expect((actionResult.data as { id: string }).id).toBe('post_123');
  });

  it('returns structured error when action payload is invalid', async () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'token-123',
    });

    const service = new MattermostAutomationService({ config, provider: mockProvider });
    const actionResult = await service.executeAction({
      action: 'invalid_action_type',
    });

    expect(actionResult.success).toBe(false);
    expect(actionResult.error?.code).toBe('VALIDATION_ERROR');
  });

  it('edits message successfully with 26-char post ID', async () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'token-123',
    });

    const service = new MattermostAutomationService({ config, provider: mockProvider });
    const result = await service.editMessage({
      postId: 'wou41djpziyw9kgngtjzy9s1be',
      message: 'Updated message',
      from: 'AI Agent',
    });

    expect(result.id).toBe('wou41djpziyw9kgngtjzy9s1be');
    expect(mockProvider.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: 'wou41djpziyw9kgngtjzy9s1be',
        message: 'Updated message\n\n_~ from AI Agent_',
      })
    );
  });

  it('edits message successfully extracting post ID from permalink URL', async () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'token-123',
    });

    const service = new MattermostAutomationService({ config, provider: mockProvider });
    const result = await service.editMessage({
      postId: 'https://workspace.dot.co.id/dot-indonesia/pl/wou41djpziyw9kgngtjzy9s1be',
      message: 'Permalink edited message',
    });

    expect(result.id).toBe('wou41djpziyw9kgngtjzy9s1be');
    expect(mockProvider.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: 'wou41djpziyw9kgngtjzy9s1be',
        message: 'Permalink edited message',
      })
    );
  });

  it('executes edit_message action safely via executeAction', async () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'token-123',
    });

    const service = new MattermostAutomationService({ config, provider: mockProvider });
    const actionResult = await service.executeAction({
      action: 'edit_message',
      postId: 'wou41djpziyw9kgngtjzy9s1be',
      message: 'Action executor edit',
    });

    expect(actionResult.success).toBe(true);
    expect((actionResult.data as { id: string }).id).toBe('wou41djpziyw9kgngtjzy9s1be');
  });
});
