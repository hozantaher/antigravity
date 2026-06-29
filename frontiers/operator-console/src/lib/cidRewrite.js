// cidRewrite — rewrite cid: URI references in HTML email bodies to
// BFF endpoints so the browser can load inline images via /api/messages/.
//
// Mail-client S2.1 (initiative 2026-04-29-mail-client-fidelity).
//
// Input HTML:
//   <img src="cid:logo-001@example" alt="logo">
// Output HTML:
//   <img src="/api/messages/42/attachments/logo-001@example" alt="logo">
//
// Why server-side: keeps UI dumb (no extra rewrite layer in React). The
// BFF holds the message_id binding, so it does the rewrite once at read
// time and the operator's browser sees normal http URLs.
//
// Robustness:
//   - Both quoting styles ("…" and '…') handled
//   - cid: is the only scheme rewritten — http/https/data/mailto pass
//     through. Per RFC 2392 the cid: scheme MUST be lowercased; we are
//     lenient and match case-insensitively.
//   - Empty input returns ''
//   - Non-string input returns ''

/**
 * Rewrite cid: URIs in HTML to /api/messages/:messageId/attachments/:cid.
 * @param {string|null|undefined} html  raw HTML body
 * @param {number|string} messageId     outreach_messages.id
 * @returns {string}                    HTML with cid: → /api/... rewritten
 */
export function rewriteCidUris(html, messageId) {
  if (typeof html !== 'string' || html === '') return ''
  // Match src="cid:X" / src='cid:X' / href="cid:X". The capture group
  // returns just X (the bare Content-ID, no angle brackets).
  return html.replace(
    /(src|href)\s*=\s*(["'])cid:([^"'>\s]+)\2/gi,
    (_match, attr, quote, cid) =>
      `${attr}=${quote}/api/messages/${messageId}/attachments/${encodeURIComponent(cid)}${quote}`
  )
}

/**
 * Walk a message object and rewrite cid: in body_html. Pure function;
 * does not mutate input.
 * @param {object} message  shape: { id, body_html, ... }
 * @returns {object}
 */
export function rewriteMessageCids(message) {
  if (!message || typeof message !== 'object') return message
  if (typeof message.body_html !== 'string' || message.body_html === '') {
    return message
  }
  return {
    ...message,
    body_html: rewriteCidUris(message.body_html, message.id),
  }
}
