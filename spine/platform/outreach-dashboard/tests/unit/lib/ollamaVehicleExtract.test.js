import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { extractVehiclesLLM, LLM_EXTRACTOR_VERSION } from '../../../src/lib/ollamaVehicleExtract.js'

const OLLAMA = 'https://ollama-test.example'

function mockGenerate(responseObj) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ response: JSON.stringify(responseObj) }),
  }))
}

describe('extractVehiclesLLM', () => {
  beforeEach(() => { process.env.OLLAMA_URL = OLLAMA })
  afterEach(() => { delete process.env.OLLAMA_URL; vi.restoreAllMocks() })

  it('returns null (→ regex fallback) when OLLAMA_URL is unset', async () => {
    delete process.env.OLLAMA_URL
    expect(await extractVehiclesLLM('mazda 6 rv 2005')).toBeNull()
  })

  it('returns null on empty text', async () => {
    expect(await extractVehiclesLLM('   ')).toBeNull()
  })

  it('maps the LLM JSON to the canonical vehicle shape (the mazda 6 case)', async () => {
    vi.stubGlobal('fetch', mockGenerate({ vehicles: [
      { make: 'Mazda', model: 6, year: 2005, mileage_km: 0, price_eur: 0, body_type: 'osobní', note: 'bez TK' },
    ] }))
    const out = await extractVehiclesLLM('mam tady mazda 6, rv 2005, bez TK')
    expect(out.extractor_version).toBe(LLM_EXTRACTOR_VERSION)
    expect(out.vehicles).toHaveLength(1)
    expect(out.vehicles[0]).toMatchObject({
      make: 'Mazda', model: '6', year: 2005,
      mileage_km: null,            // 0 → null (unknown)
      price_offered_eur: null,     // 0 → null
      confidence: 0.75, matched_patterns: ['llm'],
    })
  })

  it('drops entries with neither make nor model', async () => {
    vi.stubGlobal('fetch', mockGenerate({ vehicles: [{ note: 'no vehicle' }, { make: 'BMW' }] }))
    const out = await extractVehiclesLLM('text')
    expect(out.vehicles).toHaveLength(1)
    expect(out.vehicles[0].make).toBe('BMW')
  })

  it('returns empty vehicles when the model finds none (not a fallback trigger)', async () => {
    vi.stubGlobal('fetch', mockGenerate({ vehicles: [] }))
    const out = await extractVehiclesLLM('Nemám žádná auta.')
    expect(out).not.toBeNull()
    expect(out.vehicles).toEqual([])
  })

  it('returns null on non-ok response (→ regex fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    expect(await extractVehiclesLLM('mazda 6')).toBeNull()
  })

  it('returns null on fetch throw / timeout (→ regex fallback, never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    expect(await extractVehiclesLLM('mazda 6')).toBeNull()
  })
})
