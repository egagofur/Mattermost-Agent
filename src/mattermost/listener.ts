import { MattermostClient, MattermostPost, MattermostUser } from './client';
import { hasMention, extractInstruction } from './mentions';
import { AgentStateManager } from '../state/state-manager';
import { AgentExecutor, MockAgentExecutor } from '../agent/executor';
import { AgentTask, createAgentTask, ThreadMessage } from '../agent/task';
import { AIProvider } from '../ai/provider';

export interface ListenerOptions {
  client: MattermostClient;
  stateManager: AgentStateManager;
  executor?: AgentExecutor;
  aiProvider?: AIProvider; // Optional fallback compatibility
  username: string;
  pollIntervalSeconds?: number;
  channels?: string[]; // Optional: restrict polling to specific channel IDs or names
  maxThreadContext?: number;
  onlySelf?: boolean; // When true, only messages authored by the authenticated account owner will trigger
  ignoreHistoricalPosts?: boolean; // When true, ignores mentions created before the agent started running
}

export class MattermostAgentListener {
  private client: MattermostClient;
  private stateManager: AgentStateManager;
  private executor: AgentExecutor;
  private username: string;
  private pollIntervalMs: number;
  private targetChannels?: string[];
  private maxThreadContext: number;
  private onlySelf: boolean;
  private ignoreHistoricalPosts: boolean;
  private startTime: number;

  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private currentUser: MattermostUser | null = null;

  constructor(options: ListenerOptions) {
    this.client = options.client;
    this.stateManager = options.stateManager;
    this.username = options.username.replace(/^@/, '').toLowerCase().trim();
    this.pollIntervalMs = (options.pollIntervalSeconds || 5) * 1000;
    this.targetChannels = options.channels;
    this.maxThreadContext = options.maxThreadContext || 10;
    this.onlySelf = options.onlySelf ?? false;
    this.ignoreHistoricalPosts = options.ignoreHistoricalPosts ?? false;
    this.startTime = Date.now();

    // Set executor (or wrap legacy aiProvider if supplied)
    if (options.executor) {
      this.executor = options.executor;
    } else if (options.aiProvider) {
      const provider = options.aiProvider;
      this.executor = {
        execute: async (task: AgentTask) => {
          const res = await provider.generate(task.instruction, task.threadContext);
          return { success: true, message: res };
        },
      };
    } else {
      this.executor = new MockAgentExecutor();
    }
  }

  /**
   * Initializes the listener by verifying authentication with Mattermost.
   */
  public async initialize(): Promise<MattermostUser> {
    try {
      this.currentUser = await this.client.getMe();
      console.log(`[INFO] Authenticated as @${this.currentUser.username} (${this.currentUser.id})`);
      return this.currentUser;
    } catch (err: any) {
      console.error(`[ERROR] Mattermost API error: authentication failed - ${err.message}`);
      throw err;
    }
  }

  /**
   * Starts the polling loop.
   */
  public async start(): Promise<void> {
    if (!this.currentUser) {
      await this.initialize();
    }

    console.log(`[INFO] Polling started (interval: ${this.pollIntervalMs / 1000}s, trigger: @${this.username})`);
    // Run first tick immediately
    await this.pollOnce();

    // Start background interval
    this.pollTimer = setInterval(async () => {
      await this.pollOnce();
    }, this.pollIntervalMs);
  }

