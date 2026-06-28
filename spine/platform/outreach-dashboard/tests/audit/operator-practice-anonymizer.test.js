// @linkage-allowed: discipline ratchet — checks OP1.2 anonymizer logic
/**
 * OP1.2 — brutal coverage for the anonymizer primitives + end-to-end flow.
 *
 * Per memory feedback_no_fabricated_test_data: tests use *synthetic-shaped*
 * input data (the test inputs are clearly fake, e.g. "Honza Novák",
 * "+420 123 456 789") to verify the anonymizer's REGEX behavior. We are
 * testing the tool, not training the operator. Real anonymized fixtures
 * still come from the prod export → tool → fixtures pipeline.
 */

import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, statSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')
const ANON_PATH = join(REPO_ROOT, 'scripts/operator-practice/anonymize.mjs')

let mod
beforeAll(async () => {
  mod = await import(ANON_PATH)
})

// Workaround for ESM lazy import in describe blocks
import { beforeAll } from 'vitest'

describe('OP1.2 — anonymizer file exists + executable', () => {
  // 1. File exists.
  it('anonymize.mjs exists', () => {
    expect(existsSync(ANON_PATH)).toBe(true)
  })

  // 2. File is executable.
  it('anonymize.mjs is executable', () => {
    expect(statSync(ANON_PATH).mode & 0o111).toBeGreaterThan(0)
  })
})

describe('OP1.2 — anonymizeEmail', () => {
  // 3. Basic replacement.
  it('replaces email with @anon.lab address', () => {
    const out = mod.anonymizeEmail('honza@firma.cz')
    expect(out).toMatch(/^prospect-\d{4}@anon\.lab$/)
  })

  // 4. Deterministic — same input → same output.
  it('is deterministic across calls', () => {
    const a = mod.anonymizeEmail('honza@firma.cz')
    const b = mod.anonymizeEmail('honza@firma.cz')
    expect(a).toBe(b)
  })

  // 5. Different inputs → different outputs (with overwhelming probability).
  it('different emails produce different anons (no trivial collisions)', () => {
    const set = new Set()
    for (const e of ['a@x.cz', 'b@x.cz', 'c@x.cz', 'd@x.cz', 'e@x.cz']) {
      set.add(mod.anonymizeEmail(e))
    }
    expect(set.size).toBe(5)
  })

  // 6. Case-insensitive on input.
  it('case-insensitive on input', () => {
    expect(mod.anonymizeEmail('JoHn@DOMAIN.cz')).toBe(mod.anonymizeEmail('john@domain.cz'))
  })

  // 7. Empty / non-email input passes through unchanged.
  it('non-email input unchanged', () => {
    expect(mod.anonymizeEmail('not-an-email')).toBe('not-an-email')
    expect(mod.anonymizeEmail('')).toBe('')
  })
})

describe('OP1.2 — anonymizePhone', () => {
  // 8. CZ +420 with spaces.
  it('strips +420 NNN NNN NNN format', () => {
    expect(mod.anonymizePhone('Tel: +420 605 123 456 zítra')).toBe('Tel: [Telefon] zítra')
  })

  // 9. CZ +420 without separator.
  it('strips +420NNNNNNNNN format', () => {
    expect(mod.anonymizePhone('Tel: +420605123456 zítra')).toBe('Tel: [Telefon] zítra')
  })

  // 10. Bare 9-digit number.
  it('strips bare 9-digit number', () => {
    expect(mod.anonymizePhone('Tel: 605 123 456 zítra')).toBe('Tel: [Telefon] zítra')
  })

  // 11. Hyphen separator.
  it('strips 605-123-456 format', () => {
    expect(mod.anonymizePhone('Tel: 605-123-456 zítra')).toBe('Tel: [Telefon] zítra')
  })

  // 12. Doesn't strip year-like 4-digit numbers.
  it('preserves non-phone numerics', () => {
    expect(mod.anonymizePhone('rok 2026 datum 15.5.')).toBe('rok 2026 datum 15.5.')
  })

  // 12a. Slovak +421 country code stripped (#266 self-review HIGH fix).
  it('strips +421 Slovak number', () => {
    expect(mod.anonymizePhone('volejte +421 905 123 456 dnes')).toBe('volejte [Telefon] dnes')
  })

  // 12b. US-style (NNN) NNN-NNNN stripped (#266 self-review HIGH fix).
  it('strips US (NNN) NNN-NNNN format', () => {
    expect(mod.anonymizePhone('Tel: (605) 123-4567')).toBe('Tel: [Telefon]')
  })

  // 12c. US-style without space (NNN)NNN-NNN stripped.
  it('strips US (NNN)NNN-NNN format', () => {
    expect(mod.anonymizePhone('Tel: (605)123-456 zítra')).toBe('Tel: [Telefon] zítra')
  })
})

