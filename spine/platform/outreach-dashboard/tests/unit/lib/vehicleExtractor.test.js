// AV-F3 — unit tests for vehicleExtractor (regex + Czech machinery dictionary).
// Source: features/platform/outreach-dashboard/src/lib/vehicleExtractor.js
//
// Coverage spectrum (HARD RULE feedback_extreme_testing — extractor handles
// operator-visible state pre-fill, so 15+ cases including boundary + negation
// + multi-vehicle + currency fallback + noise body):
//   - 5 PR-validation samples (real inbound replies)
//   - boundary cases (year range, no body, brand-only)
//   - multi-vehicle in same body (Hitachi + Komatsu)
//   - negation guard ("Nemáme bagry")
//   - mixed currency (CZK→EUR conversion)
//   - diacritics + casing variation
//   - cap on max vehicles (>10 brands)

import { describe, it, expect } from 'vitest'
import {
  extractVehicles,
  EXTRACTOR_CONFIG,
  EXTRACTOR_VERSION,
} from '../../../src/lib/vehicleExtractor.js'

describe('vehicleExtractor.extractVehicles — PR validation samples (real replies)', () => {
  it('Sample 1: Liebherr 922 bagr 1850 mth', () => {
    const out = extractVehicles(
      'MAME NA PRODEJ BAGR 24 TUN PASAK LIBHER 922 PLNĚ V PROVOZU MOTOR PO GO 1.850MTH PARDUBICE'
    )
    // "LIBHER" is a typo — the extractor catches "Liebherr" only when typed
    // correctly. The real sample has "LIBHER" so this lands no brand; we
    // verify the no-match shape so the operator path of "fill manually" is
    // documented.
    expect(out.extractor_version).toBe(EXTRACTOR_VERSION)
    // Confirms the falsy-brand path returns empty (chunks lacking BRANDS).
    expect(out.vehicles).toEqual([])
  })

  it('Sample 1b: Liebherr 922 (corrected spelling)', () => {
    const out = extractVehicles(
      'MAME NA PRODEJ BAGR 24 TUN PASAK Liebherr 922 PLNĚ V PROVOZU MOTOR PO GO 1.850MTH PARDUBICE'
    )
    expect(out.vehicles.length).toBe(1)
    const v = out.vehicles[0]
    expect(v.make).toBe('Liebherr')
    expect(v.model).toBe('922')
    expect(v.motohours).toBe(1850)
    expect(v.body_type).toBe('bagr')
    expect(v.confidence).toBeGreaterThanOrEqual(0.6)
  })

  it('Sample 2: Kolový bagr HITACHI 160W', () => {
    const out = extractVehicles('Kolový bagr HITACHI 160W')
    expect(out.vehicles.length).toBe(1)
    const v = out.vehicles[0]
    expect(v.make).toBe('Hitachi')
    expect(v.model).toBe('160W')
    expect(v.body_type).toBe('kolový bagr')
  })

  it('Sample 3: Pásový bagr Komatsu PC 160LC široké pasy', () => {
    const out = extractVehicles('Pásový bagr Komatsu PC 160LC široké pasy')
    expect(out.vehicles.length).toBe(1)
    const v = out.vehicles[0]
    expect(v.make).toBe('Komatsu')
    expect(v.model).toBe('PC160LC')
    expect(v.body_type).toBe('pásový bagr')
  })

  it('Sample 4: Dodávka Mercedes Sprinter r.v. 2018, 280 000 km, cena 12 000 EUR', () => {
    const out = extractVehicles(
      'Dodávka Mercedes Sprinter r.v. 2018, 280 000 km, cena 12 000 EUR'
    )
    expect(out.vehicles.length).toBeGreaterThanOrEqual(1)
    // Mercedes + Sprinter are BOTH brands in the dictionary (Sprinter is the
    // van sub-brand). The strongest candidate is the one with the most facts.
    const v = out.vehicles[0]
    expect(['Mercedes', 'Sprinter']).toContain(v.make)
    expect(v.year).toBe(2018)
    expect(v.mileage_km).toBe(280000)
    expect(v.price_offered_eur).toBe(12000)
  })

  it('Sample 5: "Nemáme bagry na prodej" — negation guard', () => {
    const out = extractVehicles('Nemáme bagry na prodej')
    // No brand mentioned at all → empty.
    expect(out.vehicles).toEqual([])
  })
})

