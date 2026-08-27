import { describe, it, expect } from 'vitest';
import { hasMention, extractInstruction, createMentionRegex } from '../src/mattermost/mentions';

describe('Mention Trigger & Boundary Detection', () => {
  const username = 'ega';

  it('detects valid mentions at the start of a message', () => {
    expect(hasMention('@ega hello', username)).toBe(true);
    expect(hasMention('@ega explain Redis Streams', username)).toBe(true);
    expect(hasMention('@ega: explain this', username)).toBe(true);
  });

  it('detects valid mentions at the end or middle of a message', () => {
    expect(hasMention('hello @ega', username)).toBe(true);
    expect(hasMention('Hey @ega, can you check this?', username)).toBe(true);
    expect(hasMention('What do you think? (@ega)', username)).toBe(true);
  });

  it('is case-insensitive for the username', () => {
    expect(hasMention('@EGA hello', username)).toBe(true);
    expect(hasMention('@Ega explain CQRS', username)).toBe(true);
  });

  it('does NOT trigger on username prefix or suffix collisions', () => {
    expect(hasMention('@egax hello', username)).toBe(false);
    expect(hasMention('@ega123 hello', username)).toBe(false);
    expect(hasMention('@egaplus explain this', username)).toBe(false);
  });

  it('does NOT trigger on email addresses or non-mention occurrences', () => {
    expect(hasMention('contact ega@example.com for info', username)).toBe(false);
    expect(hasMention('my_ega_test variable', username)).toBe(false);
    expect(hasMention('hello ega without mention sign', username)).toBe(false);
  });
});

describe('Message & Instruction Extraction', () => {
  const username = 'ega';

  it('extracts instruction by removing leading @username mention', () => {
    expect(extractInstruction('@ega explain Redis Streams', username)).toBe('explain Redis Streams');
    expect(extractInstruction('@ega: summarize this thread', username)).toBe('summarize this thread');
    expect(extractInstruction('@ega, how does CQRS work?', username)).toBe('how does CQRS work?');
  });

  it('extracts instruction from middle or end mentions', () => {
    expect(extractInstruction('hello @ega please help', username)).toBe('hello please help');
    expect(extractInstruction('Can you review this @ega?', username)).toBe('Can you review this?');
  });

  it('does NOT remove legitimate occurrences of the username in the rest of the text', () => {
    const input = "@ega compare ega's implementation with Redis Streams";
    const result = extractInstruction(input, username);
    expect(result).toBe("compare ega's implementation with Redis Streams");
  });

  it('returns clean trimmed output for empty or mention-only messages', () => {
    expect(extractInstruction('@ega', username)).toBe('');
    expect(extractInstruction('  @ega:   ', username)).toBe('');
  });
});
