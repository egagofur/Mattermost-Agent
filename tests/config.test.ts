import { describe, it, expect } from 'vitest';
import { loadConfig, sanitizeConfig } from '../src/config/env';

describe('Config', () => {
  it('loads valid API provider config', () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_PROVIDER: 'api',
      MATTERMOST_TOKEN: 'test-token-1234567890',
      MATTERMOST_TEAM_ID: 'team-id-123',
    });

    expect(config.MATTERMOST_URL).toBe('https://mattermost.example.com');
    expect(config.MATTERMOST_PROVIDER).toBe('api');
    expect(config.MATTERMOST_TOKEN).toBe('test-token-1234567890');
    expect(config.MATTERMOST_TEAM_ID).toBe('team-id-123');
    expect(config.MATTERMOST_HEADLESS).toBe(true);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('strips trailing slashes from MATTERMOST_URL', () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com///',
      MATTERMOST_PROVIDER: 'api',
      MATTERMOST_TOKEN: 'token-abc',
    });

    expect(config.MATTERMOST_URL).toBe('https://mattermost.example.com');
  });

  it('allows playwright provider without token', () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_PROVIDER: 'playwright',
      MATTERMOST_TOKEN: '',
    });

    expect(config.MATTERMOST_PROVIDER).toBe('playwright');
  });

  it('defaults to playwright provider when not specified', () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
    });

    expect(config.MATTERMOST_PROVIDER).toBe('playwright');
    expect(config.MATTERMOST_HEADLESS).toBe(true);
  });

  it('throws error when MATTERMOST_URL is missing or invalid', () => {
    expect(() =>
      loadConfig({
        MATTERMOST_URL: 'not-a-url',
        MATTERMOST_TOKEN: 'token',
      })
    ).toThrow(/MATTERMOST_URL must be a valid URL/);
  });

  it('throws error when API provider has missing token', () => {
    expect(() =>
      loadConfig({
        MATTERMOST_URL: 'https://mattermost.example.com',
        MATTERMOST_PROVIDER: 'api',
        MATTERMOST_TOKEN: '',
      })
    ).toThrow(/MATTERMOST_TOKEN is required/);
  });

  it('sanitizes config by redacting the token', () => {
    const config = loadConfig({
      MATTERMOST_URL: 'https://mattermost.example.com',
      MATTERMOST_TOKEN: 'super-secret-token',
    });

    const sanitized = sanitizeConfig(config);
    expect(sanitized.MATTERMOST_TOKEN).toBe('[REDACTED]');
    expect(sanitized.MATTERMOST_URL).toBe('https://mattermost.example.com');
  });
});
