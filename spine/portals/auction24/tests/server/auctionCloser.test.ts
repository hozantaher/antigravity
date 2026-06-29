import { beforeEach, describe, expect, it, vi } from 'vitest'

import { closeEndedAuctions } from '~/server/utils/auctionCloser'
import * as itemRepo from '~/server/repos/itemRepo'
import * as userRepo from '~/server/repos/userRepo'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { captureServerError } from '~/server/utils/observability'

vi.mock('~/server/repos/itemRepo', () => ({
  listClosableAuctionIds: vi.fn(),
  closeOneAuction: vi.fn(),
  listWinnersPendingEmail: vi.fn(),
  loadBidSummary: vi.fn(),
  markWinnerEmailed: vi.fn(),
}))
vi.mock('~/server/repos/userRepo', () => ({ getByIds: vi.fn() }))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))
vi.mock('~/server/utils/notify', () => ({ notifyWin: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ public: { baseUrl: 'https://app.test' } })
  vi.mocked(itemRepo.listClosableAuctionIds).mockResolvedValue([] as never)
  vi.mocked(itemRepo.listWinnersPendingEmail).mockResolvedValue([] as never)
})

describe('closeEndedAuctions — closing pass', () => {
  it('counts sold/unsold, skips re-extended (null), and isolates per-item errors', async () => {
    vi.mocked(itemRepo.listClosableAuctionIds).mockResolvedValue(['i1', 'i2', 'i3', 'i4'] as never)
    vi.mocked(itemRepo.closeOneAuction).mockImplementation(async (id: string) => {
      if (id === 'i1') return { sold: true } as never
      if (id === 'i2') return { sold: false } as never
      if (id === 'i3') return null as never
      throw new Error('boom')
    })
    const res = await closeEndedAuctions()
    expect(res).toMatchObject({ processed: 2, sold: 1, unsold: 1, errored: 1 })
    expect(captureServerError).toHaveBeenCalledOnce()
  })
})

describe('closeEndedAuctions — email pass', () => {
  beforeEach(() => {
    vi.mocked(itemRepo.listWinnersPendingEmail).mockResolvedValue([
      { itemId: 'i1', winnerUserId: 'u1', title: 'BMW' },
      { itemId: 'i2', winnerUserId: 'u2', title: 'Audi' },
    ] as never)
    vi.mocked(itemRepo.loadBidSummary).mockResolvedValue(new Map([['i1', { last: { amount: 1000 } }]]) as never)
  })

  it('emails winners with a recipient and stamps those without', async () => {
    vi.mocked(userRepo.getByIds).mockResolvedValue([
      { id: 'u1', email: 'w@x.cz', language: { code: 'en' } },
      { id: 'u2', email: null },
    ] as never)
    const res = await closeEndedAuctions()
    expect(res.emailed).toBe(1)
    expect(enqueueEmail).toHaveBeenCalledOnce()
    // Both winners are stamped: the emailed one and the recipient-less one.
    expect(itemRepo.markWinnerEmailed).toHaveBeenCalledTimes(2)
  })

  it('counts an enqueue failure as errored without aborting the batch', async () => {
    vi.mocked(userRepo.getByIds).mockResolvedValue([
      { id: 'u1', email: 'w@x.cz' },
      { id: 'u2', email: 'w2@x.cz' },
    ] as never)
    vi.mocked(enqueueEmail).mockRejectedValueOnce(new Error('redis down'))
    const res = await closeEndedAuctions()
    expect(res.errored).toBe(1)
    expect(res.emailed).toBe(1)
  })
})
