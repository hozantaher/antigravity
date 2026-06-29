import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent, setSessionUser } from '../../setup/server'

import openH from '~/server/api/item/[id]/dispute.post'
import reviewH from '~/server/api/admin/disputes/[id]/review.post'
import resolveH from '~/server/api/admin/disputes/[id]/resolve.post'
import * as repo from '~/server/repos/disputeRepo'

vi.mock('~/server/repos/disputeRepo', () => ({
  findDisputeEligibility: vi.fn(),
  disputeExistsForInvoice: vi.fn(),
  openDispute: vi.fn(),
  reviewDispute: vi.fn(),
  resolveDispute: vi.fn(),
}))

const g = globalThis as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  setSessionUser({ id: 'buyer1', fullName: 'B', email: 'b@x.cz' })
  vi.mocked(repo.findDisputeEligibility).mockResolvedValue({ invoiceId: 'inv1' })
  vi.mocked(repo.disputeExistsForInvoice).mockResolvedValue(false)
  vi.mocked(repo.openDispute).mockResolvedValue({ id: 'd1', status: 'open' } as never)
  vi.mocked(repo.reviewDispute).mockResolvedValue({ id: 'd1', status: 'review' } as never)
  vi.mocked(repo.resolveDispute).mockResolvedValue({ id: 'd1', status: 'resolved' } as never)
  g.requireAdmin = vi.fn().mockResolvedValue({ id: 'admin1' })
})

describe('POST /api/item/:id/dispute (open against a settled sale)', () => {
  it('opens a case for the buyer of a settled sale; it starts in open', async () => {
    const res = await openH(makeEvent({ params: { id: 'it1' }, body: { reason: ' Broken ' } }) as never)
    expect(repo.findDisputeEligibility).toHaveBeenCalledWith('buyer1', 'it1')
    expect(repo.openDispute).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'it1', invoiceId: 'inv1', openerId: 'buyer1', reason: 'Broken' }),
    )
    expect(res).toMatchObject({ status: 'open' })
  })

  it('403s without a completed purchase (a complaint always traces to a sale)', async () => {
    vi.mocked(repo.findDisputeEligibility).mockResolvedValue(undefined)
    await expect(openH(makeEvent({ params: { id: 'it1' }, body: { reason: 'x' } }) as never)).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(repo.openDispute).not.toHaveBeenCalled()
  })

  it('409s a second case for the same settled sale', async () => {
    vi.mocked(repo.disputeExistsForInvoice).mockResolvedValue(true)
    await expect(openH(makeEvent({ params: { id: 'it1' }, body: { reason: 'x' } }) as never)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(repo.openDispute).not.toHaveBeenCalled()
  })

  it('422s an empty reason before any eligibility lookup', async () => {
    await expect(openH(makeEvent({ params: { id: 'it1' }, body: { reason: '  ' } }) as never)).rejects.toMatchObject({
      statusCode: 422,
    })
    expect(repo.findDisputeEligibility).not.toHaveBeenCalled()
  })
})

describe('admin dispute transitions (ops decision)', () => {
  it('resolves with a justification + the resolving admin', async () => {
    const res = await resolveH(makeEvent({ params: { id: 'd1' }, body: { resolution: ' Refunded ' } }) as never)
    expect(repo.resolveDispute).toHaveBeenCalledWith('d1', 'admin1', 'Refunded')
    expect(res).toMatchObject({ status: 'resolved' })
  })

  it('404s resolve when no resolvable case remains (already resolved / wrong id)', async () => {
    vi.mocked(repo.resolveDispute).mockResolvedValue(undefined as never)
    await expect(
      resolveH(makeEvent({ params: { id: 'd9' }, body: { resolution: 'x' } }) as never),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('422s resolve without a documented note', async () => {
    await expect(resolveH(makeEvent({ params: { id: 'd1' }, body: {} }) as never)).rejects.toMatchObject({
      statusCode: 422,
    })
    expect(repo.resolveDispute).not.toHaveBeenCalled()
  })

  it('moves an open case into review', async () => {
    await reviewH(makeEvent({ params: { id: 'd1' } }) as never)
    expect(repo.reviewDispute).toHaveBeenCalledWith('d1')
  })

  it('rejects a non-admin from resolving', async () => {
    g.requireAdmin = vi.fn().mockRejectedValue(createError({ statusCode: 403 }))
    await expect(
      resolveH(makeEvent({ params: { id: 'd1' }, body: { resolution: 'x' } }) as never),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
