import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../../src/lib/api.js'

// api.js (Sprint G12) is the canonical fetch wrapper: a single function
// `api(path, opts)` that prepends /api, sends a JSON content-type by default,
// returns the parsed body on 2xx, and on non-2xx throws an Error carrying
// `.status` + `.details` (parsed JSON body) so callers branch on HTTP status.
// (The older object-form api.ts with .get/.post was removed — it had no
// consumers and only confused extensionless resolution.)

describe('api client (canonical function form)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>

  it('prepends /api to the path', async () => {
    fetchMock().mockResolvedValue({ ok: true, json: async () => ({ ok: 1 }) })
    await api('/foo')
    expect(fetchMock().mock.calls[0][0]).toBe('/api/foo')
  })

  it('returns parsed JSON on 2xx', async () => {
    fetchMock().mockResolvedValue({ ok: true, json: async () => ({ value: 42 }) })
    const r = await api('/x')
    expect(r.value).toBe(42)
  })

  it('returns the json() result verbatim (no unwrapping)', async () => {
    const payload = { success: true, data: [1, 2, 3] }
    fetchMock().mockResolvedValue({ ok: true, json: async () => payload })
    expect(await api('/x')).toEqual(payload)
  })

  it('sets a JSON content-type by default', async () => {
    fetchMock().mockResolvedValue({ ok: true, json: async () => ({}) })
    await api('/x')
    const init = fetchMock().mock.calls[0][1]
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('passes caller opts through (method + body)', async () => {
    fetchMock().mockResolvedValue({ ok: true, json: async () => ({}) })
    await api('/x', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    const init = fetchMock().mock.calls[0][1]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('throws on non-ok with .status + .details from the JSON error body', async () => {
    fetchMock().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable',
      json: async () => ({ error: 'validation failed', blockers: ['x'] }),
    })
    await expect(api('/x')).rejects.toMatchObject({
      message: 'validation failed',
      status: 422,
      details: { error: 'validation failed', blockers: ['x'] },
    })
  })

  it('falls back to "status statusText" when the error body is not JSON', async () => {
    fetchMock().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => { throw new Error('not json') },
    })
    await expect(api('/x')).rejects.toThrow(/503 Service Unavailable/)
  })

  it('error carries the HTTP status even with a non-JSON body', async () => {
    fetchMock().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Err',
      json: async () => { throw new Error('not json') },
    })
    await api('/x').catch((e: any) => {
      expect(e.status).toBe(500)
      expect(e.details).toBeNull()
    })
  })

  it('propagates a network rejection', async () => {
    fetchMock().mockRejectedValue(new Error('network down'))
    await expect(api('/x')).rejects.toThrow('network down')
  })
})
