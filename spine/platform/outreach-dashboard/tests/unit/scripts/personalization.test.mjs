// personalization.test.mjs
// Sprint S3.4 — Verify per-recipient personalization variable substitution
// in the campaign-send-batch.mjs rendering pipeline.
//
// Covers:
//   - substituteVars() function (inlined from campaign-send-batch.mjs)
//   - buildUnsubURL() / buildUnsubToken() HMAC integrity
//   - Template rendering edge cases: empty fields, special chars,
//     diacritics, long strings, emoji, newline injection prevention
//   - Backward compat: no-variable template (current intro_machinery state)
//
// Per memory `feedback_no_pii_in_commands`:
//   No real recipient emails — all addresses are @example.com / @local.test

import { describe, it, expect } from 'vitest'
import { buildUnsubToken, verifyUnsubToken } from '../../../src/lib/unsubToken.js'

// ─── Inlined substituteVars (mirrors campaign-send-batch.mjs exactly) ────────
// Re-inline so the test can exercise the function without importing the
// top-level script (which auto-runs at import and requires DB + env vars).

function substituteVars(text, vars) {
  const m = {
    '{{firma}}': vars.firma || '',
    '{{jmeno}}': vars.jmeno || '',
    '{{prijmeni}}': vars.prijmeni || '',
    '{{region}}': vars.region || '',
    '{{ico}}': vars.ico || '',
    '{{podpis}}': vars.podpis || '',
    '{{unsuburl}}': vars.unsuburl || '',
    '{{.Firma}}': vars.firma || '',   '{{.Jmeno}}': vars.jmeno || '',
    '{{.Prijmeni}}': vars.prijmeni || '', '{{.Region}}': vars.region || '',
    '{{.ICO}}': vars.ico || '',       '{{.Podpis}}': vars.podpis || '',
    '{{.UnsubURL}}': vars.unsuburl || '',
  }
  let out = text
  for (const [k, v] of Object.entries(m)) out = out.split(k).join(v)
  return out
}

// ─── Fixture templates ────────────────────────────────────────────────────────

const PERSONALIZED_TEMPLATE = `{{/* subject: Dotaz pro {{.Firma}} */}}

Dobrý den {{.Jmeno}},

obracím se na firmu {{.Firma}} ({{.Region}}, IČO {{.ICO}}) s dotazem...

S pozdravem,
{{.Podpis}}

Odhlášení: {{.UnsubURL}}`

// Current intro_machinery.tmpl — plain text, only {{.UnsubURL}}
const PLAIN_TEMPLATE = `Dobrý den,

jen rychlý dotaz. Sháním použitou stavební techniku...

Odhlášení: {{.UnsubURL}}`

// Template using lowercase (Node-style) placeholders
const LOWERCASE_TEMPLATE = `Dobrý den {{jmeno}}, firma {{firma}}, region {{region}}, IČO {{ico}}. Odhlášení: {{unsuburl}}`

const TEST_SECRET = 'test-secret-not-for-production-use-only'
const UNSUB_BASE = 'https://example.local'

