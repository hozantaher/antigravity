import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCompanies, fetchCompaniesCount } from '../../../src/lib/companiesApi'

describe('companiesApi — token-based discard', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('fetchCompanies hits /api/companies with qs', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) })
    await fetchCompanies('a=1&b=2')
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/companies?a=1&b=2')
  })

  it('fetchCompaniesCount hits /api/companies/count with qs', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ total: 0 }) })
    await fetchCompaniesCount('x=y')
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/companies/count?x=y')
  })

  it('returns parsed JSON on success', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ rows: [1, 2] }) })
    const r = await fetchCompanies('a=1')
    expect(r.rows).toEqual([1, 2])
  })

  it('throws HTTP N on non-ok', async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    await expect(fetchCompanies('a=1')).rejects.toThrow(/HTTP 500/)
  })

  it('superseded call returns { aborted: true }', async () => {
    let resolveFirst
    globalThis.fetch
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rows: ['second'] }) })

    const p1 = fetchCompanies('a=1')
    const p2 = fetchCompanies('a=2')

    const r2 = await p2
    resolveFirst({ ok: true, json: async () => ({ rows: ['first'] }) })
    const r1 = await p1

    expect(r2.rows).toEqual(['second'])
    expect(r1.aborted).toBe(true)
  })

  it('independent caller keys do not supersede each other', async () => {
    globalThis.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ k: 'a' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ k: 'b' }) })
    const [a, b] = await Promise.all([
      fetchCompanies('x=1', { callerKey: 'k1' }),
      fetchCompanies('x=2', { callerKey: 'k2' }),
    ])
    expect(a.k).toBe('a')
    expect(b.k).toBe('b')
  })

  it('same callerKey — second call wins', async () => {
    let resolveFirst
    globalThis.fetch
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ winner: true }) })

    const p1 = fetchCompanies('a=1', { callerKey: 'same' })
    const p2 = fetchCompanies('a=2', { callerKey: 'same' })
    const r2 = await p2
    resolveFirst({ ok: true, json: async () => ({ winner: false }) })
    const r1 = await p1

    expect(r2.winner).toBe(true)
    expect(r1.aborted).toBe(true)
  })

  it('network error on current token rethrows', async () => {
    globalThis.fetch.mockRejectedValue(new Error('down'))
    await expect(fetchCompanies('a=1')).rejects.toThrow('down')
  })

  it('network error on superseded token → aborted', async () => {
    let rejectFirst
    globalThis.fetch
      .mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })

    const p1 = fetchCompanies('a=1', { callerKey: 'k' })
    const p2 = fetchCompanies('a=2', { callerKey: 'k' })
    await p2
    rejectFirst(new Error('late fail'))
    const r1 = await p1

    expect(r1.aborted).toBe(true)
  })

  it('fetchCompaniesCount default callerKey differs from fetchCompanies', async () => {
    globalThis.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rows: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 9 }) })
    const [a, b] = await Promise.all([fetchCompanies('x=1'), fetchCompaniesCount('x=1')])
    expect(a.rows).toEqual([])
    expect(b.total).toBe(9)
  })

  it('handles empty qs', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) })
    await fetchCompanies('')
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/companies?')
  })

  it('does not mutate input qs', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({}) })
    const qs = 'a=1'
    await fetchCompanies(qs)
    expect(qs).toBe('a=1')
  })

  it('JSON parse error propagates', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => { throw new Error('parse err') },
    })
    await expect(fetchCompanies('a=1')).rejects.toThrow('parse err')
  })

  it('100 sequential calls with same key — only last survives', async () => {
    const pending = []
    globalThis.fetch.mockImplementation(() => new Promise((res) => { pending.push(res) }))
    const promises = []
    for (let i = 0; i < 100; i++) {
      promises.push(fetchCompanies(`i=${i}`, { callerKey: 'burst' }))
    }
    pending.forEach((res, i) => res({ ok: true, json: async () => ({ i }) }))
    const results = await Promise.all(promises)
    const nonAborted = results.filter(r => !r.aborted)
    expect(nonAborted.length).toBe(1)
    expect(nonAborted[0].i).toBe(99)
  })

  it('parallel different caller keys — all survive', async () => {
    globalThis.fetch.mockImplementation((url) => Promise.resolve({
      ok: true, json: async () => ({ url }),
    }))
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => fetchCompanies(`a=${i}`, { callerKey: `k${i}` }))
    )
    expect(results.every(r => !r.aborted)).toBe(true)
  })
})
