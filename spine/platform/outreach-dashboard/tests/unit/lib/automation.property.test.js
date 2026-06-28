/**
 * Property-based tests for automation.js pure helpers.
 *
 * Instead of a library we use deterministic generators to enumerate
 * representative input spaces and assert invariants that must hold
 * for ALL valid inputs — not just hand-picked examples.
 */
import { describe, it, expect } from 'vitest'
import {
  calcNewDailyCap,
  shouldThrottle,
  classifyReply,
  shouldAutoPause,
  classifySmtpError,
  processImapReplies,
  isWithinSendWindow,
  shouldSuppress,
} from '../../../src/lib/automation'

// ── Generators ────────────────────────────────────────────────────
const range = (n) => Array.from({ length: n }, (_, i) => i)
const ALL_CLASSIFICATIONS = ['ok', 'warn', 'critical', 'insufficient', 'unknown', '', null]
const ALL_SMTP_ERRORS = [
  '535 incorrect credentials', 'Authentication failed',
  '421 banned', 'not welcome here',
  'tcp timeout', 'ETIMEDOUT',
  'ECONNREFUSED', 'Connection refused', 'SOCKS failed',
  'some unknown thing', '', 'null',
]
const ALL_REPLY_CLASSIFICATIONS = ['positive', 'negative', 'auto_reply', 'neutral', 'unknown', null, undefined]

// ── Property: calcNewDailyCap floor ──────────────────────────────
describe('[property] calcNewDailyCap — result is always null OR >= 10', () => {
  const caps = [0, 1, 5, 10, 11, 12, 15, 20, 50, 80, 100, 200, 500, 1000]

  for (const cap of caps) {
    for (const cls of ALL_CLASSIFICATIONS) {
      it(`calcNewDailyCap(${cap}, ${JSON.stringify(cls)}) — result null or >= 10`, () => {
        const result = calcNewDailyCap(cap, cls)
        if (result !== null) {
          expect(result).toBeGreaterThanOrEqual(10)
          expect(typeof result).toBe('number')
          expect(Number.isFinite(result)).toBe(true)
        }
      })
    }
  }

  it('warn classification always reduces or equals current cap', () => {
    const caps2 = [10, 20, 50, 100, 200]
    for (const cap of caps2) {
      const result = calcNewDailyCap(cap, 'warn')
      expect(result).toBeLessThanOrEqual(cap)
      expect(result).toBeGreaterThanOrEqual(10)
    }
  })

  it('critical always reduces more than warn for cap > 10', () => {
    const testCap = 100
    const warnResult = calcNewDailyCap(testCap, 'warn')    // 80
    const critResult = calcNewDailyCap(testCap, 'critical') // 50
    expect(critResult).toBeLessThanOrEqual(warnResult)
  })
})

// ── Property: shouldThrottle monotonicity ────────────────────────
describe('[property] shouldThrottle — severity never decreases as sentToday increases', () => {
  const SEVERITY = { ok: 0, warn: 1, block: 2 }
  const limits = [10, 50, 100, 200, 500]

  for (const limit of limits) {
    it(`limit=${limit}: severity is non-decreasing as sentToday increases`, () => {
      const steps = range(limit + 5)
      let prevSeverity = -1
      for (const sent of steps) {
        const level = shouldThrottle(sent, limit)
        const severity = SEVERITY[level]
        expect(severity).toBeGreaterThanOrEqual(prevSeverity)
        prevSeverity = severity
      }
    })
  }

  it('sentToday=0 is always "ok" regardless of limit', () => {
    for (const limit of [1, 10, 100, 1000]) {
      expect(shouldThrottle(0, limit)).toBe('ok')
    }
  })

  it('sentToday >= limit is always "block"', () => {
    const pairs = [[100, 100], [101, 100], [200, 100], [50, 50], [1, 1]]
    for (const [sent, limit] of pairs) {
      expect(shouldThrottle(sent, limit)).toBe('block')
    }
  })
})

// ── Property: classifyReply totality ─────────────────────────────
describe('[property] classifyReply — always returns a valid classification, never throws', () => {
  const VALID = new Set(['positive', 'negative', 'auto_reply', 'neutral'])

  const subjects = [
    '', 'RE: test', 'Out of Office', 'Dovolená', 'Zájem o spolupráci',
    'nechci', 'Auto-Reply', 'Meeting', 'STOP', null, undefined,
    'a'.repeat(1000),
    '🎉 Odpověď', '<script>alert(1)</script>',
  ]
  const bodies = [
    '', 'nechci dostávat nabídky', 'unsubscribe', 'zájem',
    'Díky za email', 'schůzka', null, undefined,
    'x'.repeat(5000),
  ]

  for (const subject of subjects.slice(0, 8)) {
    for (const body of bodies.slice(0, 5)) {
      it(`classifyReply(${JSON.stringify(subject)}, ${JSON.stringify(body)}) ∈ VALID_CLASSIFICATIONS`, () => {
        const result = classifyReply(subject ?? '', body ?? '')
        expect(VALID.has(result)).toBe(true)
      })
    }
  }

  it('does not throw for any string combination', () => {
    const edgeCases = [
      ['', ''], [null, null], [undefined, undefined],
      ['a'.repeat(10000), 'b'.repeat(10000)],
      ['<html>', '<body>'],
    ]
    for (const [s, b] of edgeCases) {
      expect(() => classifyReply(s ?? '', b ?? '')).not.toThrow()
    }
  })

  it('auto_reply always takes priority over negative', () => {
    const autoReplySubjects = ['Out of Office', 'Dovolená', 'vacation', 'nepřítomen']
    const negativeBodies = ['nechci', 'unsubscribe', 'opt-out', 'remove me']
    for (const subject of autoReplySubjects) {
      for (const body of negativeBodies) {
        expect(classifyReply(subject, body)).toBe('auto_reply')
      }
    }
  })

  it('negative always takes priority over positive', () => {
    expect(classifyReply('zájem', 'nechci, ale zájem mám')).toBe('negative')
    expect(classifyReply('schůzka', 'stop, žádné schůzky')).toBe('negative')
  })
})

