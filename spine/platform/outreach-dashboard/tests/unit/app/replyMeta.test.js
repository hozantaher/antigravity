/**
 * Unit tests for the Odpovědi presentation helpers.
 * Spustit: cd features/platform/outreach-dashboard && pnpm test tests/unit/replyMeta
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { classificationMeta, relativeCs, bodyToText, displayName } from '../../../src/app/lib/replyMeta'

describe('classificationMeta', () => {
  it('maps known production classifications to a label', () => {
    expect(classificationMeta('positive').label).toBe('Zájem')
    expect(classificationMeta('negative').label).toBe('Odmítnutí')
    expect(classificationMeta('question').label).toBe('Dotaz')
    expect(classificationMeta('unsubscribe').label).toBe('Odhlášení')
  })
  it('falls back to neutral for null/unknown', () => {
    expect(classificationMeta(null).label).toBe('Nezařazeno')
    expect(classificationMeta('weird_value').label).toBe('Nezařazeno')
  })
})

describe('relativeCs', () => {
  afterEach(() => vi.useRealTimers())
  it('returns empty string for falsy / invalid input', () => {
    expect(relativeCs(null)).toBe('')
    expect(relativeCs('not-a-date')).toBe('')
  })
  it('renders minutes and hours in Czech', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-31T12:00:00Z'))
    expect(relativeCs(new Date('2026-05-31T11:58:00Z').toISOString())).toBe('před 2 min')
    expect(relativeCs(new Date('2026-05-31T09:00:00Z').toISOString())).toBe('před 3 h')
    expect(relativeCs(new Date('2026-05-31T11:59:50Z').toISOString())).toBe('právě teď')
  })
  it('renders day singular vs plural and falls back to a date past a week', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-31T12:00:00Z'))
    expect(relativeCs(new Date('2026-05-30T12:00:00Z').toISOString())).toBe('před 1 dnem')
    expect(relativeCs(new Date('2026-05-28T12:00:00Z').toISOString())).toBe('před 3 dny')
    expect(relativeCs(new Date('2026-05-01T12:00:00Z').toISOString())).toMatch(/\d/)
  })
})

describe('bodyToText (XSS-safe)', () => {
  it('prefers stored plain text', () => {
    expect(bodyToText({ body_text: 'Dobrý den', body_html: '<b>ignored</b>' })).toBe('Dobrý den')
  })
  it('strips script and style blocks entirely', () => {
    const html = '<style>.x{color:red}</style>Hello<script>alert(1)</script> world'
    const out = bodyToText({ body_html: html })
    expect(out).not.toContain('alert')
    expect(out).not.toContain('color:red')
    expect(out).toContain('Hello')
    expect(out).toContain('world')
  })
  it('strips all tags and decodes basic entities', () => {
    const out = bodyToText({ body_html: '<p>A &amp; B</p><div>C&lt;D</div>' })
    expect(out).not.toMatch(/<[^>]+>/)
    expect(out).toContain('A & B')
    expect(out).toContain('C<D')
  })
  it('returns empty string when no body present', () => {
    expect(bodyToText({})).toBe('')
    expect(bodyToText(null)).toBe('')
  })
  it('truncates to the max length', () => {
    expect(bodyToText({ body_text: 'x'.repeat(5000) }, 100)).toHaveLength(100)
  })
})

describe('displayName', () => {
  it('prefers contact name, then email, then placeholder', () => {
    expect(displayName({ contact_name: 'Jan Novák', from_email: 'j@x.cz' })).toBe('Jan Novák')
    expect(displayName({ contact_name: '   ', from_email: 'j@x.cz' })).toBe('j@x.cz')
    expect(displayName({})).toBe('Neznámý odesílatel')
  })
})

import { decodeMimeWords } from '../../../src/app/lib/replyMeta'
describe('decodeMimeWords', () => {
  it('decodes Q-encoding (quoted-printable, _ = space)', () => {
    expect(decodeMimeWords('=?UTF-8?Q?Re=3A_Popt=C3=A1vka?=')).toBe('Re: Poptávka')
  })
  it('decodes B-encoding (base64)', () => {
    expect(decodeMimeWords('=?utf-8?B?UsOhZG8gdsOhcyBvc2xvdsOtbQ==?=')).toBe('Rádo vás oslovím')
  })
  it('passes plain text through unchanged', () => {
    expect(decodeMimeWords('RE: Poptávka')).toBe('RE: Poptávka')
  })
  it('handles null/empty/non-string safely', () => {
    expect(decodeMimeWords(null)).toBe('')
    expect(decodeMimeWords('')).toBe('')
    expect(decodeMimeWords(undefined)).toBe('')
  })
  it('returns input on malformed encoded-word (never throws)', () => {
    expect(decodeMimeWords('=?UTF-8?X?broken?=')).toBe('=?UTF-8?X?broken?=')
  })
})
