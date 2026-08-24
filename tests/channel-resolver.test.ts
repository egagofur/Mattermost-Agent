import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelResolver } from '../src/infrastructure/mattermost/services/channel-resolver';
import { ChannelConfigLoader } from '../src/infrastructure/mattermost/services/channel-config-loader';
import { MattermostProvider } from '../src/domain/mattermost/providers/mattermost-provider.interface';
import { MattermostChannelNotFoundError } from '../src/domain/mattermost/errors';
import { Channel } from '../src/domain/mattermost/entities';

describe('ChannelResolver', () => {
  let mockProvider: MattermostProvider;
  let sampleChannels: Channel[];

  beforeEach(() => {
    sampleChannels = [
      {
        id: '7x8y9z1234567890abcdef1234',
        name: 'town-square',
        displayName: 'Town Square',
        type: 'O',
        teamId: 'team-1',
      },
      {
        id: '8a9b0c1234567890abcdef5678',
        name: 'engineering',
        displayName: 'Engineering Team',
        type: 'P',
        teamId: 'team-1',
      },
      {
        id: '9b0c1d1234567890abcdef9999',
        name: 'dotify-backend',
        displayName: 'Dotify Backend Dev',
        type: 'P',
        teamId: 'team-dot-dev',
      },
    ];

    mockProvider = {
      getMe: vi.fn(),
      getChannel: vi.fn().mockImplementation(async (input) => {
        if (input.channelId) {
          const found = sampleChannels.find((c) => c.id === input.channelId);
          if (found) return found;
        }
        if (input.channelName) {
          const found = sampleChannels.find((c) => c.name === input.channelName);
          if (found) return found;
        }
        throw new Error('Not found');
      }),
      listChannels: vi.fn().mockResolvedValue(sampleChannels),
      sendMessage: vi.fn(),
      replyToMessage: vi.fn(),
      getMessages: vi.fn(),
    };
  });

  it('resolves direct 26-character Channel ID and caches it', async () => {
    const resolver = new ChannelResolver(mockProvider, { cacheTtlMs: 10000 });
    const channel = await resolver.resolve('7x8y9z1234567890abcdef1234');

    expect(channel.name).toBe('town-square');
    expect(mockProvider.getChannel).toHaveBeenCalledWith({ channelId: '7x8y9z1234567890abcdef1234' });

    // Second call should hit cache without calling provider again
    const cached = await resolver.resolve('7x8y9z1234567890abcdef1234');
    expect(cached.id).toBe(channel.id);
    expect(mockProvider.getChannel).toHaveBeenCalledTimes(1);
  });

  it('resolves channel name by searching channel list', async () => {
    const resolver = new ChannelResolver(mockProvider);
    const channel = await resolver.resolve('engineering');

    expect(channel.id).toBe('8a9b0c1234567890abcdef5678');
    expect(channel.displayName).toBe('Engineering Team');
  });

  it('normalizes leading ~ character', async () => {
    const resolver = new ChannelResolver(mockProvider);
    const channel = await resolver.resolve('~engineering');

    expect(channel.id).toBe('8a9b0c1234567890abcdef5678');
  });

  it('resolves alias via YAML mapping configuration', async () => {
    const configLoader = new ChannelConfigLoader();
    configLoader.loadFromContent(`
channels:
  backend-dev:
    channel: dotify-backend
    team: team-dot-dev
`);

    const resolver = new ChannelResolver(mockProvider, { configLoader });
    const channel = await resolver.resolve('backend-dev');

    expect(channel.id).toBe('9b0c1d1234567890abcdef9999');
    expect(channel.name).toBe('dotify-backend');
  });

  it('resolves to fallback_channel when target channel cannot be found', async () => {
    const configLoader = new ChannelConfigLoader();
    configLoader.loadFromContent(`
fallback_channel: town-square
channels:
  non-existent: ghost-channel
`);

    const resolver = new ChannelResolver(mockProvider, { configLoader });
    const channel = await resolver.resolve('non-existent');

    expect(channel.name).toBe('town-square');
  });

  it('throws MattermostChannelNotFoundError when channel and fallback cannot be found', async () => {
    const emptyLoader = new ChannelConfigLoader({ configPath: 'empty-test.yml' });
    const resolver = new ChannelResolver(mockProvider, { configLoader: emptyLoader });
    await expect(resolver.resolve('totally-unknown-channel')).rejects.toThrow(
      MattermostChannelNotFoundError
    );
  });
});
