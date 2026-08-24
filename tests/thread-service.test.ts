import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThreadService } from '../src/infrastructure/mattermost/services/thread-service';
import { MattermostProvider } from '../src/domain/mattermost/providers/mattermost-provider.interface';
import { Post } from '../src/domain/mattermost/entities';
import * as path from 'path';
import * as fs from 'fs';

describe('ThreadService', () => {
  const tempDir = path.resolve(__dirname, 'temp_state');
  let mockProvider: MattermostProvider;
  let samplePosts: Post[];

  beforeEach(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const now = Date.now();
    samplePosts = [
      // Thread 1: Daily Standup (2 replies)
      {
        id: 'post_root_1',
        createAt: now - 3600000 * 3, // 3h ago
        updateAt: now - 3600000 * 3,
        userId: 'usr_ahmad',
        channelId: 'chan_fe',
        message: 'Daily Standup 24 August 2026',
      },
      {
        id: 'post_reply_1_1',
        createAt: now - 3600000 * 2, // 2h ago
        updateAt: now - 3600000 * 2,
        userId: 'usr_kevin',
        channelId: 'chan_fe',
        rootId: 'post_root_1',
        message: 'Hadir mas, task hari ini fix bug',
      },
      {
        id: 'post_reply_1_2',
        createAt: now - 3600000 * 1, // 1h ago
        updateAt: now - 3600000 * 1,
        userId: 'usr_ega',
        channelId: 'chan_fe',
        rootId: 'post_root_1',
        message: 'Hadir, lanjut deploy PR #4',
      },

      // Thread 2: Release notes (0 replies, most recent starter)
      {
        id: 'post_root_2',
        createAt: now - 60000 * 10, // 10m ago
        updateAt: now - 60000 * 10,
        userId: 'usr_ega',
        channelId: 'chan_fe',
        message: 'Release v1.2.0 is now live in staging!',
      },
    ];

    mockProvider = {
      getMe: vi.fn(),
      getChannel: vi.fn(),
      listChannels: vi.fn(),
      sendMessage: vi.fn(),
      replyToMessage: vi.fn(),
      getMessages: vi.fn().mockResolvedValue(samplePosts),
    };
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('groups posts into threads with reply counts and relative times', async () => {
    const threadService = new ThreadService(mockProvider, undefined, tempDir);
    const threads = await threadService.getChannelThreads('chan_fe');

    expect(threads).toHaveLength(2);
    // Thread 2 is most recent (10m ago vs 1h ago last reply)
    expect(threads[0].rootId).toBe('post_root_2');
    expect(threads[0].index).toBe(1);
    expect(threads[0].replyCount).toBe(0);

    expect(threads[1].rootId).toBe('post_root_1');
    expect(threads[1].index).toBe(2);
    expect(threads[1].replyCount).toBe(2);
    expect(threads[1].lastReplySnippet).toContain('Hadir, lanjut deploy');
  });

  it('extracts post ID from Mattermost permalink URLs', () => {
    const url = 'https://mattermost.example.com/core-team/pl/31ewigbaoigepj5qsh3xb9bbjo';
    const extracted = ThreadService.extractPostIdFromPermalink(url);
    expect(extracted).toBe('31ewigbaoigepj5qsh3xb9bbjo');

    const directHash = '31ewigbaoigepj5qsh3xb9bbjo';
    expect(ThreadService.extractPostIdFromPermalink(directHash)).toBe('31ewigbaoigepj5qsh3xb9bbjo');
  });

  it('resolves :1 and :latest shortcuts to the most recent thread', async () => {
    const threadService = new ThreadService(mockProvider, undefined, tempDir);

    const rootId1 = await threadService.resolveRootId({ channelId: 'chan_fe', targetIdentifier: ':1' });
    expect(rootId1).toBe('post_root_2');

    const rootIdLatest = await threadService.resolveRootId({ channelId: 'chan_fe', targetIdentifier: ':latest' });
    expect(rootIdLatest).toBe('post_root_2');
  });

  it('resolves numbered shortcut :2 to the second thread', async () => {
    const threadService = new ThreadService(mockProvider, undefined, tempDir);
    const rootId2 = await threadService.resolveRootId({ channelId: 'chan_fe', targetIdentifier: ':2' });
    expect(rootId2).toBe('post_root_1');
  });

  it('resolves thread by search query keyword', async () => {
    const threadService = new ThreadService(mockProvider, undefined, tempDir);
    const rootId = await threadService.resolveRootId({
      channelId: 'chan_fe',
      findQuery: 'Standup',
    });
    expect(rootId).toBe('post_root_1');
  });

  it('saves and resolves :last thread state', async () => {
    const threadService = new ThreadService(mockProvider, undefined, tempDir);

    threadService.saveLastThread({
      messageId: 'post_last_999',
      channelId: 'chan_fe',
      updatedAt: new Date().toISOString(),
    });

    const rootId = await threadService.resolveRootId({
      channelId: 'chan_fe',
      targetIdentifier: ':last',
    });

    expect(rootId).toBe('post_last_999');
  });
});
