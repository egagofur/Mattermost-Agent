import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MattermostAgentListener } from '../src/mattermost/listener';
import { MattermostClient, MattermostPost, MattermostUser } from '../src/mattermost/client';
import { AgentStateManager } from '../src/state/state-manager';
import { MockAgentExecutor } from '../src/agent/executor';
import { AgentTask } from '../src/agent/task';

describe('MattermostAgentListener (Integration & Executor Layer)', () => {
  const currentUserId = 'usr_ega_authenticated_123';
  const username = 'ega';

  let mockClient: MattermostClient;
  let stateManager: AgentStateManager;
  let mockExecutor: MockAgentExecutor;
  let listener: MattermostAgentListener;

  let createdPosts: Array<{ channel_id: string; message: string; root_id?: string; id: string }> = [];

  beforeEach(() => {
    createdPosts = [];

    // In-memory state manager without file persistence for isolated testing
    stateManager = new AgentStateManager({ filePath: './data/test-transient-state.json' });
    stateManager.clear();

    mockClient = {
      getMe: vi.fn().mockResolvedValue({
        id: currentUserId,
        username: 'ega',
        first_name: 'Ega',
        roles: 'system_user',
      } as MattermostUser),
      getMyChannels: vi.fn().mockResolvedValue([
        { id: 'chan_general_1', name: 'town-square', display_name: 'Town Square', type: 'O' },
      ]),
      getChannelPosts: vi.fn().mockResolvedValue({
        order: [],
        posts: {},
      }),
      getPostThread: vi.fn().mockResolvedValue({
        order: [],
        posts: {},
      }),
      createPost: vi.fn().mockImplementation(async (params) => {
        const id = `post_created_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const created = { ...params, id };
        createdPosts.push(created);
        return created;
      }),
    } as unknown as MattermostClient;

    mockExecutor = new MockAgentExecutor(async (task) => {
      return {
        success: true,
        message: `Executor response: ${task.instruction}`,
      };
    });

    listener = new MattermostAgentListener({
      client: mockClient,
      stateManager,
      executor: mockExecutor,
      username,
      pollIntervalSeconds: 5,
    });
  });

  it('MUST allow SELF-TRIGGERING when message is authored by the authenticated user', async () => {
    await listener.initialize();

    const humanSelfPost: MattermostPost = {
      id: 'post_human_self_1',
      create_at: Date.now(),
      user_id: currentUserId, // Authored by @ega (the authenticated user)
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@ega explain CQRS pattern',
    };

    const handled = await listener.handlePost(humanSelfPost);

    expect(handled).toBe(true);
    expect(mockClient.createPost).toHaveBeenCalledTimes(1);
    expect(createdPosts.length).toBe(1);
    expect(createdPosts[0].message).toBe('Executor response: explain CQRS pattern\n\n_~ from AI Agent_');
    expect(createdPosts[0].root_id).toBe('post_human_self_1'); // Replied to root
    expect(stateManager.isProcessed('post_human_self_1')).toBe(true);
  });

  it('MUST PREVENT AGENT SELF-LOOPS when polling encounters an agent-generated post', async () => {
    await listener.initialize();

    // 1. Human sends triggering message
    const triggerPost: MattermostPost = {
      id: 'post_trigger_1',
      create_at: Date.now(),
      user_id: currentUserId,
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@ega what is event sourcing?',
    };

    await listener.handlePost(triggerPost);
    expect(createdPosts.length).toBe(1);
    const generatedPostId = createdPosts[0].id;

    // Verify generated post is tracked in agent_generated_post_ids
    expect(stateManager.isAgentGenerated(generatedPostId)).toBe(true);

    // 2. Next polling cycle sees the agent's generated response post in the channel
    const agentPostSeenByPoller: MattermostPost = {
      id: generatedPostId,
      create_at: Date.now() + 1000,
      user_id: currentUserId, // Agent uses same user_id as human
      channel_id: 'chan_general_1',
      root_id: 'post_trigger_1',
      message: 'Executor response: what is event sourcing? Mentioning @ega for reference.',
    };

    const handledSecondTime = await listener.handlePost(agentPostSeenByPoller);

    // MUST NOT TRIGGER!
    expect(handledSecondTime).toBe(false);
    expect(mockClient.createPost).toHaveBeenCalledTimes(1); // No new post created
  });

  it('ignores posts that do NOT mention @username or mention someone else', async () => {
    await listener.initialize();

    const otherPost: MattermostPost = {
      id: 'post_other_user_1',
      create_at: Date.now(),
      user_id: 'usr_other_456',
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@john can you check the server logs?',
    };

    const handled = await listener.handlePost(otherPost);
    expect(handled).toBe(false);
    expect(mockClient.createPost).not.toHaveBeenCalled();
    expect(stateManager.isProcessed('post_other_user_1')).toBe(true);
  });

  it('deduplicates and does not re-process already processed posts', async () => {
    await listener.initialize();

    const post: MattermostPost = {
      id: 'post_test_dedup',
      create_at: Date.now(),
      user_id: 'usr_other_456',
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@ega summarize this',
    };

    const firstRun = await listener.handlePost(post);
    expect(firstRun).toBe(true);

    const secondRun = await listener.handlePost(post);
    expect(secondRun).toBe(false);
    expect(mockClient.createPost).toHaveBeenCalledTimes(1);
  });

  it('correctly handles root posts vs posts inside an existing thread', async () => {
    await listener.initialize();

    // 1. Root Post -> replies with root_id = post.id
    const rootPost: MattermostPost = {
      id: 'root_post_100',
      create_at: Date.now(),
      user_id: 'usr_user_1',
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@ega start new topic',
    };
    await listener.handlePost(rootPost);
    expect(createdPosts[0].root_id).toBe('root_post_100');

    // 2. Thread Message -> replies with root_id = post.root_id
    const threadPost: MattermostPost = {
      id: 'reply_post_200',
      create_at: Date.now(),
      user_id: 'usr_user_2',
      channel_id: 'chan_general_1',
      root_id: 'root_post_100',
      message: '@ega continue topic',
    };
    await listener.handlePost(threadPost);
    expect(createdPosts[1].root_id).toBe('root_post_100');
  });

  it('creates AgentTask with thread context and passes it to AgentExecutor', async () => {
    await listener.initialize();

    let receivedTask: AgentTask | null = null;
    mockExecutor = new MockAgentExecutor(async (task) => {
      receivedTask = task;
      return { success: true, message: 'Thread reply response' };
    });

    listener = new MattermostAgentListener({
      client: mockClient,
      stateManager,
      executor: mockExecutor,
      username,
    });
    await listener.initialize();

    // Mock thread history
    (mockClient.getPostThread as any).mockResolvedValue({
      order: ['post_thread_msg_1', 'post_thread_msg_2'],
      posts: {
        post_thread_msg_1: {
          id: 'post_thread_msg_1',
          create_at: 1000,
          user_id: 'usr_alice',
          channel_id: 'chan_general_1',
          root_id: '',
          message: 'Alice: We are planning our Q3 sprint.',
        },
        post_thread_msg_2: {
          id: 'post_thread_msg_2',
          create_at: 2000,
          user_id: 'usr_bob',
          channel_id: 'chan_general_1',
          root_id: 'post_thread_msg_1',
          message: 'Bob: Make sure to include Redis caching.',
        },
      },
    });

    const threadPost: MattermostPost = {
      id: 'post_thread_msg_3',
      create_at: 3000,
      user_id: 'usr_charlie',
      channel_id: 'chan_general_1',
      root_id: 'post_thread_msg_1',
      message: '@ega summarize the plan',
    };

    await listener.handlePost(threadPost);

    expect(receivedTask).not.toBeNull();
    expect(receivedTask!.instruction).toBe('summarize the plan');
    expect(receivedTask!.channelId).toBe('chan_general_1');
    expect(receivedTask!.rootPostId).toBe('post_thread_msg_1');
    expect(receivedTask!.threadContext.length).toBe(2);
    expect(receivedTask!.threadContext[0].message).toBe('Alice: We are planning our Q3 sprint.');
    expect(receivedTask!.threadContext[1].message).toBe('Bob: Make sure to include Redis caching.');
  });

  it('gracefully handles executor failure with fallback message', async () => {
    await listener.initialize();

    const failingExecutor = new MockAgentExecutor(async () => {
      throw new Error('Executor execution crash');
    });

    listener = new MattermostAgentListener({
      client: mockClient,
      stateManager,
      executor: failingExecutor,
      username,
    });
    await listener.initialize();

    const triggerPost: MattermostPost = {
      id: 'post_fail_trigger_1',
      create_at: Date.now(),
      user_id: 'usr_user_1',
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@ega explain something',
    };

    await listener.handlePost(triggerPost);

    expect(createdPosts.length).toBe(1);
    expect(createdPosts[0].message).toBe("I couldn't complete that request.\n\n_~ from AI Agent_");
  });

  it('respects onlySelf mode: ignores other users mentions but allows self mentions', async () => {
    listener = new MattermostAgentListener({
      client: mockClient,
      stateManager,
      executor: mockExecutor,
      username,
      onlySelf: true,
    });
    await listener.initialize();

    // 1. Post from another user should be ignored
    const otherUserPost: MattermostPost = {
      id: 'post_from_other_user',
      create_at: Date.now(),
      user_id: 'usr_stranger_999',
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@ega check this out',
    };
    const handledOther = await listener.handlePost(otherUserPost);
    expect(handledOther).toBe(false);
    expect(mockClient.createPost).not.toHaveBeenCalled();

    // 2. Post from authenticated user (@ega) MUST trigger
    const selfPost: MattermostPost = {
      id: 'post_from_self_user',
      create_at: Date.now(),
      user_id: currentUserId,
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@ega test my function',
    };
    const handledSelf = await listener.handlePost(selfPost);
    expect(handledSelf).toBe(true);
    expect(mockClient.createPost).toHaveBeenCalledTimes(1);
  });

  it('respects ignoreHistoricalPosts mode: ignores mentions created before agent start', async () => {
    listener = new MattermostAgentListener({
      client: mockClient,
      stateManager,
      executor: mockExecutor,
      username,
      ignoreHistoricalPosts: true,
    });
    await listener.initialize();

    const oldHistoricalPost: MattermostPost = {
      id: 'post_old_history_1',
      create_at: Date.now() - 1000000, // 16 minutes in the past
      user_id: currentUserId,
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@ega old mention from yesterday',
    };

    const handled = await listener.handlePost(oldHistoricalPost);
    expect(handled).toBe(false);
    expect(mockClient.createPost).not.toHaveBeenCalled();
  });

  it('sanitizes markdown headings (# -> **) and formats with custom from attribution', async () => {
    const headingExecutor = new MockAgentExecutor(async () => {
      return {
        success: true,
        message: '### Heading 3 Title\n\nContent details here.',
      };
    });

    listener = new MattermostAgentListener({
      client: mockClient,
      stateManager,
      executor: headingExecutor,
      username,
      from: 'Hermes Agent',
    });
    await listener.initialize();

    const post: MattermostPost = {
      id: 'post_heading_test',
      create_at: Date.now(),
      user_id: currentUserId,
      channel_id: 'chan_general_1',
      root_id: '',
      message: '@ega format this',
    };

    await listener.handlePost(post);

    expect(createdPosts[0].message).toBe('**Heading 3 Title**\n\nContent details here.\n\n_~ from Hermes Agent_');
  });
});
