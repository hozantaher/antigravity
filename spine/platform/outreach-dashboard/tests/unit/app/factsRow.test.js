// factsRow.test.js — unit coverage for the merged "Fakta" builder (#1586).
//
// buildFacts collapses its SignatureCard (identity) + MinedSignals (signals)
// into one ordered chip list. Pure function — tested without rendering.

import { describe, it, expect } from 'vitest'
import { buildFacts } from '../../../src/app/lib/factsRow.js'

describe('buildFacts', () => {
  it('returns empty array when nothing is known', () => {
    expect(buildFacts({})).toEqual([])
    expect(buildFacts({ signature: null, mined: null })).toEqual([])
    expect(buildFacts(undefined)).toEqual([])
  })

  it('builds identity facts from the signature (company, IČO, CRM)', () => {
    const facts = buildFacts({
      signature: { company: 'Stavby Novák s.r.o.', ico: '27123456', crmMatch: { name: 'Novák', crm_status: 'active' } },
    })
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]))
    expect(byKey.company.text).toBe('Stavby Novák s.r.o.')
    expect(byKey.company.kind).toBe('identity')
    expect(byKey.ico.text).toBe('IČO 27123456')
    expect(byKey.ico.href).toBe('/firmy?ico=27123456')
    expect(byKey.crm.text).toBe('známý klient: Novák')
    expect(byKey.crm.tone).toBe('positive')
  })

  it('builds business signals from mined data (price, callback, urgency, location)', () => {
    const facts = buildFacts({
      mined: {
        prices: [{ amount: 320000 }],
        callback: true,
        urgent: true,
        locations: ['Brno'],
      },
    })
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]))
    // Czech thousands grouping uses a non-breaking space — assert on digits.
    expect(byKey['price-0'].text.replace(/\s/g, '')).toBe('320000Kč')
    expect(byKey['price-0'].kind).toBe('signal')
    expect(byKey.callback.text).toBe('chce zavolat')
    expect(byKey.urgent.tone).toBe('urgent')
    expect(byKey.location.text).toBe('Brno')
  })

  it('orders identity facts before signals', () => {
    const facts = buildFacts({
      signature: { company: 'Firma X' },
      mined: { urgent: true },
    })
    expect(facts[0].kind).toBe('identity')
    expect(facts[facts.length - 1].kind).toBe('signal')
  })

  it('renders one chip per mined price', () => {
    const facts = buildFacts({ mined: { prices: [{ amount: 100000 }, { amount: 250000 }] } })
    expect(facts.filter((f) => f.key.startsWith('price-'))).toHaveLength(2)
  })

  it('CRM match without a name still surfaces a chip', () => {
    const facts = buildFacts({ signature: { crmMatch: { crm_status: 'active' } } })
    expect(facts.find((f) => f.key === 'crm').text).toBe('známý klient')
  })
})