// ── Property: shouldAutoPause boundary correctness ───────────────
describe('[property] shouldAutoPause — exact threshold boundary', () => {
  const thresholds = [2, 3, 4, 5]

  for (const t of thresholds) {
    it(`threshold=${t}: exactly ${t - 1} failures → pause:false`, () => {
      const history = range(t - 1).map(() => ({ smtp_ok: false }))
      expect(shouldAutoPause(history, t).pause).toBe(false)
    })

    it(`threshold=${t}: exactly ${t} failures → pause:true`, () => {
      const history = range(t).map(() => ({ smtp_ok: false }))
      expect(shouldAutoPause(history, t).pause).toBe(true)
    })

    it(`threshold=${t}: ${t} failures but last=true → pause:false`, () => {
      const history = range(t).map((_, i) => ({ smtp_ok: i === t - 1 ? true : false }))
      expect(shouldAutoPause(history, t).pause).toBe(false)
    })
  }

  it('null smtp_ok is never treated as failure', () => {
    const history = [{ smtp_ok: null }, { smtp_ok: null }, { smtp_ok: null }]
    expect(shouldAutoPause(history, 3).pause).toBe(false)
  })
})

// ── Property: classifySmtpError is total ─────────────────────────
describe('[property] classifySmtpError — always returns a valid category', () => {
  const VALID_SMTP = new Set(['auth_invalid', 'geo_block', 'timeout', 'proxy_dead', 'unknown'])

  for (const msg of ALL_SMTP_ERRORS) {
    it(`classifySmtpError(${JSON.stringify(msg)}) ∈ VALID_SMTP_CATEGORIES`, () => {
      const result = classifySmtpError(msg)
      expect(VALID_SMTP.has(result)).toBe(true)
    })
  }

  it('does not throw for any string', () => {
    const edgeCases = ['', null, undefined, 'x'.repeat(1000), '🔥', '\n\t\r']
    for (const msg of edgeCases) {
      expect(() => classifySmtpError(msg ?? '')).not.toThrow()
    }
  })
})

// ── Property: shouldSuppress is total ────────────────────────────
describe('[property] shouldSuppress — "negative" or "unsubscribe" returns true', () => {
  const suppresses = (cls) => cls === 'negative' || cls === 'unsubscribe'
  for (const cls of ALL_REPLY_CLASSIFICATIONS) {
    it(`shouldSuppress(${JSON.stringify(cls)}) → ${suppresses(cls)}`, () => {
      const result = shouldSuppress(cls)
      expect(result).toBe(suppresses(cls))
    })
  }
})

// ── Property: processImapReplies length invariant ────────────────
describe('[property] processImapReplies — result.length <= messages.length', () => {
  const events = [
    { id: 1, contactId: 10, contactEmail: 'a@firma.cz' },
    { id: 2, contactId: 20, contactEmail: 'b@firma.cz' },
  ]

  it('can never produce more results than input messages', () => {
    const messageSets = [
      [],
      [{ fromAddr: 'a@firma.cz', subject: 'Hi', snippet: '' }],
      [{ fromAddr: 'a@firma.cz', subject: 'Hi', snippet: '' }, { fromAddr: 'b@firma.cz', subject: 'Hi', snippet: '' }],
      [{ fromAddr: 'unknown@x.com', subject: 'Hi', snippet: '' }],
      [{ fromAddr: 'a@firma.cz', subject: 'Hi', snippet: '' }, { fromAddr: 'unknown@x.com', subject: 'Hi', snippet: '' }],
    ]
    for (const msgs of messageSets) {
      const result = processImapReplies(msgs, events)
      expect(result.length).toBeLessThanOrEqual(msgs.length)
    }
  })

  it('each result always has sendEventId, contactId, classification, subject, fromAddr', () => {
    const msgs = [{ fromAddr: 'a@firma.cz', subject: 'Test', snippet: '' }]
    const result = processImapReplies(msgs, events)
    for (const r of result) {
      expect(r).toHaveProperty('sendEventId')
      expect(r).toHaveProperty('contactId')
      expect(r).toHaveProperty('classification')
      expect(r).toHaveProperty('subject')
      expect(r).toHaveProperty('fromAddr')
    }
  })
})
