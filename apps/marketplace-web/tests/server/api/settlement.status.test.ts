import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/item/[id]/settlement.get'
import { requireSession } from '~/server/utils/session'
import { getSettlementStatus } from '~/server/utils/settlement'
import { findSettlementCandidate } from '~/server/repos/settlementRepo'

vi.mock('~/server/utils/session', () => ({ requireSession: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/settlement', () => ({ getSettlementStatus: vi.fn() }))
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
  invoice: undefined,
  ...over,
})

const event = () => makeEvent({ params: { id: 'i1' } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireSession).mockResolvedValue({ id: 'u1' } as never)
  vi.mocked(findSettlementCandidate).mockResolvedValue(candidate() as never)
  vi.mocked(getSettlementStatus).mockResolvedValue({ itemId: 'i1', state: 'due' } as never)
})

describe('GET /api/item/:id/settlement', () => {
  it('returns the projected settlement status for the winner', async () => {
    const res = await handler(event() as never)
    expect(getSettlementStatus).toHaveBeenCalledWith('i1')
    expect(res).toMatchObject({ state: 'due' })
  })

  it('still serves a COMPLETED sale (the wizard polls to success — completion is not a gate here)', async () => {
    vi.mocked(findSettlementCandidate).mockResolvedValue(candidate({ settledAt: new Date() }) as never)
    vi.mocked(getSettlementStatus).mockResolvedValue({ itemId: 'i1', state: 'completed' } as never)
    const res = await handler(event() as never)
    expect(res).toMatchObject({ state: 'completed' })
  })

  it('403 for a non-winner', async () => {
    vi.mocked(requireSession).mockResolvedValue({ id: 'intruder' } as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(getSettlementStatus).not.toHaveBeenCalled()
  })

  it('404 for an unsold item', async () => {
    vi.mocked(findSettlementCandidate).mockResolvedValue(candidate({ sold: false }) as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('404 when the item does not exist', async () => {
    vi.mocked(findSettlementCandidate).mockResolvedValue(undefined as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400 when the item id is missing', async () => {
    await expect(handler(makeEvent({ params: {} }) as never)).rejects.toMatchObject({ statusCode: 400 })
  })
})
