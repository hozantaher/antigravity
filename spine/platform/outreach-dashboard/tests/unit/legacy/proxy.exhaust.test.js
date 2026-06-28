import { describe, test, expect } from 'vitest'
import { aggregateProxyExhaust, PROXY_EXHAUST_CONSTANTS } from '../../../proxyExhaustAlert.js'

const NOW = new Date('2026-04-21T12:00:00Z')

function evt(mailboxId, minutesAgo) {
  return {
    mailbox_id: mailboxId,
    created_at: new Date(NOW.getTime() - minutesAgo * 60 * 1000),
    message: `no proxy passed AUTH`,
    reason: 'smtp_send_fail',
  }
}

describe('aggregateProxyExhaust', () => {
  test('empty input → ok severity, count 0', () => {
    const out = aggregateProxyExhaust([], NOW)
    expect(out.count).toBe(0)
    expect(out.triggered).toBe(false)
    expect(out.severity).toBe('ok')
    expect(out.since).toBeNull()
    expect(out.mailboxes_affected).toEqual([])
  })

  test('single event in window → warn, not triggered', () => {
    const out = aggregateProxyExhaust([evt(10, 2)], NOW)
    expect(out.count).toBe(1)
    expect(out.triggered).toBe(false)
    expect(out.severity).toBe('warn')
    expect(out.mailboxes_affected).toEqual([10])
  })

  test('two events in window → triggered, error severity', () => {
    const out = aggregateProxyExhaust([evt(10, 1), evt(11, 3)], NOW)
    expect(out.count).toBe(2)
    expect(out.triggered).toBe(true)
    expect(out.severity).toBe('error')
    expect(out.mailboxes_affected).toEqual([10, 11])
  })

  test('events outside window are excluded', () => {
    const out = aggregateProxyExhaust([evt(10, 1), evt(11, 15)], NOW)
    expect(out.count).toBe(1)
    expect(out.triggered).toBe(false)
    expect(out.mailboxes_affected).toEqual([10])
  })

  test('window boundary — exactly 10min old is included', () => {
    const out = aggregateProxyExhaust([evt(10, 10)], NOW)
    expect(out.count).toBe(1)
  })

  test('dedupes mailbox_affected, sorts ascending', () => {
    const out = aggregateProxyExhaust([evt(11, 1), evt(10, 2), evt(11, 3)], NOW)
    expect(out.mailboxes_affected).toEqual([10, 11])
  })

  test('ignores null mailbox_id', () => {
    const out = aggregateProxyExhaust([evt(null, 1), evt(10, 2)], NOW)
    expect(out.mailboxes_affected).toEqual([10])
  })

  test('since = earliest in-window event', () => {
    const out = aggregateProxyExhaust([evt(10, 1), evt(11, 5), evt(12, 3)], NOW)
    expect(out.since).toBe(new Date(NOW.getTime() - 5 * 60 * 1000).toISOString())
  })

  test('accepts ISO string created_at', () => {
    const rows = [{ mailbox_id: 1, created_at: new Date(NOW.getTime() - 60_000).toISOString() }]
    const out = aggregateProxyExhaust(rows, NOW)
    expect(out.count).toBe(1)
  })

  test('custom window — 1min cutoff excludes 2min-old event', () => {
    const out = aggregateProxyExhaust([evt(10, 2)], NOW, 60_000)
    expect(out.count).toBe(0)
  })

  test('exposes constants', () => {
    expect(PROXY_EXHAUST_CONSTANTS.DEFAULT_WINDOW_MS).toBe(10 * 60 * 1000)
    expect(PROXY_EXHAUST_CONSTANTS.TRIGGER_THRESHOLD).toBe(2)
  })

  test('null rows is treated as empty', () => {
    expect(aggregateProxyExhaust(null, NOW).count).toBe(0)
    expect(aggregateProxyExhaust(undefined, NOW).count).toBe(0)
  })
})
