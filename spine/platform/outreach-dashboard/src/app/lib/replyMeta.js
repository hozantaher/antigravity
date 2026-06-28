// Shared presentation helpers for the Odpovědi surface. Pure functions,
// no side effects — keeps Odpovedi.jsx focused on layout.

// Classification → calm Claude-palette chip. Maps the DB classification
// values seen in production (positive/negative/question/unsubscribe/bounce)
// plus a neutral fallback for null/unknown. Colors reference --app-* semantic
// tokens so light + dark stay in parity.
const CLASSIFICATION = {
  positive:    { label: 'Zájem',    fg: 'var(--app-positive)', bg: 'var(--app-positive-soft)' },
  negative:    { label: 'Odmítnutí', fg: 'var(--app-negative)', bg: 'var(--app-negative-soft)' },
  question:    { label: 'Dotaz',    fg: 'var(--app-accent-strong)', bg: 'var(--app-accent-soft)' },
  unsubscribe: { label: 'Odhlášení', fg: 'var(--app-warning)', bg: 'var(--app-warning-soft)' },
  bounce:      { label: 'Odražené', fg: 'var(--app-text-soft)', bg: 'var(--app-surface-sunk)' },
}
const NEUTRAL = { label: 'Nezařazeno', fg: 'var(--app-text-soft)', bg: 'var(--app-surface-sunk)' }

export function classificationMeta(c) {
  return CLASSIFICATION[c] || NEUTRAL
}

// Czech relative time, calm + short. Falls back to a date for anything older
// than a week so the list never shows an absurd "před 412 dny".
export function relativeCs(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const sec = Math.floor((Date.now() - then) / 1000)
  if (sec < 60) return 'právě teď'
  const min = Math.floor(sec / 60)
  if (min < 60) return `před ${min} min`
  const hod = Math.floor(min / 60)
  if (hod < 24) return `před ${hod} h`
  const dny = Math.floor(hod / 24)
  if (dny < 7) return `před ${dny} ${dny === 1 ? 'dnem' : 'dny'}`
  return new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })
}

// Render an email body as calm plain text. Prefers stored plain text; when
// only HTML exists, strip tags rather than dangerouslySetInnerHTML — external
// email HTML is untrusted (XSS) and the Claude aesthetic is readable prose
// anyway. Collapses whitespace; trims to a sane length for the pane.
export function bodyToText(reply, max = 4000) {
  const text = (reply?.body_text || '').trim()
  if (text) return text.slice(0, max)
  const html = reply?.body_html || ''
  if (!html) return ''
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return stripped.slice(0, max)
}

// Best display name for a reply row — contact name if matched, else the
// from-email local part, else a calm placeholder. Never blank.
export function displayName(reply) {
  const name = (reply?.contact_name || '').trim()
  if (name) return name
  const email = reply?.from_email || ''
  if (email) return email
  return 'Neznámý odesílatel'
}

// Decode RFC 2047 MIME encoded-words (e.g. "=?UTF-8?Q?Re=3A_Popt=C3=A1vka?=")
// that some reply subjects are stored as. B = base64, Q = quoted-printable
// (=XX hex bytes, _ = space). UTF-8 aware. Returns the input unchanged on any
// failure — never throws, never worse than the raw subject. Used wherever a
// subject is shown (list, chat, global search) so the operator reads clean text.
export function decodeMimeWords(str) {
  if (!str || typeof str !== 'string' || !str.includes('=?')) return str || ''
  try {
    return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset, enc, text) => {
      let bytes
      if (enc.toUpperCase() === 'B') {
        const bin = atob(text)
        bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      } else {
        // Q: _ → space, =XX → byte
        const q = text.replace(/_/g, ' ')
        const out = []
        for (let i = 0; i < q.length; i++) {
          if (q[i] === '=' && /[0-9A-Fa-f]{2}/.test(q.slice(i + 1, i + 3))) {
            out.push(parseInt(q.slice(i + 1, i + 3), 16)); i += 2
          } else { out.push(q.charCodeAt(i)) }
        }
        bytes = Uint8Array.from(out)
      }
      return new TextDecoder('utf-8').decode(bytes)
    }).replace(/\?=\s+=\?/g, '') // join adjacent encoded-words (whitespace between)
  } catch { return str }
}
