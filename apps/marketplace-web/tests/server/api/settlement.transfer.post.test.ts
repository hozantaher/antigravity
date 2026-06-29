import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/item/[id]/settlement/transfer.post'
import { requireSession } from '~/server/utils/session'
import { issueSaleTransfer } from '~/server/utils/settlement'
import { findSettlementCandidate } from '~/server/repos/settlementRepo'

vi.mock('~/server/utils/session', () => ({ requireSession: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/settlement', () => ({ issueSaleTransfer: vi.fn() }))
// settlementError stays REAL (pure gate) — only the candidate read is mocked.
vi.mock('~/server/repos/settlementRepo', async orig => {
  const actual = await orig<typeof import('~/server/repos/settlementRepo')>()
  return { ...actual, findSettlementCandidate: vi.fn() }
})

const candidate = (over: Record<string, unknown> = {}) => ({
  itemId: 'i1',
  sold: true,
  closed: true,
  winnerId: 'u1',
  settledAt: null,
  settlementInvoiceId: null,
  finalAmount: '32000',
  finalCurrency: 'EUR',
  invoice: undefined,
  depositBalanceAmount: '500',
  depositBalanceCurrency: 'EUR',
  ...over,
})

const event = () => makeEvent({ params: { id: 'i1' } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireSession).mockResolvedValue({ id: 'u1' } as never)
  vi.mocked(findSettlementCandidate).mockResolvedValue(candidate() as never)
})

describe('POST /api/item/:id/settlement/transfer', () => {
  it('issues a transfer for the winner', async () => {
    vi.mocked(issueSaleTransfer).mockResolvedValue({
      state: 'transfer',
      amountDue: { amount: 31500 },
      bank: { vs: '1234567890' },
    } as never)
    const res = await handler(event() as never)
    expect(issueSaleTransfer).toHaveBeenCalledWith('i1', 'u1')
    expect(res).toMatchObject({ state: 'transfer' })
  })

  it('returns completed when the deposit fully covers the price (amountDue==0)', async () => {
    vi.mocked(issueSaleTransfer).mockResolvedValue({ state: 'completed', amountDue: { amount: 0 } } as never)
    const res = await handler(event() as never)
    expect(res).toMatchObject({ state: 'completed' })
  })

  it('403 for a non-winner', async () => {
    vi.mocked(requireSession).mockResolvedValue({ id: 'someone-else' } as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(issueSaleTransfer).not.toHaveBeenCalled()
  })

  it('404 for an unsold item', async () => {
    vi.mocked(findSettlementCandidate).mockResolvedValue(candidate({ sold: false }) as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 404 })
    expect(issueSaleTransfer).not.toHaveBeenCalled()
  })

  it('404 when the item does not exist', async () => {
    vi.mocked(findSettlementCandidate).mockResolvedValue(undefined as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('409 when the sale invoice is already paid', async () => {
    vi.mocked(findSettlementCandidate).mockResolvedValue(candidate({ invoice: { status: 'paid' } }) as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 409 })
    expect(issueSaleTransfer).not.toHaveBeenCalled()
  })

  it('409 when the sale was already completion-stamped', async () => {
    vi.mocked(findSettlementCandidate).mockResolvedValue(candidate({ settledAt: new Date() }) as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('400 when the item id is missing', async () => {
    await expect(handler(makeEvent({ params: {} }) as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('propagates a session rejection before any work', async () => {
    vi.mocked(requireSession).mockRejectedValue(createError({ statusCode: 401 }))
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(findSettlementCandidate).not.toHaveBeenCalled()
  })
})
