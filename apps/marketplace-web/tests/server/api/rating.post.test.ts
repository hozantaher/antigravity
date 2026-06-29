import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent, setSessionUser } from '../../setup/server'

import createRatingH from '~/server/api/item/[id]/rating.post'
import * as repo from '~/server/repos/ratingRepo'

vi.mock('~/server/repos/ratingRepo', () => ({
  findRatingEligibility: vi.fn(),
  ratingExistsForInvoice: vi.fn(),
  createRating: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  setSessionUser({ id: 'buyer1', fullName: 'Buyer', email: 'b@x.cz' })
  vi.mocked(repo.findRatingEligibility).mockResolvedValue({ invoiceId: 'inv1', sellerId: 'seller1' })
  vi.mocked(repo.ratingExistsForInvoice).mockResolvedValue(false)
  vi.mocked(repo.createRating).mockResolvedValue({
    id: 'r1',
    itemId: 'i1',
    sellerId: 'seller1',
    raterId: 'buyer1',
    invoiceId: 'inv1',
    score: 5,
    created: 1,
  } as never)
})

describe('POST /api/item/:id/rating', () => {
  it('creates a rating for the buyer of a settled sale, server-deriving seller+invoice', async () => {
    const res = await createRatingH(
      makeEvent({ params: { id: 'i1' }, body: { score: 5, comment: ' great ' } }) as never,
    )
    expect(repo.findRatingEligibility).toHaveBeenCalledWith('buyer1', 'i1')
    // rater/seller/invoice are server-derived from the settled sale, never the body; comment trimmed.
    expect(repo.createRating).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'i1',
        sellerId: 'seller1',
        raterId: 'buyer1',
        invoiceId: 'inv1',
        score: 5,
        comment: 'great',
      }),
    )
    expect(res).toMatchObject({ id: 'r1' })
  })

  it('403s when this buyer has no settled sale for the item (no fake reputation)', async () => {
    vi.mocked(repo.findRatingEligibility).mockResolvedValue(undefined)
    await expect(createRatingH(makeEvent({ params: { id: 'i1' }, body: { score: 5 } }) as never)).rejects.toMatchObject(
      { statusCode: 403 },
    )
    expect(repo.createRating).not.toHaveBeenCalled()
  })

  it('409s a second rating for the same settled sale (one sale, one rating)', async () => {
    vi.mocked(repo.ratingExistsForInvoice).mockResolvedValue(true)
    await expect(createRatingH(makeEvent({ params: { id: 'i1' }, body: { score: 4 } }) as never)).rejects.toMatchObject(
      { statusCode: 409 },
    )
    expect(repo.createRating).not.toHaveBeenCalled()
  })

  it('422s an out-of-range score before any eligibility lookup', async () => {
    await expect(createRatingH(makeEvent({ params: { id: 'i1' }, body: { score: 9 } }) as never)).rejects.toMatchObject(
      { statusCode: 422 },
    )
    expect(repo.findRatingEligibility).not.toHaveBeenCalled()
  })

  it('rejects an anonymous user with 401 before touching the repo', async () => {
    ;(globalThis as Record<string, unknown>).requireSession = vi
      .fn()
      .mockRejectedValue(createError({ statusCode: 401 }))
    await expect(createRatingH(makeEvent({ params: { id: 'i1' }, body: { score: 5 } }) as never)).rejects.toMatchObject(
      { statusCode: 401 },
    )
    expect(repo.createRating).not.toHaveBeenCalled()
  })
})
