export interface ThreadMessage {
  author: string;
  message: string;
  timestamp?: number;
  userId?: string;
}

export interface AgentTask {
  id: string;
  instruction: string;
  threadContext: ThreadMessage[];
  channelId: string;
  rootPostId: string;
  sourcePostId: string;
  requestedBy: string;
  createdAt: string;
}

export interface CreateAgentTaskParams {
  id?: string;
  instruction: string;
  threadContext?: ThreadMessage[];
  channelId: string;
  rootPostId: string;
  sourcePostId: string;
  requestedBy: string;
  createdAt?: string;
}

/**
 * Creates a normalized, strongly-typed AgentTask object.
 * Acts as the stable domain boundary between the Mattermost integration layer and future task executors (Hermes).
 */
export function createAgentTask(params: CreateAgentTaskParams): AgentTask {
  return {
    id: params.id || `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    instruction: params.instruction.trim(),
    threadContext: params.threadContext || [],
    channelId: params.channelId,
    rootPostId: params.rootPostId,
    sourcePostId: params.sourcePostId,
    requestedBy: params.requestedBy,
    createdAt: params.createdAt || new Date().toISOString(),
  };
}