describe('OP1.2 — anonymizer self-review HIGH fixes', () => {
  // findReviewCandidates now also flags ALL-CAPS surnames.
  it('flags ALL-CAPS surname (NOVÁK)', () => {
    const out = mod.findReviewCandidates('Volal NOVÁK z firmy.')
    expect(out).toContain('NOVÁK')
  })

  it('flags ALL-CAPS Czech surname (ŠTĚPÁNKA)', () => {
    const out = mod.findReviewCandidates('Setkala se s ŠTĚPÁNKA Novákovou.')
    expect(out).toContain('ŠTĚPÁNKA')
  })

  it('does NOT flag well-known acronyms (CEO, GDPR, PDF, JSON)', () => {
    const out = mod.findReviewCandidates('CEO podepsal GDPR doložku v PDF a poslal JSON.')
    expect(out).not.toContain('CEO')
    expect(out).not.toContain('GDPR')
    expect(out).not.toContain('PDF')
    expect(out).not.toContain('JSON')
  })

  // Email regex now uses /u flag → catches IDN TLDs.
  it('end-to-end email anonymization handles IDN TLD .práce', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'a@b.cz',
      body_text: 'mail honza@firma.práce volal',
    }, 0)
    expect(result.eml).not.toMatch(/honza@firma\.práce/)
    expect(result.eml).toMatch(/prospect-\d{4}@anon\.lab/)
  })
})

describe('OP1.2 — anonymizeURL', () => {
  // 13. Strips company domain.
  it('rewrites bare domain', () => {
    expect(mod.anonymizeURL('viz www.firma.cz')).toMatch(/anon\./)
  })

  // 14. Preserves @anon.lab (already anonymized).
  it('does not double-rewrite @anon.lab', () => {
    expect(mod.anonymizeURL('contact prospect-001@anon.lab')).toContain('anon.lab')
  })

  // 15. Strips full https URL.
  it('rewrites https://example.com/path', () => {
    const out = mod.anonymizeURL('https://example.com/sales/landing')
    expect(out).toMatch(/anon/)
    expect(out).not.toMatch(/example\.com\/sales\/landing/)
  })
})

describe('OP1.2 — anonymizeCzechNames', () => {
  // 16. Replaces top-100 Czech first name in body.
  it('replaces "Jan" with [Jméno]', () => {
    expect(mod.anonymizeCzechNames('Jan Novák píše')).toBe('[Jméno] Novák píše')
  })

  // 17. Lowercase variant also replaced.
  it('replaces lowercase "petr" with [Jméno]', () => {
    expect(mod.anonymizeCzechNames('zdraví petr')).toBe('zdraví [Jméno]')
  })

  // 18. Multiple names in same string.
  it('replaces multiple names', () => {
    const out = mod.anonymizeCzechNames('Jan a Eva přijdou')
    expect(out).toBe('[Jméno] a [Jméno] přijdou')
  })

  // 19. Non-name capitalized words preserved.
  it('preserves non-name capitalized words', () => {
    expect(mod.anonymizeCzechNames('Microsoft Corporation')).toBe('Microsoft Corporation')
  })
})

describe('OP1.2 — anonymizeCompanies', () => {
  // 20. s.r.o. company stripped.
  it('strips "X s.r.o." → [Firma] s.r.o.', () => {
    expect(mod.anonymizeCompanies('ABC Trade s.r.o.')).toMatch(/\[Firma\] s\.r\.o\./)
  })

  // 21. a.s. company stripped.
  it('strips "X a.s." → [Firma] a.s.', () => {
    expect(mod.anonymizeCompanies('Banka Praha a.s.')).toMatch(/\[Firma\] a\.s\./)
  })

  // 22. Multi-word company.
  it('strips multi-word company name', () => {
    expect(mod.anonymizeCompanies('Bohemia Strojírna Praha s.r.o.')).toMatch(/\[Firma\] s\.r\.o\./)
  })
})

