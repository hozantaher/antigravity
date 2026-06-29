import { describe, it, expect } from 'vitest'
import { decodeVinOffline } from '~/utils/offlineVin'

// Fixed currentYear so the recent-cycle year heuristic is deterministic.
const Y = 2026

describe('decodeVinOffline', () => {
  it('rejects malformed VINs (wrong length or forbidden letters)', () => {
    expect(decodeVinOffline('TOOSHORT', Y).valid).toBe(false)
    expect(decodeVinOffline('WVWZZZ1KZAW00000O', Y).valid).toBe(false) // contains forbidden 'O'
  })

  it('decodes a German VW VIN: manufacturer + country + year (recent cycle) + plant', () => {
    const r = decodeVinOffline('WVWZZZ1KZAW000001', Y)
    expect(r.valid).toBe(true)
    expect(r.manufacturer).toBe('Volkswagen')
    expect(r.country).toBe('Germany')
    expect(r.region).toBe('Europe')
    expect(r.yearOfManufacture).toBe(2010) // pos10 'A' → most recent cycle ≤ 2027
    expect(r.plantCode).toBe('W')
    expect(typeof r.checkDigitValid).toBe('boolean') // EU VINs often fail it — informational only
  })

  it('decodes a Czech Škoda VIN', () => {
    const r = decodeVinOffline('TMBJF7NE0J0000000', Y)
    expect(r.manufacturer).toBe('Škoda')
    expect(r.country).toBe('Czech Republic')
    expect(r.region).toBe('Europe')
    expect(r.yearOfManufacture).toBe(2018) // pos10 'J'
  })

  it('validates the check digit on a canonical North-American VIN', () => {
    const r = decodeVinOffline('1HGCM82633A004352', Y)
    expect(r.checkDigitValid).toBe(true)
    expect(r.manufacturer).toBe('Honda (USA)')
    expect(r.country).toBe('United States')
    expect(r.region).toBe('North America')
    expect(r.yearOfManufacture).toBe(2003) // pos10 '3'
  })

  it('leaves manufacturer undefined for an unknown WMI but still decodes year/region', () => {
    const r = decodeVinOffline('ZZZAA11AAAA000001', Y)
    expect(r.valid).toBe(true)
    expect(r.manufacturer).toBeUndefined()
    expect(r.region).toBe('Europe') // 'Z' → Europe
  })

  it('normalizes lowercase + surrounding whitespace', () => {
    const r = decodeVinOffline('  wvwzzz1kzaw000001  ', Y)
    expect(r.valid).toBe(true)
    expect(r.manufacturer).toBe('Volkswagen')
  })

  it('validates a check digit that resolves to X (remainder 10)', () => {
    const r = decodeVinOffline('1M8GDM9AXKP042788', Y) // canonical valid VIN, check digit X
    expect(r.checkDigitValid).toBe(true)
    expect(r.region).toBe('North America')
  })

  it('rejects a tampered check digit', () => {
    const r = decodeVinOffline('1HGCM82633A004353', Y) // last char changed from the valid …352
    expect(r.valid).toBe(true)
    expect(r.checkDigitValid).toBe(false)
  })

  it('clamps an ambiguous year letter to the most recent non-future cycle', () => {
    const r = decodeVinOffline('WVWZZZ1KZYW000001', Y) // pos10 'Y' → 2000 or 2030; 2030 > 2027 → 2000
    expect(r.yearOfManufacture).toBe(2000)
  })

  it('decodes an Asian-region (Japanese) VIN', () => {
    const r = decodeVinOffline('JHMCM82633A004352', Y)
    expect(r.manufacturer).toBe('Honda')
    expect(r.region).toBe('Asia')
    expect(r.country).toBe('Japan')
  })
})
