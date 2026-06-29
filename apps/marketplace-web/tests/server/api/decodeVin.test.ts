import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/admin/items/decode-vin.post'
import { requireAdmin } from '~/server/utils/session'
import { decodeVinRemote, VincarioError } from '~/server/utils/vincario'
import { captureServerError } from '~/server/utils/observability'
import { getCachedVinDecode, insertVinDecodeCache } from '~/server/repos/vinDecodeRepo'

vi.mock('~/server/utils/session', () => ({ requireAdmin: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))
vi.mock('~/server/utils/vincario', () => {
  class VincarioError extends Error {
    kind: string
    constructor(kind: string) {
      super(kind)
      this.kind = kind
    }
  }
  return { decodeVinRemote: vi.fn(), VincarioError }
})
vi.mock('~/server/repos/vinDecodeRepo', () => ({ getCachedVinDecode: vi.fn(), insertVinDecodeCache: vi.fn() }))

const VIN = 'WAUZZZ8K9AA123456'
const decode = (body: Record<string, unknown> = { vin: VIN }) => handler(makeEvent({ body }) as never)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdmin).mockResolvedValue({ id: 'a1' } as never)
  vi.mocked(getCachedVinDecode).mockResolvedValue(undefined as never)
})

describe('POST /api/admin/items/decode-vin', () => {
  it('400s on an invalid VIN', async () => {
    await expect(decode({ vin: 'TOOSHORT' })).rejects.toMatchObject({ statusCode: 400 })
    expect(decodeVinRemote).not.toHaveBeenCalled()
  })

  it('returns a cached decode without spending a credit', async () => {
    vi.mocked(getCachedVinDecode).mockResolvedValue({
      normalized: { manufacturer: 'Audi' },
      price: '5',
      priceCurrency: 'EUR',
    } as never)
    const res = await decode()
    expect(res).toEqual({
      vin: VIN,
      normalized: { manufacturer: 'Audi' },
      cached: true,
      price: 5,
      priceCurrency: 'EUR',
    })
    expect(decodeVinRemote).not.toHaveBeenCalled()
  })

  it.each([
    ['rate_limited', 429, true],
    ['insufficient_balance', 402, true],
    ['auth', 502, true],
    ['not_configured', 500, false],
    ['network', 502, true],
  ])('maps VincarioError %s to %d', async (kind, status, reported) => {
    vi.mocked(decodeVinRemote).mockRejectedValue(new VincarioError(kind as never, kind))
    await expect(decode()).rejects.toMatchObject({ statusCode: status })
    expect(vi.mocked(captureServerError).mock.calls.length > 0).toBe(reported)
  })

  it('404s when the decode is sparse (unknown VIN)', async () => {
    vi.mocked(decodeVinRemote).mockResolvedValue({ decode: [] } as never)
    await expect(decode()).rejects.toMatchObject({ statusCode: 404 })
    expect(insertVinDecodeCache).not.toHaveBeenCalled()
  })

  it('decodes, caches, and returns a fresh result', async () => {
    vi.mocked(decodeVinRemote).mockResolvedValue({
      decode: [
        { label: 'Make', value: 'Audi' },
        { label: 'Model', value: 'A4' },
      ],
      price: 1,
      price_currency: 'EUR',
    } as never)
    const res = await decode()
    expect(res).toMatchObject({ vin: VIN, cached: false, price: 1, priceCurrency: 'EUR' })
    expect(res.normalized).toMatchObject({ manufacturer: 'Audi', model: 'A4' })
    expect(insertVinDecodeCache).toHaveBeenCalledWith(expect.objectContaining({ vin: VIN, decodedBy: 'a1' }))
  })

  it('400s when the body carries no vin string', async () => {
    await expect(decode({ vin: 123 })).rejects.toMatchObject({ statusCode: 400 })
    await expect(decode({})).rejects.toMatchObject({ statusCode: 400 })
    expect(decodeVinRemote).not.toHaveBeenCalled()
  })

  it('400s when readBody throws (falls back to an empty body)', async () => {
    const ev = makeEvent({})
    Object.defineProperty((ev as never as { context: Record<string, unknown> }).context, 'body', {
      get() {
        throw new Error('bad json')
      },
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(decodeVinRemote).not.toHaveBeenCalled()
  })

  it('returns a cached decode with a null price', async () => {
    vi.mocked(getCachedVinDecode).mockResolvedValue({
      normalized: { manufacturer: 'Audi' },
      price: null,
      priceCurrency: null,
    } as never)
    const res = await decode()
    expect(res).toEqual({
      vin: VIN,
      normalized: { manufacturer: 'Audi' },
      cached: true,
      price: null,
      priceCurrency: null,
    })
  })

  it('maps a non-VincarioError rejection to a 502 and reports it', async () => {
    vi.mocked(decodeVinRemote).mockRejectedValue(new Error('boom'))
    await expect(decode()).rejects.toMatchObject({ statusCode: 502 })
    expect(captureServerError).toHaveBeenCalled()
  })

  it('decodes a fresh result with no price metadata', async () => {
    vi.mocked(decodeVinRemote).mockResolvedValue({
      decode: [{ label: 'Make', value: 'Audi' }],
    } as never)
    const res = await decode()
    expect(res).toMatchObject({ vin: VIN, cached: false, price: null, priceCurrency: null })
    expect(insertVinDecodeCache).toHaveBeenCalledWith(
      expect.objectContaining({ vin: VIN, price: null, priceCurrency: null }),
    )
  })
})

describe('vincario.ts decodeVinRemote (real implementation)', () => {
  const g = globalThis as Record<string, unknown>
  const loadReal = async () => {
    const actual = await vi.importActual<typeof import('~/server/utils/vincario')>('~/server/utils/vincario')
    return actual
  }

  beforeEach(() => {
    g.useRuntimeConfig = () => ({ vincarioApiKey: 'KEY', vincarioSecretKey: 'SECRET' })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('computes a stable 10-char control sum', async () => {
    const { vincarioControlSum } = await loadReal()
    const sum = vincarioControlSum('wauzzz8k9aa123456', 'KEY', 'SECRET')
    expect(sum).toHaveLength(10)
    // Uppercase normalization: lower/upper VIN hash identically.
    expect(vincarioControlSum('WAUZZZ8K9AA123456', 'KEY', 'SECRET')).toBe(sum)
  })

  it('throws not_configured without API keys', async () => {
    const { decodeVinRemote: real } = await loadReal()
    g.useRuntimeConfig = () => ({})
    await expect(real(VIN)).rejects.toMatchObject({ kind: 'not_configured' })
  })

  it('returns the decode payload on success', async () => {
    const { decodeVinRemote: real } = await loadReal()
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ decode: [{ label: 'Make', value: 'Audi' }] }))
    const res = await real(VIN.toLowerCase())
    expect(res.decode).toHaveLength(1)
  })

  it.each([
    [{ response: { status: 429 }, data: { message: 'whatever' } }, 'rate_limited'],
    [{ data: { message: 'Rate limit exceeded' } }, 'rate_limited'],
    [{ data: { message: 'too many requests' } }, 'rate_limited'],
    [{ data: { message: 'Insufficient credit' } }, 'insufficient_balance'],
    [{ data: { message: 'payment required' } }, 'insufficient_balance'],
    [{ response: { status: 401 }, data: { message: 'nope' } }, 'auth'],
    [{ response: { status: 403 }, data: { message: 'bad control sum' } }, 'auth'],
    [{ data: { message: 'invalid api key' } }, 'auth'],
    [{ data: { message: 'authentication failed' } }, 'auth'],
    [{ data: { error: 'something odd' } }, 'bad_response'],
    [{ data: {} }, 'bad_response'],
    [{}, 'bad_response'],
    [{ response: { status: 500 } }, 'bad_response'],
    [{ code: 'ECONNREFUSED' }, 'network'],
    [{ code: 'ETIMEDOUT' }, 'network'],
    [{ code: 'ENOTFOUND' }, 'network'],
    [{ code: 'EAI_AGAIN' }, 'network'],
    [{ code: 'UND_ERR_CONNECT_TIMEOUT' }, 'network'],
    [{ code: 'UND_ERR_HEADERS_TIMEOUT' }, 'network'],
  ])('maps the upstream failure %o to %s', async (err, kind) => {
    const { decodeVinRemote: real } = await loadReal()
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(err))
    await expect(real(VIN)).rejects.toMatchObject({ kind })
  })

  it('treats a 200 with an error message body as a mapped error', async () => {
    const { decodeVinRemote: real } = await loadReal()
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ message: 'Insufficient balance' }))
    await expect(real(VIN)).rejects.toMatchObject({ kind: 'insufficient_balance' })
  })

  it('treats a 200 with an error field body as a mapped error', async () => {
    const { decodeVinRemote: real } = await loadReal()
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ error: 'bad control sum' }))
    await expect(real(VIN)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('treats a 200 with no decode array and no message as bad_response', async () => {
    const { decodeVinRemote: real } = await loadReal()
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({}))
    await expect(real(VIN)).rejects.toMatchObject({ kind: 'bad_response' })
  })

  it('treats a null response as bad_response', async () => {
    const { decodeVinRemote: real } = await loadReal()
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(null))
    await expect(real(VIN)).rejects.toMatchObject({ kind: 'bad_response' })
  })
})
