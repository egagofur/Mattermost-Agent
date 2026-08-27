import { AgentTask } from './task';

export interface AgentResult {
  success: boolean;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AgentExecutor {
  execute(task: AgentTask): Promise<AgentResult>;
}

export type MockExecuteHandler = (task: AgentTask) => Promise<AgentResult> | AgentResult;

/**
 * Mock implementation of AgentExecutor for local development, integration testing,
 * and decoupling the Mattermost integration layer while Hermes is under development.
 */
export class MockAgentExecutor implements AgentExecutor {
  private customHandler?: MockExecuteHandler;

  constructor(customHandler?: MockExecuteHandler) {
    this.customHandler = customHandler;
  }

  public async execute(task: AgentTask): Promise<AgentResult> {
    if (this.customHandler) {
      return this.customHandler(task);
    }

    // Default mock response
    return {
      success: true,
      message: `Mock executor response: ${task.instruction}`,
      metadata: {
        taskId: task.id,
        contextCount: task.threadContext.length,
        timestamp: new Date().toISOString(),
      },
    };
  }
}
