import { describe, expect, it } from 'vitest'
import { aggregateReputation, ratingInputError, RATING_COMMENT_MAX } from '~/models'

describe('ratingInputError', () => {
  it('accepts an in-range integer score (with or without a comment)', () => {
    expect(ratingInputError(1)).toBeNull()
    expect(ratingInputError(5)).toBeNull()
    expect(ratingInputError(4, 'Solid seller')).toBeNull()
  })

  it('rejects non-integer / out-of-range / non-number scores (422)', () => {
    expect(ratingInputError(0)?.status).toBe(422)
    expect(ratingInputError(6)?.status).toBe(422)
    expect(ratingInputError(3.5)?.status).toBe(422)
    expect(ratingInputError('5')?.status).toBe(422)
    expect(ratingInputError(undefined)?.status).toBe(422)
  })

  it('rejects an over-length comment instead of truncating (422)', () => {
    expect(ratingInputError(5, 'x'.repeat(RATING_COMMENT_MAX + 1))?.status).toBe(422)
  })
})

describe('aggregateReputation', () => {
  it('averages scores to one decimal and counts them', () => {
    expect(aggregateReputation('s1', [5, 4, 4])).toEqual({ sellerId: 's1', count: 3, average: 4.3 })
  })

  it('returns average null (not a misleading 0) when there are no ratings yet', () => {
    expect(aggregateReputation('s1', [])).toEqual({ sellerId: 's1', count: 0, average: null })
  })
})
