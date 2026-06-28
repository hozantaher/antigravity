/**
 * parseSignature — structured contact block from a reply signature (#1581 M2.1).
 * Inputs are representative CZ signature FORMATS (not fabricated business data):
 * the point is to pin the parser on real-world signature shapes.
 */

import { describe, it, expect } from 'vitest'
import { parseSignature } from '../../../src/lib/parseSignature.js'

describe('parseSignature', () => {
  const full = [
    'Dobrý den, mám zájem.',
    '',
    'S pozdravem',
    'Šlechtová Jana',
    'Zemědělská obchodní společnost, spol. s r.o.',
    'IČO: 47781173',
    'telefon: +420 415 721 007',
    'mobil: +420 728 467 189',
    'zos@agrogast.cz',
  ].join('\n')

  it('extracts company / IČO / email / phones from a full signature', () => {
    const s = parseSignature(full)
    expect(s.hasSignature).toBe(true)
    expect(s.salutation).toBe('S pozdravem')
    expect(s.company).toContain('spol. s r.o.')
    expect(s.ico).toBe('47781173')
    expect(s.email).toBe('zos@agrogast.cz')
    expect(s.phones.map((p) => p.tel)).toEqual(['+420415721007', '+420728467189'])
  })

  it('matches a diacritic salutation and an a.s. company', () => {
    const s = parseSignature('Mám zájem.\n\nDěkuji a přeji hezký den\nNovák, Stavby a.s.\ninfo@stavby.cz')
    expect(s.salutation).toBe('Děkuji a přeji hezký den')
    expect(s.company).toBe('Novák, Stavby a.s.')
    expect(s.email).toBe('info@stavby.cz')
    expect(s.ico).toBeNull()
  })

  it('returns null when there is no signature block', () => {
    expect(parseSignature('Dobrý den, děkuji za nabídku.')).toBeNull()
  })

  it('returns null for null / empty / non-string input', () => {
    expect(parseSignature(null)).toBeNull()
    expect(parseSignature('')).toBeNull()
    expect(parseSignature(42)).toBeNull()
  })

  it('ignores our own signature quoted back below the reply', () => {
    const body = [
      'Nemám zájem.',
      '',
      'Dne 1.6. Obchod napsal:',
      '> S pozdravem',
      '> Garaaage s.r.o.',
      '> IČO: 23219700',
    ].join('\n')
    expect(parseSignature(body)).toBeNull()
  })

  it('does NOT grab an 8-digit number that is not labelled as IČO', () => {
    const s = parseSignature('Mám zájem.\n\nS pozdravem\nFirma s.r.o.\nobjednávka 12345678\ninfo@firma.cz')
    expect(s.ico).toBeNull()
  })

  it('falls back to the tail block when there is no salutation', () => {
    const s = parseSignature('Posílám info níže.\nStroje CZ spol. s r.o.\nIČO: 11122233\nprodej@stroje.cz')
    expect(s.company).toContain('spol. s r.o.')
    expect(s.ico).toBe('11122233')
  })
})
