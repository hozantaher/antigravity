// AR10 + AR14 — Human behaviour simulation unit tests.
//
// Tests are structured into three sections:
//   A: AR10 generateDraftBody / pickGenericReply
//   B: AR10 sampleMessageAction probability distribution
//   C: AR14 isInIdleWindow, missingFolders, imapSinceDate
//
// ≥15 test cases per feedback_extreme_testing.

import { describe, it, expect } from 'vitest'
import {
  GENERIC_REPLY_POOL,
  pickGenericReply,
  generateDraftBody,
  sampleMessageAction,
  shouldProcessMailbox,
  isInIdleWindow,
  REQUIRED_FOLDERS,
  missingFolders,
  imapSinceDate,
} from '../../src/lib/humanBehaviorSimulation.js'

// ── Section A: AR10 — generateDraftBody + pickGenericReply ────────────────────

describe('AR10: GENERIC_REPLY_POOL integrity', () => {
  it('T-1: pool has ≥ 20 entries', () => {
    expect(GENERIC_REPLY_POOL.length).toBeGreaterThanOrEqual(20)
  })

  it('T-2: every entry is a non-empty string', () => {
    for (const entry of GENERIC_REPLY_POOL) {
      expect(typeof entry).toBe('string')
      expect(entry.trim().length).toBeGreaterThan(0)
    }
  })

  it('T-3: no entry contains {{.template}} variables', () => {
    for (const entry of GENERIC_REPLY_POOL) {
      expect(entry).not.toMatch(/\{\{/)
    }
  })

  it('T-4: pickGenericReply returns an entry from the pool', () => {
    for (let i = 0; i < 30; i++) {
      const result = pickGenericReply()
      expect(GENERIC_REPLY_POOL).toContain(result)
    }
  })

  it('T-5: pickGenericReply produces distinct outputs across many calls', () => {
    const seen = new Set()
    for (let i = 0; i < 200; i++) {
      seen.add(pickGenericReply())
    }
    // With 20+ entries and 200 samples we should see at least 15 distinct ones
    expect(seen.size).toBeGreaterThanOrEqual(15)
  })

  it('T-6: pickGenericReply never returns empty string', () => {
    for (let i = 0; i < 50; i++) {
      const r = pickGenericReply()
      expect(r.length).toBeGreaterThan(0)
    }
  })
})

describe('AR10: generateDraftBody', () => {
  it('T-7: returns a non-empty string', () => {
    const body = generateDraftBody()
    expect(typeof body).toBe('string')
    expect(body.trim().length).toBeGreaterThan(0)
  })

  it('T-8: output length is between 20 and 120 chars', () => {
    for (let i = 0; i < 30; i++) {
      const body = generateDraftBody()
      expect(body.length).toBeGreaterThanOrEqual(20)
      expect(body.length).toBeLessThanOrEqual(120)
    }
  })

  it('T-9: produces varying output across multiple calls', () => {
    const seen = new Set()
    for (let i = 0; i < 50; i++) {
      seen.add(generateDraftBody())
    }
    expect(seen.size).toBeGreaterThanOrEqual(3)
  })

  it('T-10: deterministic with seeded rng', () => {
    let seed = 42
    const seededRng = () => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff
      return (seed >>> 0) / 0x100000000
    }
    seed = 42; const a = generateDraftBody(seededRng)
    seed = 42; const b = generateDraftBody(seededRng)
    expect(a).toBe(b)
  })
})

// ── Section B: AR10 — sampleMessageAction probability distribution ────────────

describe('AR10: sampleMessageAction probability distribution', () => {
  it('T-11: all 5 actions are possible', () => {
    const seen = new Set()
    for (let i = 0; i < 1000; i++) {
      seen.add(sampleMessageAction(i / 1000))
    }
    expect(seen.has('mark_read')).toBe(true)
    expect(seen.has('reply')).toBe(true)
    expect(seen.has('archive')).toBe(true)
    expect(seen.has('draft')).toBe(true)
    expect(seen.has('noop')).toBe(true)
  })

  it('T-12: mark_read is ~60% of samples (±5%)', () => {
    const N = 10000
    let count = 0
    for (let i = 0; i < N; i++) {
      if (sampleMessageAction(i / N) === 'mark_read') count++
    }
    const ratio = count / N
    expect(ratio).toBeGreaterThanOrEqual(0.55)
    expect(ratio).toBeLessThanOrEqual(0.65)
  })

  it('T-13: reply is ~10% of samples (±5%)', () => {
    const N = 10000
    let count = 0
    for (let i = 0; i < N; i++) {
      if (sampleMessageAction(i / N) === 'reply') count++
    }
    const ratio = count / N
    expect(ratio).toBeGreaterThanOrEqual(0.05)
    expect(ratio).toBeLessThanOrEqual(0.15)
  })

  it('T-14: archive is ~20% of samples (±5%)', () => {
    const N = 10000
    let count = 0
    for (let i = 0; i < N; i++) {
      if (sampleMessageAction(i / N) === 'archive') count++
    }
    const ratio = count / N
    expect(ratio).toBeGreaterThanOrEqual(0.15)
    expect(ratio).toBeLessThanOrEqual(0.25)
  })

  it('T-15: shouldProcessMailbox selects ~30% of mailboxes', () => {
    const N = 10000
    let count = 0
    for (let i = 0; i < N; i++) {
      if (shouldProcessMailbox(i / N)) count++
    }
    const ratio = count / N
    expect(ratio).toBeGreaterThanOrEqual(0.25)
    expect(ratio).toBeLessThanOrEqual(0.35)
  })
})

// ── Section C: AR14 — isInIdleWindow, missingFolders, imapSinceDate ───────────

describe('AR14: isInIdleWindow', () => {
  // isInIdleWindow applies a UTC+1 shift before checking local-time window.
  // offset=0 → local block [22, 24) → UTC block [21, 23)
  it('T-16: mailbox is in IDLE window for offset=0 (UTC 21:00-22:59 maps to local 22:00-23:59)', () => {
    expect(isInIdleWindow(20, 0)).toBe(false)   // UTC 20 → local 21 → outside block
    expect(isInIdleWindow(21, 0)).toBe(true)    // UTC 21 → local 22 → in [22,24)
    expect(isInIdleWindow(22, 0)).toBe(true)    // UTC 22 → local 23 → in [22,24)
    expect(isInIdleWindow(23, 0)).toBe(false)   // UTC 23 → local 0  → outside [22,24)
    expect(isInIdleWindow(0, 0)).toBe(false)    // UTC 0  → local 1  → outside
  })

  it('T-17: mailbox offset=0.5 → localBlock=[1,3) → UTC [0,2)', () => {
    // offset=0.5 → blockStart=(22+floor(0.5*6))%24=(22+3)%24=1, blockEnd=3
    // UTC+1 shift: utcHour=0 → local=1 ∈ [1,3) → true
    expect(isInIdleWindow(0, 0.5)).toBe(true)   // local 1 → in [1,3)
    expect(isInIdleWindow(1, 0.5)).toBe(true)   // local 2 → in [1,3)
    expect(isInIdleWindow(2, 0.5)).toBe(false)  // local 3 → outside
    expect(isInIdleWindow(23, 0.5)).toBe(false) // local 0 → outside
  })

  it('T-18: mid-afternoon UTC hours (9:00-17:00) are never in IDLE window for any offset', () => {
    for (const offset of [0, 0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const hour of [9, 11, 13, 15, 17]) {
        expect(isInIdleWindow(hour, offset)).toBe(false)
      }
    }
  })
})

describe('AR14: missingFolders', () => {
  it('T-19: returns empty array when all required folders exist', () => {
    const existing = [...REQUIRED_FOLDERS]
    expect(missingFolders(existing)).toEqual([])
  })

  it('T-20: detects missing folders case-insensitively', () => {
    const existing = ['INBOX', 'drafts', 'SENT', 'trash']
    const missing = missingFolders(existing)
    expect(missing).toContain('Archive')
    expect(missing).toContain('Spam')
    expect(missing).not.toContain('Drafts')
    expect(missing).not.toContain('Sent')
    expect(missing).not.toContain('Trash')
  })

  it('T-21: returns all required folders when none exist', () => {
    const missing = missingFolders(['INBOX'])
    for (const f of REQUIRED_FOLDERS) {
      expect(missing).toContain(f)
    }
  })

  it('T-22: idempotent — calling twice with same input gives same result', () => {
    const existing = ['Inbox', 'Drafts']
    const a = missingFolders(existing)
    const b = missingFolders(existing)
    expect(a).toEqual(b)
  })
})

describe('AR14: imapSinceDate', () => {
  it('T-23: returns a string in DD-Mon-YYYY format', () => {
    const result = imapSinceDate(new Date('2026-05-08T12:00:00Z'), 7)
    expect(result).toMatch(/^\d{2}-[A-Z][a-z]{2}-\d{4}$/)
  })

  it('T-24: 7 days before 2026-05-08 is 01-May-2026', () => {
    const result = imapSinceDate(new Date('2026-05-08T00:00:00Z'), 7)
    expect(result).toBe('01-May-2026')
  })

  it('T-25: handles month boundary correctly (May 3 - 7d = Apr 26)', () => {
    const result = imapSinceDate(new Date('2026-05-03T00:00:00Z'), 7)
    expect(result).toBe('26-Apr-2026')
  })
})
