// MVP-5 — pure-fn template preview renderer.
// Substitutes {{var}} merge tags with sample values, returns rendered HTML
// + warning list. Does NOT execute spintax — that's the Go runner's job at
// send time (and is exercised by the M2 spintax monkey suite).

const KNOWN_VARS = new Set([
  'jmeno', 'jmeno_zkraceno',
  'firma', 'firma_short',
  'sektor', 'region',
  'odesilatel_jmeno', 'odesilatel_email',
  'unsubscribe_url',
])

const SAMPLE_DEFAULTS = {
  jmeno: 'Pavel Novák',
  jmeno_zkraceno: 'Pavle',
  firma: 'AKB Stavby s.r.o.',
  firma_short: 'AKB',
  sektor: 'Stavebnictví',
  region: 'Středočeský kraj',
  odesilatel_jmeno: 'Tomáš Messing',
  odesilatel_email: 'info@messing.dev',
  unsubscribe_url: 'https://example.com/unsubscribe?c=1&id=42&t=abcdef0123456789',
}

const RE_MERGE_TAG = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi
const RE_UNBALANCED = /\{\{[^}]*$|^[^{]*\}\}/m

export function renderTemplatePreview(subject, body, sample = {}) {
  const merged = { ...SAMPLE_DEFAULTS, ...sample }
  const warnings = []
  const usedVars = new Set()

  // Unbalanced detection
  if (RE_UNBALANCED.test(subject) || RE_UNBALANCED.test(body)) {
    warnings.push({
      level: 'error',
      code: 'unbalanced_merge_tag',
      message: 'Nezavřený nebo neotevřený merge tag ({{ bez }} nebo naopak).',
    })
  }

  // Substitution + unknown-var detection
  const sub = (s) => String(s).replace(RE_MERGE_TAG, (_, name) => {
    const k = name.toLowerCase()
    usedVars.add(k)
    if (!KNOWN_VARS.has(k)) {
      warnings.push({
        level: 'warn',
        code: 'unknown_merge_tag',
        message: `Neznámý merge tag {{${name}}}. Známé: ${[...KNOWN_VARS].join(', ')}.`,
      })
      return `{{${name}}}` // leave as-is so operator sees the typo
    }
    return merged[k] != null ? String(merged[k]) : ''
  })

  const renderedSubject = sub(subject)
  const renderedBody = sub(body)

  // Empty checks
  if (!subject || !subject.trim()) {
    warnings.push({ level: 'error', code: 'empty_subject', message: 'Předmět je prázdný — email by skončil ve spam folderu.' })
  }
  if (!body || !body.trim()) {
    warnings.push({ level: 'error', code: 'empty_body', message: 'Tělo je prázdné — operátor zapomněl content.' })
  }

  // Compliance: unsubscribe link reference. Body should mention either
  // {{unsubscribe_url}} or contain a literal /unsubscribe URL.
  const hasUnsubMerge = usedVars.has('unsubscribe_url')
  const hasUnsubLiteral = /\/unsubscribe\b/i.test(body)
  if (!hasUnsubMerge && !hasUnsubLiteral) {
    warnings.push({
      level: 'error',
      code: 'no_unsubscribe',
      message: 'Email neobsahuje odkaz na odhlášení — porušení compliance.',
    })
  }

  // Sample plaintext extraction (cheap heuristic — strip tags)
  const plaintext = renderedBody.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

  return {
    ok: warnings.every(w => w.level !== 'error'),
    subject: renderedSubject,
    body: renderedBody,
    plaintext_preview: plaintext.slice(0, 500),
    used_vars: [...usedVars].sort(),
    warnings,
  }
}

export const _internals = { KNOWN_VARS, SAMPLE_DEFAULTS, RE_MERGE_TAG }