describe('OP1.2 — findReviewCandidates', () => {
  // 23. Returns capitalized non-greeting words.
  it('flags suspicious capitalized tokens', () => {
    const out = mod.findReviewCandidates('Dobrý den pane Novotný')
    expect(out).toContain('Novotný')
  })

  // 24. Excludes common greeting words.
  it('excludes greetings (Dobrý, Vážený, Pondělí, etc.)', () => {
    const out = mod.findReviewCandidates('Dobrý den, Pondělí. Vážený pane.')
    expect(out).not.toContain('Dobrý')
    expect(out).not.toContain('Pondělí')
    expect(out).not.toContain('Vážený')
  })

  // 25. Excludes already-anonymized markers.
  it('excludes [Jméno], [Telefon], [Firma]', () => {
    const out = mod.findReviewCandidates('Volejte [Telefon] od [Jméno] z [Firma]')
    expect(out).not.toContain('Telefon')
    expect(out).not.toContain('Jméno')
    expect(out).not.toContain('Firma')
  })
})

describe('OP1.2 — anonymizeMessage end-to-end', () => {
  // 26. Output is RFC822-formatted with required headers.
  it('output has required RFC822 headers', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'honza@firma.cz',
      to_addr: 'op@gmail.lab',
      subject: 'Re: nabídka',
      body_text: 'Dobrý den, děkuji za nabídku ale momentálně neřeším.',
      classification: 'not-interested',
      received_at: '2026-04-25T10:30:00Z',
    }, 1)
    expect(result.eml).toMatch(/^From: prospect-\d{4}@anon\.lab/m)
    expect(result.eml).toMatch(/^To: op@gmail\.lab/m)
    expect(result.eml).toMatch(/^Subject: /m)
    expect(result.eml).toMatch(/^Date: /m)
    expect(result.eml).toMatch(/^Message-ID: /m)
    expect(result.eml).toMatch(/^X-Lab-Source: real-anonymized/m)
    expect(result.eml).toMatch(/^X-Lab-Category: not-interested/m)
  })

  // 27. Classification routes to correct category.
  it('classification field maps to category', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'a@b.cz',
      body_text: 'test',
      classification: 'ooo',
    }, 0)
    expect(result.category).toBe('ooo')
  })

  // 28. Missing classification → ambiguous.
  it('missing classification → ambiguous', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'a@b.cz',
      body_text: 'test',
    }, 0)
    expect(result.category).toBe('ambiguous')
  })

  // 29. Body PII transformations applied (phone + name + email).
  it('body has email + phone + name transformations applied', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'jana@firma.cz',
      body_text: 'Volejte +420 605 123 456. Pavel.',
      classification: 'interested',
    }, 0)
    expect(result.eml).not.toMatch(/605 123 456/)
    expect(result.eml).toContain('[Telefon]')
    expect(result.eml).toContain('[Jméno]')
  })

  // 30. Auto-Submitted header preserved if input flags it.
  it('preserves Auto-Submitted: auto-replied header for OOO messages', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'a@b.cz',
      body_text: 'jsem na dovolené',
      classification: 'ooo',
      auto_submitted: true,
    }, 0)
    expect(result.eml).toMatch(/Auto-Submitted: auto-replied/)
  })

  // 31. Output has X-Anon-Index header for reproducibility.
  it('output has X-Anon-Index header', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'a@b.cz',
      body_text: 'test',
    }, 42)
    expect(result.eml).toMatch(/X-Anon-Index: 42/)
  })

  // 32. CRLF line endings (RFC822 canonical).
  it('uses CRLF line endings', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'a@b.cz',
      body_text: 'test',
    }, 0)
    expect(result.eml).toMatch(/\r\n/)
  })

  // 33. candidates is a non-null array.
  it('candidates returned as array', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'a@b.cz',
      body_text: 'Novotný píše',
    }, 0)
    expect(Array.isArray(result.candidates)).toBe(true)
  })

  // 34. Empty body produces valid eml.
  it('empty body produces valid eml', () => {
    const result = mod.anonymizeMessage({
      from_addr: 'a@b.cz',
      body_text: '',
    }, 0)
    expect(result.eml).toMatch(/^From:/m)
    expect(result.eml).toMatch(/^Content-Type:/m)
  })
})
