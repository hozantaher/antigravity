// #27 — IMAP delta-detection unit tests for computeImapNewUids.
// The full cron wrapper in server.js (runImapPollCron) is an I/O
// orchestration shell; the actual delta logic lives in this pure function.

import { describe, it, expect } from 'vitest'
import { computeImapNewUids } from '../../../src/lib/automation.js'

describe('computeImapNewUids — first poll', () => {
  it('null watermark + non-empty uids → process all', () => {
    const r = computeImapNewUids({ uids: [10, 12, 15], uidValidity: 1, prevUid: null, prevUidValidity: null })
    expect(r.newUids).toEqual([10, 12, 15])
    expect(r.nextWatermark).toBe(15)
    expect(r.validityChanged).toBe(false)
  })

  it('null watermark + empty uids → no work, watermark stays null', () => {
    const r = computeImapNewUids({ uids: [], uidValidity: 1, prevUid: null, prevUidValidity: null })
    expect(r.newUids).toEqual([])
    expect(r.nextWatermark).toBe(null)
    expect(r.validityChanged).toBe(false)
  })
})

describe('computeImapNewUids — steady state', () => {
  it('processes only UIDs > watermark', () => {
    const r = computeImapNewUids({ uids: [10, 12, 15, 18], uidValidity: 1, prevUid: 12, prevUidValidity: 1 })
    expect(r.newUids).toEqual([15, 18])
    expect(r.nextWatermark).toBe(18)
  })

  it('no new UIDs above watermark → empty result, watermark holds', () => {
    const r = computeImapNewUids({ uids: [5, 8, 10], uidValidity: 1, prevUid: 10, prevUidValidity: 1 })
    expect(r.newUids).toEqual([])
    expect(r.nextWatermark).toBe(10)
  })

  it('out-of-order intermediate poll does NOT regress watermark', () => {
    // Some pollers report unseen UIDs in non-monotonic order; the
    // watermark must use Max(existing, latest_max) so it never moves
    // backward — otherwise repeats of already-processed UIDs.
    const r = computeImapNewUids({ uids: [5, 7], uidValidity: 1, prevUid: 100, prevUidValidity: 1 })
    expect(r.newUids).toEqual([])
    expect(r.nextWatermark).toBe(100) // not moved backward to 7
  })
})

describe('computeImapNewUids — UIDVALIDITY change (mailbox recreated)', () => {
  it('validity changed → process all + reset watermark to max(uids)', () => {
    const r = computeImapNewUids({ uids: [3, 5, 8], uidValidity: 999, prevUid: 100, prevUidValidity: 1 })
    expect(r.validityChanged).toBe(true)
    // Even though prev_uid was 100, validity reset means UIDs are in a
    // new namespace — process all unseen, set watermark to new max.
    expect(r.newUids).toEqual([3, 5, 8])
    expect(r.nextWatermark).toBe(8)
  })

  it('validity changed + empty uids → reset watermark to null', () => {
    const r = computeImapNewUids({ uids: [], uidValidity: 999, prevUid: 100, prevUidValidity: 1 })
    expect(r.validityChanged).toBe(true)
    expect(r.newUids).toEqual([])
    expect(r.nextWatermark).toBe(null)
  })

  it('first time uidValidity captured (prev null) → not flagged as change', () => {
    const r = computeImapNewUids({ uids: [5], uidValidity: 1, prevUid: null, prevUidValidity: null })
    expect(r.validityChanged).toBe(false)
  })
})

describe('computeImapNewUids — mark-read race resilience (the bug)', () => {
  it('prev_unseen=5, current_unseen=4 (one marked read externally), 1 new reply → still detected', () => {
    // Old logic: count delta = 4 - 5 = -1, NOT processed.
    // New logic: UID 25 > watermark 20 → processed correctly.
    const r = computeImapNewUids({
      uids: [21, 22, 23, 25],   // current unseen — UID 24 was marked read externally
      uidValidity: 1,
      prevUid: 20,                // last processed in prior poll
      prevUidValidity: 1,
    })
    expect(r.newUids).toEqual([21, 22, 23, 25])
    expect(r.nextWatermark).toBe(25)
  })

  it('prev_unseen drops to 0 (all marked read) but new reply arrives → still caught', () => {
    // Even more extreme: all old unseen → read, single new arrives.
    const r = computeImapNewUids({
      uids: [99],          // only the new one
      uidValidity: 1,
      prevUid: 50,
      prevUidValidity: 1,
    })
    expect(r.newUids).toEqual([99])
    expect(r.nextWatermark).toBe(99)
  })
})

