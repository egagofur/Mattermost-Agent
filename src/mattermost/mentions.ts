/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a safe regular expression for matching Mattermost @username mentions.
 * Ensures boundary safety:
 *  - Matches: "@ega", "hello @ega", "@ega, how are you?", "(@ega)"
 *  - Rejects: "@egax", "@ega123", "ega@domain.com", "my_ega"
 */
export function createMentionRegex(username: string): RegExp {
  const cleanUser = username.replace(/^@/, '').trim();
  const escaped = escapeRegex(cleanUser);
  // Boundary before @: start of string OR whitespace OR punctuation characters [ ( ' " ` <
  // Boundary after username: end of string OR whitespace OR punctuation characters , . ! ? ; : ) ' " ` > ]
  return new RegExp(`(?:^|[\\s.,!?;:("'\`<\\[])@${escaped}(?=$|[\\s.,!?;:)"'\`>\\]])`, 'i');
}

/**
 * Checks if a message text contains a valid @username mention.
 */
export function hasMention(message: string, username: string): boolean {
  if (!message || !username) return false;
  const regex = createMentionRegex(username);
  return regex.test(message);
}

/**
 * Extracts the user prompt instruction by removing the triggering @username mention.
 *
 * Example:
 *  - "@ega explain Redis Streams" -> "explain Redis Streams"
 *  - "@ega: summarize this thread" -> "summarize this thread"
 *  - "hello @ega please help" -> "hello please help"
 *  - "@ega compare ega's implementation with Redis Streams" -> "compare ega's implementation with Redis Streams"
 */
export function extractInstruction(message: string, username: string): string {
  if (!message || !username) return '';

  const cleanUser = username.replace(/^@/, '').trim();
  const escaped = escapeRegex(cleanUser);

  // Match the first occurrence of @username along with optional surrounding punctuation
  // e.g. "@ega: ", "@ega, ", "@ega ", " @ega", "(@ega)", "@ega?"
  const mentionPattern = new RegExp(`(^|[\\s(])@${escaped}([:;,]?)(\\s+|[)?!.,;:]|$)`, 'i');

  let extracted = message.replace(mentionPattern, (match, prefix, colon, suffix) => {
    if (/^[?!.,;:]$/.test(suffix)) {
      return suffix;
    }
    return prefix === '(' ? '' : prefix;
  });

  // Fallback if mention remains
  if (hasMention(extracted, cleanUser)) {
    const directPattern = new RegExp(`@${escaped}`, 'i');
    extracted = extracted.replace(directPattern, '');
  }

  // Clean leading punctuation colons/commas, spaces before punctuation, and extra whitespace
  return extracted
    .replace(/^[:;,]\s*/, '')
    .replace(/\s+([?!.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
