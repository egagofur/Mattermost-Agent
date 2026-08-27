/**
 * Sanitizes markdown heading tags (#, ##, ###, ####) by converting them to bold text.
 * Prevents giant, messy font rendering in Mattermost.
 */
export function sanitizeMattermostMarkdown(message: string): string {
  if (!message) return '';
  return message.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, title) => `**${title.trim()}**`);
}

/**
 * Formats a message body with markdown sanitization and an italicized attribution footer.
 *
 * Example:
 *   formatMessageWithAttribution("MR !123 is ready", "AI Agent")
 *   => "MR !123 is ready\n\n_~ from AI Agent_"
 */
export function formatMessageWithAttribution(message: string, from?: string): string {
  const sanitized = sanitizeMattermostMarkdown(message);
  if (!from || !from.trim()) {
    return sanitized;
  }

  let cleanFrom = from.trim();
  // Strip leading '~' or 'from' if user explicitly wrote '~ from AI' or 'from AI'
  cleanFrom = cleanFrom.replace(/^~?\s*(?:from\s*)?/i, '').trim();
  if (!cleanFrom) {
    cleanFrom = 'AI Agent';
  }

  return `${sanitized.trimEnd()}\n\n_~ from ${cleanFrom}_`;
}
