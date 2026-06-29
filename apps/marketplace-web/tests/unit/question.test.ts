import { describe, expect, it } from 'vitest'
import { isQuestionVisible, questionInputError, QUESTION_BODY_MAX } from '~/models'

describe('isQuestionVisible', () => {
  it('is true only for a published question', () => {
    expect(isQuestionVisible({ status: 'published' })).toBe(true)
  })

  it('is false for pending and hidden questions', () => {
    expect(isQuestionVisible({ status: 'pending' })).toBe(false)
    expect(isQuestionVisible({ status: 'hidden' })).toBe(false)
  })
})

describe('questionInputError', () => {
  it('accepts a non-empty body', () => {
    expect(questionInputError('Is the VIN available?')).toBeNull()
  })

  it('rejects a missing or non-string body (400)', () => {
    expect(questionInputError(undefined)?.status).toBe(400)
    expect(questionInputError(123)?.status).toBe(400)
  })

  it('rejects an empty or whitespace-only body (400)', () => {
    expect(questionInputError('')?.status).toBe(400)
    expect(questionInputError('   ')?.status).toBe(400)
  })

  it('rejects an over-length body instead of truncating (400)', () => {
    expect(questionInputError('x'.repeat(QUESTION_BODY_MAX + 1))?.status).toBe(400)
  })

  it('accepts a body exactly at the length cap', () => {
    expect(questionInputError('x'.repeat(QUESTION_BODY_MAX))).toBeNull()
  })
})
