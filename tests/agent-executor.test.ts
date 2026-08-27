import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({ execFile: execFileMock }));
import { createAgentTask } from '../src/agent/task';
import { MockAgentExecutor } from '../src/agent/executor';

describe('AgentTask & MockAgentExecutor', () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

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

  it('HermesAgentExecutor initializes with correct options and handles execution failure gracefully', async () => {
    const { HermesAgentExecutor } = await import('../src/agent/hermes-executor');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('spawn ENOENT'), '', 'binary missing');
      return undefined;
    });
    const hermesExecutor = new HermesAgentExecutor({
      cliPath: 'non-existent-hermes-binary-xyz',
      timeoutMs: 500,
    });

    const task = createAgentTask({
      instruction: 'test failure fallback',
      channelId: 'chan_1',
      rootPostId: 'root_1',
      sourcePostId: 'src_1',
      requestedBy: '@ega',
    });

    const result = await hermesExecutor.execute(task);
    expect(result.success).toBe(false);
    expect(result.message).toBe("I couldn't complete that request.");
    expect(result.metadata?.error).toBeDefined();
  });

  it('invokes the dedicated Mattermost Hermes profile without yolo or model override', async () => {
    const { HermesAgentExecutor } = await import('../src/agent/hermes-executor');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'Executor response\n', '');
      return undefined;
    });

    const executor = new HermesAgentExecutor({
      cliPath: '/usr/local/bin/hermes',
      profile: 'mattermost-agent',
    });
    const task = createAgentTask({
      instruction: 'Explain Redis Streams',
      threadContext: [{ author: 'alice', message: 'We need durable event processing.' }],
      channelId: 'engineering',
      rootPostId: 'root_1',
      sourcePostId: 'post_1',
      requestedBy: '@egagofurtriwahana',
    });

    const result = await executor.execute(task);

    expect(result).toMatchObject({ success: true, message: 'Executor response' });
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/local/bin/hermes',
      expect.arrayContaining(['-p', 'mattermost-agent', '-z']),
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    );
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('-m');
  });
});

