import { describe, it, expect } from 'vitest';
import { createAgentTask } from '../src/agent/task';
import { MockAgentExecutor } from '../src/agent/executor';

describe('AgentTask & MockAgentExecutor', () => {
  it('creates a normalized AgentTask with all required domain fields', () => {
    const task = createAgentTask({
      instruction: 'explain Redis Streams',
      threadContext: [
        { author: 'Alice', message: 'We need event queues' },
        { author: 'Ega', message: '@ega explain Redis Streams' },
      ],
      channelId: 'chan_eng_123',
      rootPostId: 'root_post_001',
      sourcePostId: 'src_post_002',
      requestedBy: '@ega',
    });

    expect(task.id).toMatch(/^task_/);
    expect(task.instruction).toBe('explain Redis Streams');
    expect(task.channelId).toBe('chan_eng_123');
    expect(task.rootPostId).toBe('root_post_001');
    expect(task.sourcePostId).toBe('src_post_002');
    expect(task.requestedBy).toBe('@ega');
    expect(task.threadContext.length).toBe(2);
    expect(task.createdAt).toBeDefined();
  });

  it('executes task using MockAgentExecutor with default mock response', async () => {
    const executor = new MockAgentExecutor();
    const task = createAgentTask({
      instruction: 'explain Redis Streams',
      channelId: 'chan_1',
      rootPostId: 'root_1',
      sourcePostId: 'src_1',
      requestedBy: '@ega',
    });

    const result = await executor.execute(task);

    expect(result.success).toBe(true);
    expect(result.message).toBe('Mock executor response: explain Redis Streams');
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.taskId).toBe(task.id);
  });

  it('executes task using MockAgentExecutor with custom handler', async () => {
    const customExecutor = new MockAgentExecutor(async (task) => {
      return {
        success: true,
        message: `Custom result for: ${task.instruction.toUpperCase()}`,
        metadata: { custom: true },
      };
    });

    const task = createAgentTask({
      instruction: 'build feature',
      channelId: 'chan_1',
      rootPostId: 'root_1',
      sourcePostId: 'src_1',
      requestedBy: '@john',
    });

    const result = await customExecutor.execute(task);

    expect(result.success).toBe(true);
    expect(result.message).toBe('Custom result for: BUILD FEATURE');
    expect(result.metadata?.custom).toBe(true);
  });
});
