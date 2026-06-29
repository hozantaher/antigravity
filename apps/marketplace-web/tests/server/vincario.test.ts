import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeVinRemote } from '~/server/utils/vincario'

const VIN = 'WAUZZZ8K9AA123456'
const g = globalThis as Record<string, unknown>

beforeEach(() => {
  g.useRuntimeConfig = () => ({ vincarioApiKey: 'KEY', vincarioSecretKey: 'SECRET' })
})
afterEach(() => vi.unstubAllGlobals())

describe('decodeVinRemote', () => {
  it('throws not_configured without API keys', async () => {
    g.useRuntimeConfig = () => ({})
    await expect(decodeVinRemote(VIN)).rejects.toMatchObject({ kind: 'not_configured' })
  })

  it('returns the decode payload on success', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ decode: [{ label: 'Make', value: 'Audi' }] }))
    const res = await decodeVinRemote(VIN.toLowerCase())
    expect(res.decode).toHaveLength(1)
  })

  it.each([
    [{ response: { status: 429 }, data: { message: 'Too many requests' } }, 'rate_limited'],
    [{ response: { status: 402 }, data: { message: 'Insufficient credit' } }, 'insufficient_balance'],
    [{ response: { status: 403 }, data: { message: 'bad control sum' } }, 'auth'],
    [{ code: 'ETIMEDOUT' }, 'network'],
  ])('maps the upstream failure %o to %s', async (err, kind) => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(err))
    await expect(decodeVinRemote(VIN)).rejects.toMatchObject({ kind })
  })

  it('treats a 200 with no decode array as an error body', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ message: 'Insufficient balance' }))
    await expect(decodeVinRemote(VIN)).rejects.toMatchObject({ kind: 'insufficient_balance' })
  })
})
