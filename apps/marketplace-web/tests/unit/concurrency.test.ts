import { describe, expect, it } from 'vitest'
import { createLimiter, mapWithConcurrency } from '~/server/utils/concurrency'

describe('mapWithConcurrency', () => {
  it('maps every item, preserving order by index', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async n => n * 2)
    expect(out).toEqual([2, 4, 6, 8, 10])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
      },
    )
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1) // actually ran concurrently, not serially
  })

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([])
    expect(await mapWithConcurrency([1, 2], 99, async n => n)).toEqual([1, 2])
  })

  it('rejects if a worker throws (callers wrap per-item)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async n => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})

describe('createLimiter', () => {
  it('runs all scheduled tasks but never more than `limit` at once', async () => {
    const schedule = createLimiter(3)
    let inFlight = 0
    let peak = 0
    let done = 0
    const total = 12
    await new Promise<void>(resolve => {
      for (let i = 0; i < total; i++) {
        schedule(async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise(r => setTimeout(r, 1))
          inFlight--
          if (++done === total) resolve()
        })
      }
    })
    expect(done).toBe(total)
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('keeps draining the queue after a task rejects', async () => {
    const schedule = createLimiter(2)
    let done = 0
    await new Promise<void>(resolve => {
      for (let i = 0; i < 5; i++) {
        schedule(async () => {
          if (i === 1) throw new Error('boom')
          if (++done === 4) resolve()
        })
      }
    })
    expect(done).toBe(4) // the 4 non-throwing tasks all ran despite one rejection
  })
})
