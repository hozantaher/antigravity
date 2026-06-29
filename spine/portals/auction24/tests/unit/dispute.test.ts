import { describe, expect, it } from 'vitest'
import {
  canTransitionDispute,
  disputeReasonError,
  disputeResolutionError,
  isDisputeResolved,
  DISPUTE_REASON_MAX,
} from '~/models'

describe('disputeReasonError', () => {
  it('accepts a non-empty reason', () => {
    expect(disputeReasonError('Item not as described')).toBeNull()
  })

  it('rejects empty / non-string / over-length (422)', () => {
    expect(disputeReasonError('')?.status).toBe(422)
    expect(disputeReasonError('   ')?.status).toBe(422)
    expect(disputeReasonError(undefined)?.status).toBe(422)
    expect(disputeReasonError('x'.repeat(DISPUTE_REASON_MAX + 1))?.status).toBe(422)
  })
})

describe('disputeResolutionError', () => {
  it('requires a non-empty note', () => {
    expect(disputeResolutionError('Refund issued')).toBeNull()
    expect(disputeResolutionError('')?.status).toBe(422)
    expect(disputeResolutionError(undefined)?.status).toBe(422)
  })
})

describe('canTransitionDispute (state machine)', () => {
  it('moves forward open → review → resolved (open may resolve directly)', () => {
    expect(canTransitionDispute('open', 'review')).toBe(true)
    expect(canTransitionDispute('review', 'resolved')).toBe(true)
    expect(canTransitionDispute('open', 'resolved')).toBe(true)
  })

  it('treats resolved as terminal and refuses backward moves', () => {
    expect(canTransitionDispute('resolved', 'open')).toBe(false)
    expect(canTransitionDispute('resolved', 'review')).toBe(false)
    expect(canTransitionDispute('review', 'open')).toBe(false)
  })
})

describe('isDisputeResolved', () => {
  it('is true only at resolved', () => {
    expect(isDisputeResolved({ status: 'resolved' })).toBe(true)
    expect(isDisputeResolved({ status: 'open' })).toBe(false)
    expect(isDisputeResolved({ status: 'review' })).toBe(false)
  })
})
