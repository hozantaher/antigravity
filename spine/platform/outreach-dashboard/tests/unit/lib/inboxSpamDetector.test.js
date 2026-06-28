import { describe, it, expect } from 'vitest'
import {
  checkInboxPlacement,
  inferPlacementFromSignals,
  aggregatePlacementStats,
} from '../../../src/lib/inboxSpamDetector.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sentEvent(overrides = {}) {
  return {
    status: 'sent',
    sent_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    bounce_type: null,
    opened_at: null,
    clicked_at: null,
    ...overrides,
  }
}

function oldSentEvent(overrides = {}) {
  return sentEvent({
    sent_at: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(), // 80h ago
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// checkInboxPlacement — async stub
// ---------------------------------------------------------------------------
describe('checkInboxPlacement', () => {
  it('returns unknown result with folder null', async () => {
    const result = await checkInboxPlacement({}, '<msg-id@host>')
    expect(result.result).toBe('unknown')
    expect(result.folder).toBeNull()
  })

  it('returns ms as non-negative number', async () => {
    const result = await checkInboxPlacement({}, '<msg-id@host>', 5000)
    expect(result.ms).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// inferPlacementFromSignals — unit tests
// ---------------------------------------------------------------------------
describe('inferPlacementFromSignals', () => {
  it('null sendEvent → unknown', () => {
    expect(inferPlacementFromSignals(null)).toBe('unknown')
  })

  it('undefined sendEvent → unknown', () => {
    expect(inferPlacementFromSignals(undefined)).toBe('unknown')
  })

  it('bounce_type complaint → spam', () => {
    expect(inferPlacementFromSignals(sentEvent({ bounce_type: 'complaint' }))).toBe('spam')
  })

  it('status bounced → bounced', () => {
    expect(inferPlacementFromSignals(sentEvent({ status: 'bounced' }))).toBe('bounced')
  })

  it('has opened_at → inbox', () => {
    expect(inferPlacementFromSignals(sentEvent({ opened_at: new Date().toISOString() }))).toBe('inbox')
  })

  it('has clicked_at (no open) → inbox', () => {
    expect(inferPlacementFromSignals(sentEvent({ clicked_at: new Date().toISOString() }))).toBe('inbox')
  })

  it('73h old, status sent, no engagement → likely_spam', () => {
    expect(inferPlacementFromSignals(oldSentEvent())).toBe('likely_spam')
  })

  it('24h old, status sent, no engagement → unknown (too early)', () => {
    const e = sentEvent({ sent_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() })
    expect(inferPlacementFromSignals(e)).toBe('unknown')
  })

  it('complaint wins over opened_at (complaint checked first)', () => {
    const e = sentEvent({ bounce_type: 'complaint', opened_at: new Date().toISOString() })
    expect(inferPlacementFromSignals(e)).toBe('spam')
  })

  it('bounced wins over clicked_at', () => {
    const e = sentEvent({ status: 'bounced', clicked_at: new Date().toISOString() })
    expect(inferPlacementFromSignals(e)).toBe('bounced')
  })

  it('invalid sent_at date string → skips age heuristic → unknown', () => {
    const e = sentEvent({ sent_at: 'not-a-date' })
    expect(inferPlacementFromSignals(e)).toBe('unknown')
  })

  it('sent_at null, status sent, no engagement → unknown (no date to age-check)', () => {
    const e = sentEvent({ sent_at: null })
    expect(inferPlacementFromSignals(e)).toBe('unknown')
  })

  it('exactly 72h old is NOT likely_spam (threshold is >72)', () => {
    // Subtract 100ms to absorb Date.now() drift between test setup and
    // function invocation — without this, ageH ends up slightly > 72
    // by the time the heuristic compares (microsecond-level race).
    const e = sentEvent({ sent_at: new Date(Date.now() - 72 * 60 * 60 * 1000 + 100).toISOString() })
    // ageH ~= 71.99997h → strictly < 72 → unknown
    expect(inferPlacementFromSignals(e)).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// aggregatePlacementStats — unit tests
// ---------------------------------------------------------------------------
describe('aggregatePlacementStats', () => {
  it('empty array → total 0, inbox_rate null', () => {
    const stats = aggregatePlacementStats([])
    expect(stats.total).toBe(0)
    expect(stats.inbox_rate).toBeNull()
  })

  it('null input → total 0, inbox_rate null', () => {
    const stats = aggregatePlacementStats(null)
    expect(stats.total).toBe(0)
    expect(stats.inbox_rate).toBeNull()
  })

  it('5 inbox events → inbox_rate = 1.0', () => {
    const events = Array.from({ length: 5 }, () =>
      sentEvent({ opened_at: new Date().toISOString() })
    )
    const stats = aggregatePlacementStats(events)
    expect(stats.inbox).toBe(5)
    expect(stats.inbox_rate).toBe(1)
  })

  it('2 inbox + 2 spam → inbox_rate = 0.5', () => {
    const events = [
      sentEvent({ opened_at: new Date().toISOString() }),
      sentEvent({ opened_at: new Date().toISOString() }),
      sentEvent({ bounce_type: 'complaint' }),
      sentEvent({ bounce_type: 'complaint' }),
    ]
    const stats = aggregatePlacementStats(events)
    expect(stats.inbox).toBe(2)
    expect(stats.spam).toBe(2)
    expect(stats.inbox_rate).toBe(0.5)
  })

  it('all unknown → inbox_rate = 0', () => {
    const events = Array.from({ length: 3 }, () => sentEvent())
    const stats = aggregatePlacementStats(events)
    expect(stats.inbox).toBe(0)
    expect(stats.inbox_rate).toBe(0)
  })

  it('mixed: inbox + spam + likely_spam + bounced + unknown counts sum to total', () => {
    const events = [
      sentEvent({ opened_at: new Date().toISOString() }),            // inbox
      sentEvent({ bounce_type: 'complaint' }),                        // spam
      oldSentEvent(),                                                 // likely_spam
      sentEvent({ status: 'bounced' }),                               // bounced
      sentEvent(),                                                    // unknown
    ]
    const stats = aggregatePlacementStats(events)
    expect(stats.total).toBe(5)
    const sum = stats.inbox + stats.spam + stats.likely_spam + stats.bounced + stats.unknown
    expect(sum).toBe(5)
  })

  it('MONKEY: random sendEvent shapes never crash, always return valid counts', () => {
    const monkeyShapes = [
      {},
      { status: null },
      { bounce_type: 123 },
      { opened_at: 'garbage', sent_at: 'garbage' },
      { clicked_at: undefined },
      { status: 'sent', sent_at: 'not-a-date', bounce_type: null },
      { status: 'bounced', opened_at: new Date().toISOString() },
      { status: 'sent', sent_at: new Date(0).toISOString() }, // epoch → very old
      { status: 'sent', sent_at: new Date(9999, 0).toISOString() }, // future
      { extra_field: 'ignored', status: 'sent' },
    ]
    const stats = aggregatePlacementStats(monkeyShapes)
    expect(stats.total).toBe(monkeyShapes.length)
    const sum = stats.inbox + stats.spam + stats.likely_spam + stats.bounced + stats.unknown
    expect(sum).toBe(monkeyShapes.length)
    expect(typeof stats.inbox_rate).toBe('number')
    expect(stats.inbox_rate).toBeGreaterThanOrEqual(0)
    expect(stats.inbox_rate).toBeLessThanOrEqual(1)
  })
})
