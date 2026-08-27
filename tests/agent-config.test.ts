import { describe, it, expect } from 'vitest';
import { loadAgentConfig, sanitizeAgentConfig } from '../src/config/agent-config';

describe('Agent Configuration & Validation', () => {
  it('loads valid configuration successfully', () => {
    const config = loadAgentConfig({
      MATTERMOST_URL: 'https://mattermost.example.com/',
      MATTERMOST_TOKEN: 'sec_tok_12345',
      MATTERMOST_USERNAME: '@ega',
      MATTERMOST_POLL_INTERVAL: '10',
      AI_PROVIDER: 'mock',
    });

    expect(config.MATTERMOST_URL).toBe('https://mattermost.example.com');
    expect(config.MATTERMOST_TOKEN).toBe('sec_tok_12345');
    expect(config.MATTERMOST_USERNAME).toBe('ega');
    expect(config.MATTERMOST_POLL_INTERVAL).toBe(10);
    expect(config.AI_PROVIDER).toBe('mock');
  });

  it('fails fast with clear error message when required variables are missing', () => {
    expect(() => {
      loadAgentConfig({
        MATTERMOST_URL: '',
        MATTERMOST_USERNAME: '',
      });
    }).toThrow(/Invalid Mattermost Agent Configuration/);
  });

  it('falls back to default poll interval when invalid interval is given', () => {
    const config = loadAgentConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'sec_tok_12345',
      MATTERMOST_USERNAME: 'ega',
      MATTERMOST_POLL_INTERVAL: 'invalid_number',
      AI_PROVIDER: 'mock',
    });

    expect(config.MATTERMOST_POLL_INTERVAL).toBe(5);
  });

  it('sanitizes tokens and secrets before logging', () => {
    const config = loadAgentConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'super_secret_token',
      MATTERMOST_USERNAME: 'ega',
      AI_PROVIDER: 'mock',
    });

    const sanitized = sanitizeAgentConfig(config);
    expect(sanitized.MATTERMOST_TOKEN).toBe('[REDACTED]');
    expect(sanitized.MATTERMOST_URL).toBe('https://mattermost.example.com');
    expect(sanitized.MATTERMOST_USERNAME).toBe('@ega');
  });

  it('resolveAuthSession returns explicit token if provided', async () => {
    const { resolveAuthSession } = await import('../src/mattermost/session-helper');
    const session = await resolveAuthSession({ explicitToken: 'my_custom_token' });
    expect(session.token).toBe('my_custom_token');
    expect(session.source).toBe('env_token');
  });

  it('resolveAuthSession throws clear message if neither token nor profile exists', async () => {
    const { resolveAuthSession } = await import('../src/mattermost/session-helper');
    await expect(
      resolveAuthSession({ explicitToken: '', profileDir: './non-existent-profile-path-xyz' })
    ).rejects.toThrow(/No active Mattermost session or token found/);
  });
});