  /**
   * Stops the polling loop.
   */
  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[INFO] Polling stopped');
  }

  /**
   * Executes a single polling cycle.
   * Scans accessible channels for mentions and dispatches tasks.
   */
  public async pollOnce(): Promise<number> {
    if (this.isPolling) return 0;
    this.isPolling = true;

    let processedCount = 0;

    try {
      // 1. Get accessible channels
      const channels = await this.client.getMyChannels();
      const channelsToPoll = this.targetChannels && this.targetChannels.length > 0
        ? channels.filter((c) => this.targetChannels!.includes(c.id) || this.targetChannels!.includes(c.name))
        : channels;

      // 2. Poll posts for each channel
      for (const channel of channelsToPoll) {
        try {
          const postsResponse = await this.client.getChannelPosts(channel.id, { perPage: 20 });
          if (!postsResponse || !postsResponse.order || postsResponse.order.length === 0) {
            continue;
          }

          // Order from oldest to newest for chronological processing
          const postIds = [...postsResponse.order].reverse();

          for (const postId of postIds) {
            const post = postsResponse.posts[postId];
            if (!post) continue;

            const handled = await this.handlePost(post);
            if (handled) {
              processedCount++;
            }
          }
        } catch (channelErr: any) {
          console.error(`[ERROR] Mattermost API error: Failed to fetch posts for channel ${channel.name || channel.id} - ${channelErr.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[ERROR] Mattermost API error: Polling cycle failed - ${err.message}`);
    } finally {
      this.isPolling = false;
    }

    return processedCount;
  }

  /**
   * Evaluates and processes a single Mattermost post.
   * Returns true if the post triggered an agent task and response.
   */
  public async handlePost(post: MattermostPost): Promise<boolean> {
    if (!post || !post.id) return false;

    // 1. CRITICAL: Ignore posts generated by the agent itself (Prevents infinite self-loops)
    if (this.stateManager.isAgentGenerated(post.id)) {
      if (!this.stateManager.isProcessed(post.id)) {
        console.log(`[INFO] Ignoring agent-generated post: ${post.id}`);
        this.stateManager.markProcessed(post.id);
      }
      return false;
    }

    // 2. Ignore already processed posts (Deduplication)
    if (this.stateManager.isProcessed(post.id)) {
      return false;
    }

    // 3. Ignore deleted posts
    if (post.delete_at && post.delete_at > 0) {
      this.stateManager.markProcessed(post.id);
      return false;
    }

    // 4. Check for @username mention
    if (!hasMention(post.message, this.username)) {
      this.stateManager.markProcessed(post.id);
      return false;
    }

    // --- MENTION DETECTED ---
    // 5. Check historical ignore (ignores mentions authored before this agent session started)
    if (this.ignoreHistoricalPosts && post.create_at && post.create_at < this.startTime) {
      console.log(`[INFO] Ignoring historical mention from ${new Date(post.create_at).toISOString()} (Post: ${post.id})`);
      this.stateManager.markProcessed(post.id);
      return false;
    }

    // 6. Check onlySelf validation (restricts trigger execution exclusively to the authenticated user for testing)
    if (this.onlySelf && this.currentUser && post.user_id !== this.currentUser.id) {
      console.log(`[INFO] Ignoring mention in post ${post.id}: authored by user ${post.user_id} (onlySelf testing mode enabled).`);
      this.stateManager.markProcessed(post.id);
      return false;
    }

    // NOTE: Self-triggering is intentionally supported!
    // A post created by the human user (post.user_id === this.currentUser?.id) WILL proceed here.
    console.log(`[INFO] Mention detected in post: ${post.id} (Channel: ${post.channel_id})`);

    // Mark as processed early to prevent concurrent duplicate processing
    this.stateManager.markProcessed(post.id);
    this.stateManager.setLastSeenPostId(post.id);

    // 7. Extract instruction prompt
    const instruction = extractInstruction(post.message, this.username);

    // 6. Retrieve thread context if message is part of a thread
    let threadContext: ThreadMessage[] = [];
    const targetRootId = post.root_id || post.id;

    if (post.root_id) {
      try {
        const threadResp = await this.client.getPostThread(post.root_id);
        if (threadResp && threadResp.order && threadResp.order.length > 0) {
          const threadPosts = threadResp.order
            .map((id) => threadResp.posts[id])
            .filter((p): p is MattermostPost => Boolean(p && p.id !== post.id && (!p.delete_at || p.delete_at === 0)))
            .slice(-this.maxThreadContext); // Limit to recent window

          threadContext = threadPosts.map((p) => ({
            author: p.user_id === this.currentUser?.id ? `@${this.username}` : `user_${p.user_id.slice(0, 6)}`,
            message: p.message,
            timestamp: p.create_at,
            userId: p.user_id,
          }));
        }
      } catch (threadErr: any) {
        console.error(`[ERROR] Mattermost API error: Failed to fetch thread context for ${post.root_id} - ${threadErr.message}`);
      }
    }

    // 7. Create internal AgentTask (Boundary between Mattermost and Executor)
    const task = createAgentTask({
      instruction: instruction || 'Hello, how can I assist you?',
      threadContext,
      channelId: post.channel_id,
      rootPostId: targetRootId,
      sourcePostId: post.id,
      requestedBy: post.user_id === this.currentUser?.id ? `@${this.username}` : post.user_id,
      createdAt: new Date(post.create_at || Date.now()).toISOString(),
    });

    console.log(`[INFO] Agent task created: ${task.id}`);

    // 8. Execute task via AgentExecutor
    console.log('[INFO] Executor started');
    let replyMessage = "I couldn't complete that request.";

    try {
      const result = await this.executor.execute(task);
      console.log('[INFO] Executor completed');

      if (result.success && result.message) {
        replyMessage = result.message;
      } else {
        console.error(`[ERROR] Executor failed: Task ${task.id} returned unsuccessful`);
      }
    } catch (execErr: any) {
      console.error(`[ERROR] Executor failed: ${execErr.message}`);
    }

    // 9. Post response to Mattermost (replying to rootPostId)
    try {
      const createdPost = await this.client.createPost({
        channel_id: task.channelId,
        message: replyMessage,
        root_id: task.rootPostId,
      });

      // 10. CRITICAL: Record created post ID in agent_generated_post_ids
      this.stateManager.recordAgentGenerated(createdPost.id);
      console.log(`[INFO] Mattermost response posted: ${createdPost.id}`);
      return true;
    } catch (postErr: any) {
      console.error(`[ERROR] Mattermost API error: Failed to post response - ${postErr.message}`);
      return false;
    }
  }
}
