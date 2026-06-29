// quoteStrip.js — shared quoted-reply-history stripper.
//
// Two consumers need the SAME "keep only what the human typed" logic:
//   1. replyClassifier — so our quoted outbound ("máte na prodej?") isn't
//      scored as the recipient's selling intent (regex_v2, 2026-05-31).
//   2. vehicleExtractor — so a brand named in the quoted original / a
//      signature ("Atlas Copco" in a footer) doesn't create a PHANTOM vehicle
//      in the Vozidla inventory (2 of 15 captured rows were phantom — 2026-06).
//
// Pure + deterministic. Cut the body at the earliest reply-history marker and
// return only the text before it.
//
// Markers (CZ + EN): leading "> " quote lines, "Původní zpráva/e-mail",
// "----- Original Message", "Dne … napsal(a):", "On … wrote:", a Czech
// date-stamp + "napsal", an "Od:/From:" header block, Outlook underscore rule.
const QUOTE_MARKERS = [
  /(\r?\n|^)\s*>/, // first quoted line
  /(\r?\n|^)\s*-{2,}\s*(p[ůu]vodn[íi]|original)/i,
  /(\r?\n|^)\s*p[ůu]vodn[íi]\s+(zpr[áa]va|e-?mail)/i,
  /(\r?\n|^)\s*-{3,}\s*original message/i,
  /(\r?\n|^)\s*(dne|on)\b.{0,120}?(napsal|wrote)\s*[:\(]/i,
  // "29. května 2026 10:05:47 SELČ, X napsal:" / "21. 5. 2026 v 16:14, X:"
  // Line-anchored like the others: without `(\r?\n|^)\s*` the `v \d{1,2}:\d{2}`
  // alt matched an INLINE Czech date ("Sejdeme se 21.5. v 16:00, ...") and
  // truncated the human reply before mining. Anchoring restricts it to a
  // client-attribution line that starts with the date.
  /(\r?\n|^)\s*\d{1,2}\.\s*(\d{1,2}\.|ledna|[úu]nora|b[řr]ezna|dubna|kv[ěe]tna|[čc]ervna|[čc]ervence|srpna|z[áa][řr][íi]|[řr][íi]jna|listopadu|prosince)\s*\d{0,4}.{0,80}?(napsal|v\s+\d{1,2}:\d{2})/i,
  /(\r?\n|^)\s*od:\s.{0,160}?(komu|to|p[řr]edm[ěe]t|subject|datum|sent)\s*:/is, // header block
  /(\r?\n|^)_{5,}/, // Outlook underscore separator
  /(\r?\n|^)\s*from:\s.{0,160}?(to|subject|sent)\s*:/is,
]

/**
 * Return only the human-typed portion of a reply: everything before the
 * earliest quoted-original / reply-history marker. If no marker is found the
 * input is returned unchanged.
 *
 * @param {string|null|undefined} body
 * @returns {string}
 */
export function stripQuotedReply(body) {
  if (!body || typeof body !== 'string') return ''
  let cut = body.length
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(body)
    if (m && m.index < cut) cut = m.index
  }
  const visible = body.slice(0, cut).trim()
  // Guard: if stripping nuked everything (reply is ONLY a quote, or a marker
  // matched at index 0), keep the original so we don't blank out a real reply.
  return visible.length > 0 ? visible : body.trim()
}