describe('computeImapNewUids — defensive defaults', () => {
  it('handles empty input gracefully', () => {
    const r = computeImapNewUids({})
    expect(r.newUids).toEqual([])
    expect(r.nextWatermark).toBe(null)
    expect(r.validityChanged).toBe(false)
  })

  it('handles undefined uidValidity (older clients without UIDVALIDITY support)', () => {
    const r = computeImapNewUids({ uids: [10], uidValidity: null, prevUid: 5, prevUidValidity: null })
    expect(r.newUids).toEqual([10])
    expect(r.validityChanged).toBe(false)
  })
})

// BF-E5 — explicit verification that uidValidity reset does NOT replay
// already-processed messages. The reset is a "new universe" of UIDs:
// nextWatermark must reset to max(uids) of the NEW namespace, not 0,
// otherwise the next poll would see all UIDs in the new namespace
// as "above 0" and re-process anything.
describe('computeImapNewUids — uidValidity reset path (BF-E5)', () => {
  it('reset watermark equals max(uids), not 0', () => {
    const r = computeImapNewUids({
      uids: [1, 2, 3, 4, 5],
      uidValidity: 200,
      prevUid: 999,
      prevUidValidity: 100,
    })
    expect(r.validityChanged).toBe(true)
    expect(r.nextWatermark).toBe(5)
    // The next poll, with prevUid=5 + same prevUidValidity=200, picks up only
    // strictly higher UIDs.
    const next = computeImapNewUids({
      uids: [1, 2, 3, 4, 5, 6, 7],
      uidValidity: 200,
      prevUid: 5,
      prevUidValidity: 200,
    })
    expect(next.newUids).toEqual([6, 7])
  })

  it('two consecutive resets do not interact', () => {
    const r1 = computeImapNewUids({
      uids: [10, 20, 30],
      uidValidity: 200,
      prevUid: 999,
      prevUidValidity: 100,
    })
    expect(r1.validityChanged).toBe(true)
    expect(r1.nextWatermark).toBe(30)
    const r2 = computeImapNewUids({
      uids: [5, 8],
      uidValidity: 300,        // changed again
      prevUid: 30,
      prevUidValidity: 200,
    })
    expect(r2.validityChanged).toBe(true)
    expect(r2.newUids).toEqual([5, 8])
    expect(r2.nextWatermark).toBe(8)
  })

  it('uidValidity coming back to original value is treated as a change', () => {
    // Pathological: server reports UIDVALIDITY 100 → 200 → 100. Spec says
    // any change is a reset. We must not assume the namespace is "the same"
    // just because the integer matches an earlier one.
    const r = computeImapNewUids({
      uids: [1, 2],
      uidValidity: 100,
      prevUid: 5,
      prevUidValidity: 200,
    })
    expect(r.validityChanged).toBe(true)
    expect(r.newUids).toEqual([1, 2])
  })

  it('first time receiving uidValidity (prev was null) is NOT a reset', () => {
    // Boot from a checkpointed prevUid where the prior persistence layer
    // didn't yet record UIDVALIDITY. Treat as steady state, honor the
    // existing watermark.
    const r = computeImapNewUids({
      uids: [1, 2, 3, 100, 200],
      uidValidity: 42,
      prevUid: 50,
      prevUidValidity: null,
    })
    expect(r.validityChanged).toBe(false)
    expect(r.newUids).toEqual([100, 200])
    expect(r.nextWatermark).toBe(200)
  })

  it('reset preserves correctness when the new namespace happens to overlap', () => {
    // Old namespace processed up to UID 999. New namespace starts at 1 and
    // includes 1, 2, ..., 1000. After reset we treat them ALL as new (because
    // they live in a fresh space) — even though the integer 1000 > 999.
    const r = computeImapNewUids({
      uids: [1, 500, 1000],
      uidValidity: 7,
      prevUid: 999,
      prevUidValidity: 6,
    })
    expect(r.validityChanged).toBe(true)
    expect(r.newUids).toEqual([1, 500, 1000]) // all of them, not just > 999
    expect(r.nextWatermark).toBe(1000)
  })
})