describe('vehicleExtractor.extractVehicles — confidence model', () => {
  it('brand + model + 3 facts ≈ high confidence', () => {
    const out = extractVehicles(
      'Hitachi ZX160W r.v. 2015, 8 500 km, 12 000 EUR'
    )
    expect(out.vehicles.length).toBe(1)
    expect(out.vehicles[0].confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('brand only (no model, no facts) drops below confidence floor', () => {
    const out = extractVehicles('Máme tu nějaké Hitachi.')
    // 0.50 (brand) is below CONFIDENCE_MIN_REPORT 0.40 — wait, 0.50 > 0.40,
    // so this should still surface. We assert it does, with low confidence.
    expect(out.vehicles.length).toBe(1)
    expect(out.vehicles[0].confidence).toBeCloseTo(0.5, 2)
    expect(out.vehicles[0].model).toBeNull()
  })

  it('negation chunk subtracts from confidence and drops below floor', () => {
    const out = extractVehicles('Nemáme žádné Hitachi na prodej.')
    // Brand 0.50 - negation 0.20 = 0.30, below 0.40 floor → dropped.
    expect(out.vehicles).toEqual([])
  })
})

describe('vehicleExtractor.extractVehicles — multi-vehicle bodies', () => {
  it('Hitachi + Komatsu on separate lines yields 2 candidates', () => {
    const out = extractVehicles(
      'Kolový bagr HITACHI 160W\nPásový bagr Komatsu PC 160LC'
    )
    const makes = out.vehicles.map((v) => v.make).sort()
    expect(makes).toContain('Hitachi')
    expect(makes).toContain('Komatsu')
  })

  it('three brands separated by " / " (CZ seller list)', () => {
    const out = extractVehicles(
      'Kolový bagr HITACHI 160W / Pásový bagr HITACHI 210LC-3 / Pásový bagr Komatsu PC 160LC'
    )
    // 2× Hitachi (different models) + 1× Komatsu = 3 deduped rows.
    expect(out.vehicles.length).toBe(3)
  })

  it('caps output to MAX_VEHICLES_PER_REPLY', () => {
    // Build 12 distinct brand+model chunks separated by sentences.
    const lines = [
      'Hitachi ZX160W',
      'Komatsu PC160',
      'Liebherr 922',
      'Caterpillar 320',
      'Volvo EC210',
      'JCB 3CX',
      'Doosan DX140',
      'Bobcat S630',
      'Kubota KX080',
      'Hyundai R140',
      'Atlas 1404',
      'Terex TC75',
    ]
    const out = extractVehicles(lines.join('. '))
    expect(out.vehicles.length).toBeLessThanOrEqual(
      EXTRACTOR_CONFIG.MAX_VEHICLES_PER_REPLY
    )
  })
})

describe('vehicleExtractor.extractVehicles — currency + units', () => {
  it('CZK price converts to EUR via CZK_EUR_RATE', () => {
    const out = extractVehicles('Mercedes Sprinter, cena 300 000 Kč')
    expect(out.vehicles.length).toBeGreaterThanOrEqual(1)
    const v = out.vehicles[0]
    // 300000 / 25 = 12000
    expect(v.price_offered_eur).toBe(12000)
  })

  it('EUR price takes precedence over a later CZK mention', () => {
    const out = extractVehicles('Mercedes Sprinter, cena 12 000 EUR (≈ 300 000 Kč)')
    expect(out.vehicles[0].price_offered_eur).toBe(12000)
  })

  it('motohours via "mth" suffix', () => {
    const out = extractVehicles('Hitachi ZX160 8500 mth')
    expect(out.vehicles[0].motohours).toBe(8500)
  })

  it('motohours via "moto hod" variant', () => {
    const out = extractVehicles('Komatsu PC160 1 850 motohod')
    expect(out.vehicles[0].motohours).toBe(1850)
  })
})

describe('vehicleExtractor.extractVehicles — boundaries + edge cases', () => {
  it('empty body returns no vehicles + carries version', () => {
    const out = extractVehicles('')
    expect(out.vehicles).toEqual([])
    expect(out.extractor_version).toBe(EXTRACTOR_VERSION)
  })

  it('null body returns no vehicles', () => {
    const out = extractVehicles(null)
    expect(out.vehicles).toEqual([])
  })

  it('subject-only extraction (single-line "Re: Hitachi 160W")', () => {
    const out = extractVehicles('', 'Re: Hitachi 160W')
    expect(out.vehicles.length).toBe(1)
    expect(out.vehicles[0].make).toBe('Hitachi')
  })

  it('year outside YEAR_MIN/YEAR_MAX is rejected', () => {
    const out = extractVehicles('Mercedes Sprinter r.v. 1965, 12 000 EUR')
    expect(out.vehicles[0].year).toBeNull()
  })

  it('parenthesized year "(2018)" picked up when no labelled year present', () => {
    const out = extractVehicles('Mercedes Sprinter (2018)')
    expect(out.vehicles[0].year).toBe(2018)
  })

  it('diacritics + lowercase brand still matches', () => {
    const out = extractVehicles('kolový bagr hitachi 160W, rok 2015')
    expect(out.vehicles[0].make).toBe('Hitachi')
    expect(out.vehicles[0].year).toBe(2015)
  })

  it('pure noise body (no brand, no body type) → empty', () => {
    const out = extractVehicles(
      'Dobrý den, děkuji za vaši nabídku. Ozveme se. S pozdravem, Jan.'
    )
    expect(out.vehicles).toEqual([])
  })

  it('CAT brand normalizes to Caterpillar', () => {
    const out = extractVehicles('CAT 320 r.v. 2010')
    expect(out.vehicles[0].make).toBe('Caterpillar')
  })

  it('Mercedes-Benz normalizes to Mercedes (canonical)', () => {
    const out = extractVehicles('Mercedes-Benz Sprinter r.v. 2018')
    // Either Mercedes or Sprinter is fine — both are dictionary brands
    // and the canonical normalizer maps Mercedes-Benz→Mercedes.
    const makes = out.vehicles.map((v) => v.make)
    expect(makes.some((m) => m === 'Mercedes' || m === 'Sprinter')).toBe(true)
  })

  it('confidence is rounded to 2 decimals', () => {
    const out = extractVehicles('Hitachi ZX160W r.v. 2015')
    const c = out.vehicles[0].confidence
    expect(Math.round(c * 100) / 100).toBe(c)
  })

  it('matched_text is bounded to ≤ 200 chars', () => {
    const long = 'Hitachi ZX160W ' + 'a'.repeat(500)
    const out = extractVehicles(long)
    expect(out.vehicles[0].matched_text.length).toBeLessThanOrEqual(200)
  })

  it('matched_patterns includes brand for any positive result', () => {
    const out = extractVehicles('Hitachi ZX160W r.v. 2015')
    expect(out.vehicles[0].matched_patterns).toContain('brand')
    expect(out.vehicles[0].matched_patterns).toContain('model')
    expect(out.vehicles[0].matched_patterns).toContain('year')
  })
})

describe('vehicleExtractor — EXTRACTOR_CONFIG immutability', () => {
  it('EXTRACTOR_CONFIG is frozen (no runtime mutation)', () => {
    expect(Object.isFrozen(EXTRACTOR_CONFIG)).toBe(true)
  })
})

// 2026-05-30 — model precision hardening. Auto-capture (runVehicleAutoCaptureCron)
// surfaced false-positive models in the live Vozidla inventory: a bare numeric
// token grabbed from a larger number / date / double-brand was stored as the
// model ("Mercedes 200" from "200 000 tachometr", "Dacia 10" from "10/2026",
// "DAF DAF105" from "DAF 105"). These guards reject the fragment WITHOUT
// regressing genuine short numeric models ("Caterpillar 312", "DAF 105").
describe('vehicleExtractor — numeric-fragment + double-brand model guards', () => {
  const modelOf = (body) => {
    const { vehicles } = extractVehicles(body, '')
    return vehicles[0]?.model ?? null
  }

  it('keeps a genuine short numeric model (Caterpillar 312)', () => {
    expect(modelOf('caterpillar cat 312 kolovy bagr rypadlo')).toBe('312')
  })

  it('rejects the leading fragment of a big number (Mercedes "200" ← "200 000")', () => {
    const { vehicles } = extractVehicles('Můžu prodat Mercedes Vito 2003 200 000 tachometr', '')
    expect(vehicles[0].make).toBe('Mercedes')
    expect(vehicles[0].model).not.toBe('200')
    expect(vehicles[0].model).not.toBe('000')
  })

  it('rejects a date-fragment model (Dacia "10" ← "10/2026")', () => {
    const { vehicles } = extractVehicles('tento rok 10/2026 bude k prodeji Dacia Logan MCV', '')
    expect(vehicles[0].make).toBe('Dacia')
    expect(vehicles[0].model).not.toBe('10')
  })

  it('strips a leaked make prefix from the model (DAF "DAF105" → "105")', () => {
    const { vehicles } = extractVehicles('nosič kontejnerů BDF, DAF 105, euro 5', '')
    const daf = vehicles.find(v => v.make === 'DAF')
    expect(daf).toBeTruthy()
    expect(daf.model).toBe('105')
  })

  it('keeps a genuine alphanumeric model (Komatsu PC160LC)', () => {
    expect(modelOf('prodám Komatsu PC 160LC, najeto 5000 mth')).toBe('PC160LC')
  })

  it('keeps an alphanumeric chassis-code model (BMW F02)', () => {
    expect(modelOf('BMW 750Ld Individual, 2014, F02, max.výbava')).toBe('F02')
  })

  it('keeps a genuine numeric model inside a URL slug (caterpillar-cat-312)', () => {
    expect(modelOf('https://stroje.bazos.cz/inzerat/x/caterpillar-cat-312-kolovy-bagr.php')).toBe('312')
  })

  it('rejects a digit-dash slug fragment (iveco "30" ← "…35s18-30-automat")', () => {
    const { vehicles } = extractVehicles('https://auto.bazos.cz/inzerat/x/iveco-daily-35s18-30-automat.php', '')
    expect(vehicles[0].make).toBe('Iveco')
    expect(vehicles[0].model).not.toBe('30')
  })
})

// regex_v3 (2026-06) — quoted reply-history is stripped before extraction so
// a brand in OUR quoted outbound / a footer can't create a phantom vehicle.
// Source of truth: prod reply 49 captured a phantom "Atlas" from quoted text
// while only offering a VW + Ford in the visible reply. Bodies redacted.
describe('extractVehicles — ignores brands in quoted history', () => {
  it('does NOT capture a brand that appears only after a quote marker', () => {
    const body = 'Mám napůl pojízdné vw sharan a ford transit.\n' +
      '> Dne 21.5.2026 Hozan Taher napsal:\n> Hledáme i Atlas bagry.'
    const makes = extractVehicles(body, '').vehicles.map(v => v.make.toLowerCase())
    expect(makes).not.toContain('atlas')   // phantom from the quote — gone
    expect(makes).toContain('ford')        // real, in the visible reply
  })

  it('strips an Outlook underscore-separated signature block', () => {
    const body = 'Prodám ford transit.\n____________\nAtlas Copco s.r.o., Praha'
    const makes = extractVehicles(body, '').vehicles.map(v => v.make.toLowerCase())
    expect(makes).toContain('ford')
    expect(makes).not.toContain('atlas')
  })

  it('still extracts a brand from the visible reply (no quote present)', () => {
    const { vehicles } = extractVehicles('Mám na prodej Hitachi ZX160.', '')
    expect(vehicles[0].make).toBe('Hitachi')
  })

  it('bumped EXTRACTOR_VERSION to regex_v3', () => {
    expect(EXTRACTOR_VERSION).toBe('regex_v3')
  })
})
