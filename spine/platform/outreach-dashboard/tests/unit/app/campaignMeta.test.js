/**
 * campaignMeta — Kampaně overview helpers.
 * Spustit: cd features/platform/outreach-dashboard && pnpm test tests/unit/campaignMeta
 */
import { describe, it, expect } from 'vitest'
import { campaignStatusMeta, bounceRate, statTiles } from '../../../src/app/lib/campaignMeta'

describe('campaignStatusMeta', () => {
  it('maps known statuses, falls back for unknown', () => {
    expect(campaignStatusMeta('running').label).toBe('Běží')
    expect(campaignStatusMeta('paused').label).toBe('Pozastaveno')
    expect(campaignStatusMeta('draft').label).toBe('Koncept')
    expect(campaignStatusMeta('weird').label).toBe('weird')
  })
})

describe('bounceRate', () => {
  it('computes bounced/sent as a 1-decimal percentage', () => {
    expect(bounceRate({ sent: 5691, bounced: 84 })).toBe(1.5)
    expect(bounceRate({ sent: 100, bounced: 5 })).toBe(5)
  })
  it('returns null when nothing sent (no false 0 %)', () => {
    expect(bounceRate({ sent: 0, bounced: 0 })).toBeNull()
    expect(bounceRate({})).toBeNull()
  })
})

describe('statTiles', () => {
  it('returns the four delivery tiles in order, defaulting missing to 0', () => {
    const t = statTiles({ sent: 5691, bounced: 84, failed: 2, presend_skip: 307 })
    expect(t.map((x) => x.label)).toEqual(['Odesláno', 'Odražené', 'Selhalo', 'Přeskočeno'])
    expect(t.map((x) => x.value)).toEqual([5691, 84, 2, 307])
    expect(statTiles({}).map((x) => x.value)).toEqual([0, 0, 0, 0])
  })
})
