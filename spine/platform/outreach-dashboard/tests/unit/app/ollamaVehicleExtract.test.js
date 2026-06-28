/**
 * ollamaVehicleExtract — RELATIVE (Ollama) vehicle extraction.
 * Spustit: cd features/platform/outreach-dashboard && pnpm test tests/unit/ollamaVehicleExtract
 *
 * Guards the 2026-05-31 incident: the 20s default timeout sat on the CPU-Ollama
 * tail latency, so every extraction silently aborted → regex fallback → 0
 * ollama_v1 rows in production. These tests pin the request shape + the parser
 * mapping (the model emits sloppy keys; the lib normalizes to the modal schema).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const OLLAMA_URL = 'http://ollama.test'

async function freshImport() {
  vi.resetModules()
  return import('../../../src/lib/ollamaVehicleExtract.js')
}

beforeEach(() => { process.env.OLLAMA_URL = OLLAMA_URL })
afterEach(() => { vi.restoreAllMocks(); delete process.env.OLLAMA_URL })

function mockOllama(responseObj) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ response: JSON.stringify(responseObj) }),
  })))
}

describe('extractVehiclesLLM', () => {
  it('returns null (→ regex fallback) when OLLAMA_URL is unset', async () => {
    delete process.env.OLLAMA_URL
    const { extractVehiclesLLM } = await freshImport()
    expect(await extractVehiclesLLM('Bagr Liebherr 922')).toBeNull()
  })

  it('returns null for empty body without calling the network', async () => {
    const { extractVehiclesLLM } = await freshImport()
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await extractVehiclesLLM('   ')).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('sends a bounded request: format json, keep_alive, num_predict, temperature 0', async () => {
    mockOllama({ vehicles: [] })
    const { extractVehiclesLLM } = await freshImport()
    await extractVehiclesLLM('Prodám bagr')
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.format).toBe('json')
    expect(body.keep_alive).toBeTruthy()
    expect(body.options.temperature).toBe(0)
    expect(body.options.num_predict).toBeGreaterThan(0)
    expect(fetch.mock.calls[0][0]).toBe(`${OLLAMA_URL}/api/generate`)
  })

  it('maps the model output to the modal schema (make/model/year/price)', async () => {
    mockOllama({ vehicles: [{ make: 'Liebherr', model: 922, year: 2015, mileage_km: 1850, price_eur: 45000, body_type: 'bagr' }] })
    const { extractVehiclesLLM } = await freshImport()
    const r = await extractVehiclesLLM('text')
    expect(r.extractor_version).toBe('ollama_v1')
    expect(r.vehicles).toHaveLength(1)
    const v = r.vehicles[0]
    expect(v.make).toBe('Liebherr')
    expect(v.model).toBe('922')            // coerced to string
    expect(v.year).toBe(2015)
    expect(v.mileage_km).toBe(1850)
    expect(v.price_offered_eur).toBe(45000)
    expect(v.matched_patterns).toContain('llm')
  })

  it('drops zero numerics (model returns 0 for missing) and entries with no make+model', async () => {
    mockOllama({ vehicles: [
      { make: 'Iveco', year: 0, mileage_km: 0, price_eur: 0 },
      { make: null, model: null, note: 'nic' },
    ] })
    const { extractVehiclesLLM } = await freshImport()
    const r = await extractVehiclesLLM('text')
    expect(r.vehicles).toHaveLength(1)        // the make:null,model:null row is filtered out
    const v = r.vehicles[0]
    expect(v.year).toBeNull()
    expect(v.mileage_km).toBeNull()
    expect(v.price_offered_eur).toBeNull()
  })

  it('returns null on HTTP error (→ graceful regex fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    const { extractVehiclesLLM } = await freshImport()
    expect(await extractVehiclesLLM('text')).toBeNull()
  })
})
