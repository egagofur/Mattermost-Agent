/**
 * Formats a message body with an italicized attribution footer.
 *
 * Example:
 *   formatMessageWithAttribution("MR !123 is ready", "AI")
 *   => "MR !123 is ready\n\n_~ from AI_"
 */
export function formatMessageWithAttribution(message: string, from?: string): string {
  if (!from || !from.trim()) {
    return message;
  }

  let cleanFrom = from.trim();
  // Strip leading '~' or 'from' if user explicitly wrote '~ from AI' or 'from AI'
  cleanFrom = cleanFrom.replace(/^~?\s*(?:from\s*)?/i, '').trim();
  if (!cleanFrom) {
    cleanFrom = 'AI';
  }

  return `${message.trimEnd()}\n\n_~ from ${cleanFrom}_`;
}
