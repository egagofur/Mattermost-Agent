import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AgentStateManager } from '../src/state/state-manager';

describe('AgentStateManager', () => {
  const testStatePath = path.resolve(__dirname, './temp-agent-state-test.json');

  beforeEach(() => {
    if (fs.existsSync(testStatePath)) {
      fs.unlinkSync(testStatePath);
    }
  });

  afterEach(() => {
    if (fs.existsSync(testStatePath)) {
      fs.unlinkSync(testStatePath);
    }
  });

  it('initializes with empty state and persists correctly', () => {
    const manager = new AgentStateManager({ filePath: testStatePath });
    const state = manager.getState();

    expect(state.processed_post_ids).toEqual([]);
    expect(state.agent_generated_post_ids).toEqual([]);
    expect(state.last_seen_post_id).toBeUndefined();
  });

  it('marks processed posts and deduplicates them', () => {
    const manager = new AgentStateManager({ filePath: testStatePath });

    expect(manager.isProcessed('post-1')).toBe(false);
    manager.markProcessed('post-1');
    expect(manager.isProcessed('post-1')).toBe(true);

    // Redundant mark does not duplicate
    manager.markProcessed('post-1');
    expect(manager.getState().processed_post_ids).toEqual(['post-1']);
  });

  it('records agent-generated posts to prevent self-loops and reloads from disk', () => {
    const manager = new AgentStateManager({ filePath: testStatePath });

    expect(manager.isAgentGenerated('gen-post-123')).toBe(false);
    manager.recordAgentGenerated('gen-post-123');
    expect(manager.isAgentGenerated('gen-post-123')).toBe(true);
    expect(manager.isProcessed('gen-post-123')).toBe(true);

    // Verify persistence by loading into a new instance
    const reloaded = new AgentStateManager({ filePath: testStatePath });
    expect(reloaded.isAgentGenerated('gen-post-123')).toBe(true);
    expect(reloaded.isProcessed('gen-post-123')).toBe(true);
  });

  it('sets and persists last_seen_post_id cursor', () => {
    const manager = new AgentStateManager({ filePath: testStatePath });
    manager.setLastSeenPostId('post-cursor-999');

    const reloaded = new AgentStateManager({ filePath: testStatePath });
    expect(reloaded.getState().last_seen_post_id).toBe('post-cursor-999');
  });

  it('caps stored IDs to maxStoredIds to prevent memory bloat', () => {
    const manager = new AgentStateManager({ filePath: testStatePath, maxStoredIds: 3 });

    manager.markProcessed('p1');
    manager.markProcessed('p2');
    manager.markProcessed('p3');
    manager.markProcessed('p4');

    const state = manager.getState();
    expect(state.processed_post_ids.length).toBe(3);
    expect(state.processed_post_ids).toEqual(['p2', 'p3', 'p4']);
    expect(manager.isProcessed('p1')).toBe(false);
    expect(manager.isProcessed('p4')).toBe(true);
  });
});
