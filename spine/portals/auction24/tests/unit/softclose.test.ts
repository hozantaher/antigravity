import { describe, it, expect } from 'vitest'
import { softCloseEnd } from '~/server/repos/itemRepo'

const MIN = 60_000
const now = new Date('2025-06-01T12:00:00Z').getTime()

describe('softCloseEnd', () => {
  it('leaves the end unchanged for a bid well before the last 3 minutes', () => {
    const end = now + 60 * MIN
    expect(softCloseEnd(end, now)).toBe(end)
  })

  it('extends the end by 3 minutes for a bid inside the last 3 minutes', () => {
    const end = now + 2 * MIN // within the 3-min window
    expect(softCloseEnd(end, now)).toBe(now + 3 * MIN)
  })

  it('extends when a bid lands exactly on the 3-minute boundary', () => {
    const end = now + 3 * MIN
    expect(softCloseEnd(end, now)).toBe(now + 3 * MIN)
  })

  it('still extends for a bid placed just after the end (race at close)', () => {
    const end = now - 1000
    expect(softCloseEnd(end, now)).toBe(now + 3 * MIN)
  })

  it('returns null when there is no end date (ads)', () => {
    expect(softCloseEnd(null, now)).toBeNull()
  })
})
