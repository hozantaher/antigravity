import { describe, it, expect } from 'vitest'
import { wrapIndex } from '~/features/supply/media-upload/logic/galleryNav'

describe('wrapIndex', () => {
  it('advances within bounds', () => {
    expect(wrapIndex(0, 5, 1)).toBe(1)
    expect(wrapIndex(3, 5, 1)).toBe(4)
  })

  it('steps backward within bounds', () => {
    expect(wrapIndex(3, 5, -1)).toBe(2)
  })

  it('wraps forward past the last image', () => {
    expect(wrapIndex(4, 5, 1)).toBe(0)
  })

  it('wraps backward past the first image', () => {
    expect(wrapIndex(0, 5, -1)).toBe(4)
  })

  it('handles a single image (always index 0)', () => {
    expect(wrapIndex(0, 1, 1)).toBe(0)
    expect(wrapIndex(0, 1, -1)).toBe(0)
  })

  it('handles multi-step deltas larger than the length', () => {
    expect(wrapIndex(0, 5, 7)).toBe(2)
    expect(wrapIndex(0, 5, -7)).toBe(3)
  })

  it('returns 0 for an empty list', () => {
    expect(wrapIndex(0, 0, 1)).toBe(0)
  })

  it('defaults delta to 1', () => {
    expect(wrapIndex(1, 3)).toBe(2)
  })
})
