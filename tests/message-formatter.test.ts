import { describe, it, expect } from 'vitest';
import { formatMessageWithAttribution } from '../src/infrastructure/mattermost/services/message-formatter';

describe('formatMessageWithAttribution', () => {
  it('appends italicized attribution footer when from is provided', () => {
    const result = formatMessageWithAttribution('MR !123 is ready for review', 'AI');
    expect(result).toBe('MR !123 is ready for review\n\n_~ from AI_');
  });

  it('handles user-written "~ from AI" or "from AI" gracefully', () => {
    const result1 = formatMessageWithAttribution('Hello team', '~ from AI');
    expect(result1).toBe('Hello team\n\n_~ from AI_');

    const result2 = formatMessageWithAttribution('Hello team', 'from GitLab CI');
    expect(result2).toBe('Hello team\n\n_~ from GitLab CI_');
  });

  it('returns original message when from is undefined, empty, or whitespace', () => {
    expect(formatMessageWithAttribution('Plain text', undefined)).toBe('Plain text');
    expect(formatMessageWithAttribution('Plain text', '')).toBe('Plain text');
    expect(formatMessageWithAttribution('Plain text', '   ')).toBe('Plain text');
  });

  it('trims trailing whitespace before appending footer', () => {
    const result = formatMessageWithAttribution('Some message\n\n', 'Mattermost Agent');
    expect(result).toBe('Some message\n\n_~ from Mattermost Agent_');
  });
});
