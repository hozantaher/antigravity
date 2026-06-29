import type { vi } from 'vitest'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeEvent } from '../../setup/server'
import decodeOfflineH from '~/server/api/admin/items/decode-vin-offline.post'

const g = globalThis as unknown as { requireAdmin: ReturnType<typeof vi.fn> }

beforeEach(() => {
  g.requireAdmin.mockResolvedValue({ id: 'a1' } as never)
})

describe('admin offline VIN decode', () => {
  it('decodes manufacturer + year for a valid VIN (free, no cost)', async () => {
    const res = await decodeOfflineH(makeEvent({ body: { vin: 'WVWZZZ1KZAW000001' } }) as never)
    expect(res.normalized.manufacturer).toBe('Volkswagen')
    expect(typeof res.normalized.yearOfManufacture).toBe('number')
    expect(res.cached).toBe(false)
    expect(res.price).toBeNull()
  })

  it('400s on an invalid VIN', async () => {
    await expect(decodeOfflineH(makeEvent({ body: { vin: 'NOPE' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})