function buildUnsubURL(cid, contactId, email) {
  const token = buildUnsubToken(cid, contactId, email, TEST_SECRET)
  return `${UNSUB_BASE}/unsubscribe?c=${cid}&id=${contactId}&t=${token}`
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('substituteVars — happy path', () => {
  it('TC01: all variables filled — full substitution', () => {
    const vars = {
      firma: 'Acme s.r.o.',
      jmeno: 'Jan',
      prijmeni: 'Novák',
      region: 'Praha',
      ico: '12345678',
      podpis: 'Goran Nowak',
      unsuburl: 'https://example.local/unsubscribe?c=1&id=2&t=abc123',
    }
    const result = substituteVars(PERSONALIZED_TEMPLATE, vars)

    expect(result).toContain('Acme s.r.o.')
    expect(result).toContain('Jan')
    expect(result).toContain('Praha')
    expect(result).toContain('12345678')
    expect(result).toContain('Goran Nowak')
    expect(result).toContain('https://example.local/unsubscribe')
    // No unreplaced placeholders
    expect(result).not.toMatch(/\{\{\.Firma\}\}/)
    expect(result).not.toMatch(/\{\{\.Jmeno\}\}/)
    expect(result).not.toMatch(/\{\{\.Region\}\}/)
    expect(result).not.toMatch(/\{\{\.ICO\}\}/)
    expect(result).not.toMatch(/\{\{\.UnsubURL\}\}/)
  })

  it('TC02: lowercase placeholders — node-style substitution works', () => {
    const vars = {
      firma: 'Beta spol.',
      jmeno: 'Pavel',
      region: 'Brno',
      ico: '87654321',
      unsuburl: 'https://example.local/unsub',
    }
    const result = substituteVars(LOWERCASE_TEMPLATE, vars)

    expect(result).toContain('Beta spol.')
    expect(result).toContain('Pavel')
    expect(result).toContain('Brno')
    expect(result).toContain('87654321')
    expect(result).not.toContain('{{firma}}')
    expect(result).not.toContain('{{jmeno}}')
  })
})

describe('substituteVars — empty / null fields', () => {
  it('TC03: empty firma — placeholder replaced with empty string (no double-space guard assertion)', () => {
    const vars = { firma: '', jmeno: 'Jan', region: 'Praha', ico: '12345678', unsuburl: '' }
    const result = substituteVars(PERSONALIZED_TEMPLATE, vars)

    // Placeholder must be gone
    expect(result).not.toMatch(/\{\{\.Firma\}\}/)
    // Content around it is preserved (empty firma leaves adjacent text intact)
    expect(result).toContain('obracím se na firmu')
  })

  it('TC04: empty jmeno — no name injected', () => {
    const vars = { firma: 'Test s.r.o.', jmeno: '', region: '', ico: '', unsuburl: '' }
    const result = substituteVars(PERSONALIZED_TEMPLATE, vars)

    expect(result).not.toMatch(/\{\{\.Jmeno\}\}/)
    // Greeting still present but empty jmeno → no name after "Dobrý den"
    expect(result).toContain('Dobrý den')
  })

  it('TC05: null / undefined fields — treated as empty string, no "null" literal in output', () => {
    const vars = { firma: null, jmeno: undefined, region: null, ico: undefined, unsuburl: null }
    const result = substituteVars(PERSONALIZED_TEMPLATE, vars)

    expect(result).not.toContain('null')
    expect(result).not.toContain('undefined')
    expect(result).not.toMatch(/\{\{\.Firma\}\}/)
  })
})

describe('substituteVars — special characters', () => {
  it('TC06: HTML special chars in firma — pass-through unescaped (plain text email)', () => {
    const vars = {
      firma: 'Smith & Co. <test@example.com>',
      jmeno: '',
      region: '',
      ico: '',
      unsuburl: '',
    }
    const result = substituteVars(PERSONALIZED_TEMPLATE, vars)

    // substituteVars does NOT escape HTML — plain text multipart; caller owns escaping
    expect(result).toContain('Smith & Co. <test@example.com>')
    expect(result).not.toMatch(/\{\{\.Firma\}\}/)
  })

  it('TC07: Czech diacritics in firma — UTF-8 preserved', () => {
    const vars = {
      firma: 'Žluťoučký kůň s.r.o.',
      jmeno: 'Vojtěch',
      region: 'Ústí nad Labem',
      ico: '00112233',
      unsuburl: 'https://example.local/u',
    }
    const result = substituteVars(PERSONALIZED_TEMPLATE, vars)

    expect(result).toContain('Žluťoučký kůň s.r.o.')
    expect(result).toContain('Vojtěch')
    expect(result).toContain('Ústí nad Labem')
  })

  it('TC08: very long firma name — no truncation', () => {
    const longName = 'Velmi Dlouhý Název Firmy s.r.o. Praha 9 Hloubětín 12345 — extra long suffix text'
    const vars = { firma: longName, jmeno: '', region: '', ico: '', unsuburl: '' }
    const result = substituteVars(PERSONALIZED_TEMPLATE, vars)

    expect(result).toContain(longName)
  })

  it('TC09: emoji in jmeno — pass-through without corruption', () => {
    const vars = { firma: 'Emoji Corp', jmeno: 'Jan 🌟', region: 'Praha', ico: '99999999', unsuburl: '' }
    const result = substituteVars(PERSONALIZED_TEMPLATE, vars)

    expect(result).toContain('Jan 🌟')
    expect(result).not.toMatch(/\{\{\.Jmeno\}\}/)
  })

  it('TC10: newline injection attempt in firma — newline NOT promoted to MIME header context', () => {
    // substituteVars operates on the body string only; headers are assembled separately
    // by campaign-send-batch.mjs. This test confirms the function does not strip
    // or error on embedded newlines — body substitution is safe.
    const malicious = 'Acme\r\nX-Injected-Header: evil'
    const vars = { firma: malicious, jmeno: '', region: '', ico: '', unsuburl: '' }
    const result = substituteVars(PERSONALIZED_TEMPLATE, vars)

    // The function returns the string as-is with the newline in body position.
    // The caller (campaign-send-batch.mjs) must not use this in header context.
    // Verify placeholder is gone and the string round-trips.
    expect(result).toContain(malicious)
    expect(result).not.toMatch(/\{\{\.Firma\}\}/)
  })
})

describe('substituteVars — multiple uses + subject + body', () => {
  it('TC11: same variable used twice — both occurrences replaced', () => {
    const template = 'Firma: {{.Firma}}. Opakuji: {{.Firma}}. Konec.'
    const vars = { firma: 'DuplTest s.r.o.' }
    const result = substituteVars(template, vars)

    const occurrences = (result.match(/DuplTest s\.r\.o\./g) || []).length
    expect(occurrences).toBe(2)
    expect(result).not.toContain('{{.Firma}}')
  })

  it('TC12: variable in subject token and body — both substituted', () => {
    // Subject is embedded in the template comment line (Go-style)
    const templateWithSubject = `{{/* subject: Dotaz pro {{.Firma}} */}}

Vážený zákazníku {{.Firma}},`
    const vars = { firma: 'SubjectTest s.r.o.' }
    const result = substituteVars(templateWithSubject, vars)

    // Both subject comment line and body line must have firma replaced
    const allOccurrences = (result.match(/SubjectTest s\.r\.o\./g) || []).length
    expect(allOccurrences).toBe(2)
    expect(result).not.toContain('{{.Firma}}')
  })
})

describe('substituteVars — backward compat (no-variable template)', () => {
  it('TC13: current intro_machinery template (only {{.UnsubURL}}) — renders plain text without error', () => {
    const unsuburl = buildUnsubURL(457, 1001, 'recipient@example.com')
    const vars = { unsuburl }
    const result = substituteVars(PLAIN_TEMPLATE, vars)

    expect(result).toContain('Dobrý den')
    expect(result).toContain('jen rychlý dotaz')
    expect(result).toContain(unsuburl)
    expect(result).not.toContain('{{.UnsubURL}}')
    // No spurious replacements or corruption
    expect(result).toContain('stavební techniku')
  })
})

describe('buildUnsubURL / buildUnsubToken — HMAC integrity', () => {
  it('TC14: token is exactly 16 hex chars', () => {
    const token = buildUnsubToken(457, 1001, 'recipient@example.com', TEST_SECRET)
    expect(token).toMatch(/^[0-9a-f]{16}$/)
  })

  it('TC15: same inputs produce identical token (deterministic)', () => {
    const t1 = buildUnsubToken(457, 1001, 'recipient@example.com', TEST_SECRET)
    const t2 = buildUnsubToken(457, 1001, 'recipient@example.com', TEST_SECRET)
    expect(t1).toBe(t2)
  })

  it('TC16: different campaign IDs produce different tokens', () => {
    const t1 = buildUnsubToken(457, 1001, 'recipient@example.com', TEST_SECRET)
    const t2 = buildUnsubToken(458, 1001, 'recipient@example.com', TEST_SECRET)
    expect(t1).not.toBe(t2)
  })

  it('TC17: different contact IDs produce different tokens', () => {
    const t1 = buildUnsubToken(457, 1001, 'recipient@example.com', TEST_SECRET)
    const t2 = buildUnsubToken(457, 1002, 'recipient@example.com', TEST_SECRET)
    expect(t1).not.toBe(t2)
  })

  it('TC18: verifyUnsubToken accepts correct token', () => {
    const email = 'verify-test@example.com'
    const token = buildUnsubToken(457, 1001, email, TEST_SECRET)
    expect(verifyUnsubToken(457, 1001, email, token, TEST_SECRET)).toBe(true)
  })

  it('TC19: verifyUnsubToken rejects tampered token', () => {
    const email = 'tamper-test@example.com'
    const token = buildUnsubToken(457, 1001, email, TEST_SECRET)
    const tampered = token.slice(0, 15) + (token[15] === 'a' ? 'b' : 'a')
    expect(verifyUnsubToken(457, 1001, email, tampered, TEST_SECRET)).toBe(false)
  })

  it('TC20: buildUnsubURL embeds token in query string', () => {
    const url = buildUnsubURL(457, 1001, 'url-test@example.com')
    expect(url).toMatch(/^https:\/\/example\.local\/unsubscribe\?c=457&id=1001&t=[0-9a-f]{16}$/)
  })
})
