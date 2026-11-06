import * as path from 'path';
import * as fs from 'fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChannelConfigLoader } from '../src/infrastructure/mattermost/services/channel-config-loader';
import { CronConfigLoader } from '../src/infrastructure/mattermost/cron/cron-config-loader';
import { CronStateManager } from '../src/infrastructure/mattermost/cron/cron-state-manager';
import { ThreadService } from '../src/infrastructure/mattermost/services/thread-service';
import { getPackageRoot, resolveAppPath, resolveConfigFile } from '../src/config/paths';
import { createMattermostMcpServer } from '../src/mcp/server';
import { MattermostValidationError } from '../src/domain/mattermost/errors';

describe('Package Root and Configuration Path Resolution', () => {
  const originalCwd = process.cwd();
  const pkgRoot = getPackageRoot();

  afterEach(() => {
    // Restore original cwd
    process.chdir(originalCwd);
  });

  it('correctly identifies the package root containing package.json', () => {
    expect(pkgRoot).toBeDefined();
    expect(fs.existsSync(path.join(pkgRoot, 'package.json'))).toBe(true);
  });

  it('resolves application paths against package root when cwd is outside repo', () => {
    // Simulate running from outside repo directory
    process.chdir('/tmp');

    const resolved = resolveAppPath('channels.yml');
    expect(resolved).toBe(path.join(pkgRoot, 'channels.yml'));
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it('loads 62 channels via ChannelConfigLoader even when cwd is outside repo', () => {
    process.chdir('/tmp');

    const loader = new ChannelConfigLoader();
    expect(loader.hasMappings()).toBe(true);
    expect(loader.getAllMappings().length).toBeGreaterThan(0);
    expect(loader.getLoadedPath()).toBe(path.join(pkgRoot, 'channels.yml'));
  });

  it('throws MattermostValidationError when channels config is missing or 0 channels found', () => {
    const loader = new ChannelConfigLoader({ configPath: 'non-existent-channels-dummy.yml' });

    expect(loader.hasMappings()).toBe(false);
    expect(loader.getAllMappings()).toEqual([]);
    expect(() => loader.assertHasChannels('test-context')).toThrow(MattermostValidationError);
    expect(() => loader.assertHasChannels()).toThrow(/No configured channels found in channels\.yml/);
  });

  it('MCP tool mattermost_list_channels returns channels when called from outside repo cwd', async () => {
    process.chdir('/tmp');

    const server = createMattermostMcpServer();
    const handler = (server as any)._requestHandlers.get('tools/call');
    expect(handler).toBeDefined();

    const result = await handler({
      method: 'tools/call',
      params: { name: 'mattermost_list_channels', arguments: {} },
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.channels.length).toBe(parsed.total);
    expect(parsed.channels[0]).toHaveProperty('alias');
    expect(parsed.channels[0]).toHaveProperty('channel');
  });

  it('loads cron jobs via CronConfigLoader even when cwd is outside repo', () => {
    process.chdir('/tmp');

    const loader = new CronConfigLoader();
    expect(loader.getLoadedPath()).toBe(path.join(pkgRoot, 'cron.yml'));
    expect(loader.getJobs().length).toBeGreaterThanOrEqual(1);
  });

  it('resolves state files for CronStateManager and ThreadService within package root', () => {
    process.chdir('/tmp');

    const cronState = new CronStateManager();
    expect((cronState as any).filePath).toBe(path.join(pkgRoot, 'data/cron_state.json'));

    const threadService = new ThreadService({} as any);
    expect((threadService as any).stateFilePath).toBe(path.join(pkgRoot, 'data/last_thread.json'));
  });
});
