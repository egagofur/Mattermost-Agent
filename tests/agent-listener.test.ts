import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MattermostAgentListener } from '../src/mattermost/listener';
import { MattermostClient, MattermostPost, MattermostUser } from '../src/mattermost/client';
import { AgentStateManager } from '../src/state/state-manager';
import { MockAIProvider } from '../src/ai/provider';

describe('MattermostAgentListener', () => {
  const currentUserId = 'usr_ega_authenticated_123';
  const username = 'ega';

  let mockClient: MattermostClient;
  let stateManager: AgentStateManager;
  let mockAI: MockAIProvider;
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

    mockAI = new MockAIProvider(async (prompt) => {
      return `AI explanation for: ${prompt}`;
    });

    listener = new MattermostAgentListener({
      client: mockClient,
      stateManager,
      aiProvider: mockAI,
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
    expect(createdPosts[0].message).toBe('AI explanation for: explain CQRS pattern');
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
      message: 'AI explanation for: what is event sourcing? Mentioning @ega for reference.',
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

  it('retrieves thread context and passes it to the AI provider', async () => {
    await listener.initialize();

    let receivedContext: any = null;
    mockAI = new MockAIProvider(async (prompt, context) => {
      receivedContext = context;
      return 'Thread reply response';
    });

    listener = new MattermostAgentListener({
      client: mockClient,
      stateManager,
      aiProvider: mockAI,
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

    expect(receivedContext).not.toBeNull();
    expect(receivedContext.length).toBe(2);
    expect(receivedContext[0].message).toBe('Alice: We are planning our Q3 sprint.');
    expect(receivedContext[1].message).toBe('Bob: Make sure to include Redis caching.');
  });

  it('gracefully handles AI provider failure with concise fallback message', async () => {
    await listener.initialize();

    const failingAI = new MockAIProvider(async () => {
      throw new Error('API Rate Limit Exceeded');
    });

    listener = new MattermostAgentListener({
      client: mockClient,
      stateManager,
      aiProvider: failingAI,
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
    expect(createdPosts[0].message).toBe('Unable to process this request right now.');
  });
});
