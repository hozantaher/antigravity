/**
 * mineReplySignals — deterministic signal mining from a reply body (#1578 M1.1).
 * Inputs are representative CZ phone/price FORMATS (not fabricated business
 * data): the point is to pin the parser's behaviour on real-world shapes.
 */

import { describe, it, expect } from 'vitest'
import { mineReplySignals } from '../../../src/lib/mineReplySignals.js'

describe('mineReplySignals — phones', () => {
  it('extracts a +420-prefixed number', () => {
    const { phones } = mineReplySignals('Zavolejte mi na +420 775 040 593, díky.')
    expect(phones).toEqual([{ display: '+420 775 040 593', tel: '+420775040593' }])
  })

  it('extracts a grouped 3-3-3 number without prefix', () => {
    const { phones } = mineReplySignals('Tel: 775 040 593')
    expect(phones[0].tel).toBe('+420775040593')
  })

  it('extracts a bare 9-digit mobile (starts 6/7)', () => {
    const { phones } = mineReplySignals('volejte 775040593 kdykoliv')
    expect(phones[0].tel).toBe('+420775040593')
  })

  it('does NOT match an 8-digit IČO', () => {
    const { phones } = mineReplySignals('IČO: 23219700, sídlo Praha')
    expect(phones).toEqual([])
  })

  it('dedupes the same number written two ways', () => {
    const { phones } = mineReplySignals('+420 775 040 593 nebo 775040593')
    expect(phones).toHaveLength(1)
  })

  it('ignores our own footer number quoted back below the reply', () => {
    const body = [
      'Dobrý den, mám zájem.',
      '',
      'Dne 1.6. napsal Obchod <a@b.cz>:',
      '> Volejte na +420 111 222 333 (naše číslo)',
    ].join('\n')
    const { phones } = mineReplySignals(body)
    expect(phones.every((p) => p.tel !== '+420111222333')).toBe(true)
  })

  it('returns empty for null/empty body', () => {
    const e = { phones: [], prices: [], callback: false, urgent: false, locations: [] }
    expect(mineReplySignals(null)).toEqual(e)
    expect(mineReplySignals('')).toEqual(e)
  })
})

describe('mineReplySignals — locations', () => {
  it('detects a kraj name (diacritic-insensitive)', () => {
    expect(mineReplySignals('Stroj stojí v Jihomoravském kraji.').locations).toContain('Jihomoravský kraj')
  })

  it('detects a major city', () => {
    expect(mineReplySignals('Vyzvednutí v Ostravě.').locations).toContain('Ostrava')
  })

  it('does NOT match "most" the common word (bridge)', () => {
    expect(mineReplySignals('Stroj je za mostem u haly.').locations).toEqual([])
  })

  it('no location → empty array', () => {
    expect(mineReplySignals('Děkuji, mám zájem.').locations).toEqual([])
  })
})

describe('mineReplySignals — intent flags', () => {
  it('detects a callback request', () => {
    expect(mineReplySignals('Zavolejte mi prosím.').callback).toBe(true)
    expect(mineReplySignals('Ozvěte se, díky.').callback).toBe(true)
  })

  it('detects urgency', () => {
    expect(mineReplySignals('Spěchá to, potřebuji obratem.').urgent).toBe(true)
    expect(mineReplySignals('Prosím co nejdříve.').urgent).toBe(true)
  })

  it('is calm by default', () => {
    const m = mineReplySignals('Dobrý den, děkuji za nabídku.')
    expect(m.callback).toBe(false)
    expect(m.urgent).toBe(false)
  })
})

describe('mineReplySignals — prices', () => {
  it('extracts a spaced CZK amount', () => {
    const { prices } = mineReplySignals('Cena 1 250 000 Kč, k jednání.')
    expect(prices[0]).toMatchObject({ amount: 1250000, currency: 'CZK' })
  })

  it('extracts a ",-" suffixed amount', () => {
    const { prices } = mineReplySignals('nabízíme 250000,- za stroj')
    expect(prices[0].amount).toBe(250000)
  })

  it('ignores sub-1000 numbers (years, counts)', () => {
    const { prices } = mineReplySignals('rok 2008, 500 motohodin')
    expect(prices).toEqual([])
  })
})
