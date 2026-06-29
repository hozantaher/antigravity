import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/deposit/transfer.post'
import { requireSession } from '~/server/utils/session'
import { issueDepositTransfer } from '~/server/utils/deposit'

vi.mock('~/server/utils/session', () => ({ requireSession: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/deposit', () => ({ issueDepositTransfer: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireSession).mockResolvedValue({ id: 'u1' } as never)
})

describe('POST /api/deposit/transfer', () => {
  it.each(['CZK', 'EUR'])('issues a transfer for the %s deposit', async currency => {
    vi.mocked(issueDepositTransfer).mockResolvedValue({ spayd: 'SPD*1.0*' } as never)
    const res = await handler(makeEvent({ body: { currency } }) as never)
    expect(issueDepositTransfer).toHaveBeenCalledWith('u1', currency)
    expect(res).toMatchObject({ spayd: expect.any(String) })
  })

  it.each(['USD', undefined, 'czk'])('rejects the invalid currency %s with 400', async currency => {
    await expect(handler(makeEvent({ body: { currency } }) as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(issueDepositTransfer).not.toHaveBeenCalled()
  })

  it('rejects with 400 when the body is missing entirely (optional chain on undefined)', async () => {
    await expect(handler(makeEvent({ body: undefined }) as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(issueDepositTransfer).not.toHaveBeenCalled()
  })

  it('rejects with 400 when readBody throws (catch falls back to undefined)', async () => {
    const event = makeEvent({ body: { currency: 'CZK' } })
    const broken = {
      ...event,
      context: Object.defineProperty({ ...(event as { context: object }).context }, 'body', {
        get() {
          throw new Error('parse failed')
        },
      }),
    }
    await expect(handler(broken as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(issueDepositTransfer).not.toHaveBeenCalled()
  })

  it('propagates a session rejection before reading the body', async () => {
    vi.mocked(requireSession).mockRejectedValue(createError({ statusCode: 401, statusMessage: 'Unauthorized' }))
    await expect(handler(makeEvent({ body: { currency: 'CZK' } }) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(issueDepositTransfer).not.toHaveBeenCalled()
  })

  it('propagates a downstream issueDepositTransfer rejection', async () => {
    vi.mocked(issueDepositTransfer).mockRejectedValue(new Error('Fakturoid down'))
    await expect(handler(makeEvent({ body: { currency: 'EUR' } }) as never)).rejects.toThrow('Fakturoid down')
    expect(issueDepositTransfer).toHaveBeenCalledWith('u1', 'EUR')
  })
})
