import { describe, it, expect } from 'vitest'
import { buildSpayd } from '~/server/utils/spayd'

describe('buildSpayd', () => {
  it('builds the SPAYD string in field order', () => {
    const spayd = buildSpayd({
      iban: 'CZ8820100000002903525501',
      amount: 10000,
      currency: 'CZK',
      vs: '1234567890',
      recipient: 'East West 24 s.r.o.',
      message: 'Kauce Jan Novák',
    })
    expect(spayd).toBe(
      'SPD*1.0*ACC:CZ8820100000002903525501*AM:10000.00*CC:CZK*X-VS:1234567890*MSG:Kauce Jan Novák*RN:East West 24 s.r.o.',
    )
  })

  it('strips spaces and uppercases the IBAN', () => {
    const spayd = buildSpayd({
      iban: 'cz79 2010 0000 0025 0352 5502',
      amount: 500,
      currency: 'EUR',
      vs: '1',
      recipient: 'X',
      message: 'Y',
    })
    expect(spayd).toContain('ACC:CZ7920100000002503525502')
    expect(spayd).toContain('AM:500.00')
  })

  it('drops the * separator and the % escape char from user-supplied strings', () => {
    const spayd = buildSpayd({
      iban: 'CZ88',
      amount: 1,
      currency: 'CZK',
      vs: '1',
      recipient: 'A*B',
      message: '*hack* 100%',
    })
    expect(spayd).toContain('MSG:hack 100')
    expect(spayd).toContain('RN:A B')
    // No extra separators got injected: SPD, 1.0 + 6 fields = 8 parts.
    expect(spayd.split('*')).toHaveLength(8)
    expect(spayd).not.toContain('%')
  })

  it('caps MSG at 60 and RN at 35 chars per the SPAYD limits', () => {
    const spayd = buildSpayd({
      iban: 'CZ88',
      amount: 1,
      currency: 'CZK',
      vs: '1',
      recipient: 'R'.repeat(50),
      message: 'M'.repeat(100),
    })
    expect(spayd).toContain(`MSG:${'M'.repeat(60)}*`)
    expect(spayd.endsWith(`RN:${'R'.repeat(35)}`)).toBe(true)
  })
})
