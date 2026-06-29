// htmlToText.js — minimal HTML→plain-text for the mining/signature path
// (#1579 H1.1). Some inbound replies arrive HTML-only: body_text is empty but
// body_html carries the message. mineReplySignals / parseSignature operate on
// text, so without this they extract NOTHING from those replies (4 such rows on
// PROD 2026-06-01, plus any future HTML-only sender).
//
// This is NOT a renderer or sanitizer — it exists purely to recover the textual
// content (phones, IČO, signature) for deterministic extraction. Block-level
// tags become newlines so a signature block keeps its line structure; the rest
// of the markup is dropped and a handful of common entities are decoded.

const BLOCK_TAGS = /<\/(?:p|div|tr|li|h[1-6]|table|blockquote)>/gi
const BR_TAGS = /<br\s*\/?>/gi
const STYLE_SCRIPT = /<(style|script)[\s\S]*?<\/\1>/gi
const ANY_TAG = /<[^>]+>/g

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'",
}

/**
 * @param {string|null|undefined} html
 * @returns {string} plain text ('' when there is nothing to extract)
 */
export function htmlToText(html) {
  if (!html || typeof html !== 'string') return ''
  let s = html
    .replace(STYLE_SCRIPT, ' ')   // drop <style>/<script> bodies first
    .replace(BR_TAGS, '\n')
    .replace(BLOCK_TAGS, '\n')
    .replace(ANY_TAG, '')         // strip remaining tags
  // Decode named entities, then numeric (&#123; / &#x1F;).
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v)
  // Range-guard the code point: String.fromCodePoint throws RangeError for
  // values above U+10FFFF (e.g. &#x110000;) — drop those rather than crash.
  const safeCodePoint = (cp) =>
    (Number.isInteger(cp) && cp >= 0 && cp <= 0x10FFFF) ? String.fromCodePoint(cp) : ''
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
       .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
  // Collapse runs of spaces/tabs but keep newlines (signature line structure).
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
