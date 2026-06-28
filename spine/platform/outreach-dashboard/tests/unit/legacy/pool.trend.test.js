import { describe, test, expect, beforeEach } from 'vitest'
import { recordSample, snapshot, reset, POOL_TREND_CONSTANTS } from '../../../poolTrend.js'

describe('poolTrend ring buffer', () => {
  beforeEach(() => reset())

  test('empty snapshot has zero stats', () => {
    const snap = snapshot()
    expect(snap.count).toBe(0)
    expect(snap.stats).toEqual({ min: 0, max: 0, avg: 0, current: 0 })
  })

  test('records samples with ISO timestamp', () => {
    const ts = Date.parse('2026-04-21T10:00:00Z')
    recordSample({ working: 5, totalCandidates: 500, timestamp: ts })
    const snap = snapshot()
    expect(snap.count).toBe(1)
    expect(snap.samples[0].working).toBe(5)
    expect(snap.samples[0].ts).toBe('2026-04-21T10:00:00.000Z')
  })

  test('computeStats — min/max/avg/current across samples', () => {
    recordSample({ working: 3, timestamp: 1000 })
    recordSample({ working: 7, timestamp: 2000 })
    recordSample({ working: 5, timestamp: 3000 })
    const snap = snapshot()
    expect(snap.stats.min).toBe(3)
    expect(snap.stats.max).toBe(7)
    expect(snap.stats.avg).toBe(5)
    expect(snap.stats.current).toBe(5)
  })

  test('trims samples beyond MAX (288)', () => {
    for (let i = 0; i < 300; i++) {
      recordSample({ working: i, timestamp: i * POOL_TREND_CONSTANTS.SLOT_MS })
    }
    const snap = snapshot()
    expect(snap.count).toBe(POOL_TREND_CONSTANTS.MAX_SAMPLES)
    expect(snap.stats.current).toBe(299)
  })

  test('drops samples older than 24h window', () => {
    const now = Date.now()
    recordSample({ working: 1, timestamp: now - 25 * 60 * 60 * 1000 }) // 25h old
    recordSample({ working: 5, timestamp: now })
    const snap = snapshot()
    expect(snap.count).toBe(1)
    expect(snap.stats.current).toBe(5)
  })

  test('coerces bad working to 0, not NaN', () => {
    recordSample({ working: -3, timestamp: 1000 })
    recordSample({ working: null, timestamp: 2000 })
    recordSample({ working: 'oops', timestamp: 3000 })
    const snap = snapshot()
    expect(snap.samples.map(s => s.working)).toEqual([0, 0, 0])
  })

  test('accepts Date instance as timestamp', () => {
    const d = new Date('2026-04-21T12:00:00Z')
    recordSample({ working: 7, timestamp: d })
    const snap = snapshot()
    expect(snap.samples[0].ts).toBe('2026-04-21T12:00:00.000Z')
  })

  test('window_ms + slot_ms exposed for client', () => {
    const snap = snapshot()
    expect(snap.window_ms).toBe(24 * 60 * 60 * 1000)
    expect(snap.slot_ms).toBe(5 * 60 * 1000)
  })
})
