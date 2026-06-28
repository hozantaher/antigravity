// mimeDecode.js — RFC 2047 encoded-word decoder.
//
// Raw IMAP headers arrive MIME-encoded for non-ASCII content (Czech
// diacritics): "=?UTF-8?B?…?=" (base64) and "=?UTF-8?Q?…?=" (quoted-
// printable). Operator-facing UI needs human-readable subject lines / sender
// names. Extracted from replies.js so every surface that shows a reply subject
// (the /replies list, the thread detail, AND the Home dashboard summary) decodes
// identically — previously only the list/detail decoded, so Home showed raw
// "=?UTF-8?Q?Nep=C5=99=C3=ADtomnost_Re:_Dotaz?=" gibberish.

/**
 * Decode raw bytes into a string using the encoded-word's charset label.
 *
 * Buffer.toString() understands only a small fixed set of labels (utf8, latin1,
 * ascii, …) and THROWS ERR_UNKNOWN_ENCODING on legacy single-byte labels such as
 * iso-8859-2 / windows-1250 — exactly the Central-European set Czech mail uses.
 * The previous `Buffer.toString(lc)` therefore threw on those and the whole
 * header fell back to raw encoded bytes. Route legacy labels through TextDecoder
 * (ICU) instead so they actually decode.
 *
 * @param {Buffer} buf
 * @param {string} charset
 * @returns {string}
 */
function decodeBytes(buf, charset) {
  const lc = String(charset || 'utf-8').toLowerCase().trim()
  if (lc.includes('utf')) return buf.toString('utf8')                 // utf-8 / utf8 — native
  if (lc === 'iso-8859-1' || lc === 'latin1' || lc === 'ascii' || lc === 'us-ascii') {
    return buf.toString('latin1')                                     // native single-byte
  }
  try {
    return new TextDecoder(lc).decode(buf)                            // windows-1250 / iso-8859-2 (CZ), windows-1252, koi8, …
  } catch {
    return buf.toString('latin1')                                     // unknown label — keep bytes rather than throw
  }
}

/**
 * @param {string} input possibly MIME-encoded header value
 * @returns {string} decoded human-readable text (input unchanged if not encoded)
 */
export function decodeMimeWords(input) {
  if (!input || typeof input !== 'string') return input
  // RFC 2047: whitespace separating two adjacent encoded-words is not part of the
  // displayed text and must be folded out. Do this BEFORE decoding, while the
  // `?= =?` delimiters still exist — running it afterwards (the old bug) never
  // matched because the decode pass had already removed those delimiters.
  return input
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, payload) => {
      try {
        if (enc.toLowerCase() === 'b') {
          return decodeBytes(Buffer.from(payload, 'base64'), charset)
        }
        // Quoted-printable: underscores map to spaces, =HH to bytes.
        const bytes = []
        for (let i = 0; i < payload.length; i++) {
          const c = payload[i]
          if (c === '_') { bytes.push(0x20); continue }
          if (c === '=' && i + 2 < payload.length) {
            const hex = payload.slice(i + 1, i + 3)
            const code = parseInt(hex, 16)
            if (!Number.isNaN(code)) {
              bytes.push(code)
              i += 2
              continue
            }
          }
          bytes.push(c.charCodeAt(0))
        }
        return decodeBytes(Buffer.from(bytes), charset)
      } catch {
        return payload // leave the raw bytes so operator at least sees something
      }
    })
}
