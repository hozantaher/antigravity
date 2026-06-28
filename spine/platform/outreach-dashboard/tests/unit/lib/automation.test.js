/**
 * Unit tests for automation.js pure helpers.
 * TDD: testy jsou zdroj pravdy — implementace jim musí vyhovět.
 * Spustit: pnpm test (vitest run)
 */
import { describe, it, expect } from 'vitest'
import {
  shouldAutoPause,
  shouldAutoResume,
  classifyReply,
  shouldThrottle,
  shouldPauseWarmup,
  classifySmtpError,
  isFailoverWorthy,
  nextProxyCandidate,
  calcNewDailyCap,
  shouldAdvanceWarmup,
  formatDailyReport,
  processImapReplies,
  shouldSuppress,
  isWithinSendWindow,
  shouldResumeBounceEscalation,
  imapCircuitDecision,
  shouldBreakAuthCircuit,
  isScoreDrop,
  shouldProactivelyRotateProxy,
  classifySmtpSteps,
} from '../../../src/lib/automation'

// ── shouldAutoPause() ─────────────────────────────────────────────
describe('shouldAutoPause(recentHistory, threshold)', () => {
  it('fewer than 3 records → {pause: false}', () => {
    const r = shouldAutoPause([{ smtp_ok: false }, { smtp_ok: false }])
    expect(r.pause).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('exactly 3, all smtp_ok=false → {pause: true, reason contains "auto:"}', () => {
    const r = shouldAutoPause([
      { smtp_ok: false },
      { smtp_ok: false },
      { smtp_ok: false },
    ])
    expect(r.pause).toBe(true)
    expect(r.reason).toMatch(/^auto:/)
  })

  it('3 records, last one smtp_ok=true → {pause: false}', () => {
    const r = shouldAutoPause([
      { smtp_ok: false },
      { smtp_ok: false },
      { smtp_ok: true },
    ])
    expect(r.pause).toBe(false)
  })

  it('3 records, first two false, last true → {pause: false}', () => {
    const r = shouldAutoPause([
      { smtp_ok: false },
      { smtp_ok: false },
      { smtp_ok: true },
    ])
    expect(r.pause).toBe(false)
  })

  it('custom threshold=2, 2 failures → {pause: true}', () => {
    const r = shouldAutoPause([{ smtp_ok: false }, { smtp_ok: false }], 2)
    expect(r.pause).toBe(true)
    expect(r.reason).toMatch(/^auto:/)
  })

  it('null history → {pause: false}', () => {
    const r = shouldAutoPause(null)
    expect(r.pause).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('empty array → {pause: false}', () => {
    const r = shouldAutoPause([])
    expect(r.pause).toBe(false)
  })

  it('smtp_ok=null records → {pause: false} (null ≠ false)', () => {
    const r = shouldAutoPause([
      { smtp_ok: null },
      { smtp_ok: null },
      { smtp_ok: null },
    ])
    expect(r.pause).toBe(false)
  })

  it('5 records, last 3 all false → {pause: true}', () => {
    const r = shouldAutoPause([
      { smtp_ok: true },
      { smtp_ok: true },
      { smtp_ok: false },
      { smtp_ok: false },
      { smtp_ok: false },
    ])
    expect(r.pause).toBe(true)
    expect(r.reason).toMatch(/^auto:/)
  })
})

// ── shouldAutoResume() ────────────────────────────────────────────
describe('shouldAutoResume(mb, latestCheckResult)', () => {
  const okResult = { checks: { smtp: { ok: true } } }
  const failResult = { checks: { smtp: { ok: false } } }

  it('status="active" → false', () => {
    expect(shouldAutoResume({ status: 'active', status_reason: 'auto: smtp fail' }, okResult)).toBe(false)
  })

  it('status="paused", reason="manual: operator paused" → false (not auto:)', () => {
    expect(shouldAutoResume({ status: 'paused', status_reason: 'manual: operator paused' }, okResult)).toBe(false)
  })

  it('status="paused", reason="auto: smtp fail", smtp.ok=true → true', () => {
    expect(shouldAutoResume({ status: 'paused', status_reason: 'auto: smtp fail' }, okResult)).toBe(true)
  })

  it('status="paused", reason="auto: smtp fail", smtp.ok=false → false', () => {
    expect(shouldAutoResume({ status: 'paused', status_reason: 'auto: smtp fail' }, failResult)).toBe(false)
  })

  it('status="paused", reason=null → false', () => {
    expect(shouldAutoResume({ status: 'paused', status_reason: null }, okResult)).toBe(false)
  })

  it('null mb → false', () => {
    expect(shouldAutoResume(null, okResult)).toBe(false)
  })

  it('null latestCheckResult → false', () => {
    expect(shouldAutoResume({ status: 'paused', status_reason: 'auto: smtp fail' }, null)).toBe(false)
  })

  it('missing checks.smtp → false', () => {
    expect(shouldAutoResume(
      { status: 'paused', status_reason: 'auto: smtp fail' },
      { checks: {} },
    )).toBe(false)
  })
})

// ── classifyReply() ───────────────────────────────────────────────
describe('classifyReply(subject, body)', () => {
  it('"Out of Office", "" → "auto_reply"', () => {
    expect(classifyReply('Out of Office', '')).toBe('auto_reply')
  })

  it('"Dovolená", "" → "auto_reply" (case insensitive)', () => {
    expect(classifyReply('Dovolená', '')).toBe('auto_reply')
  })

  it('"RE: váš email", "nechci dostávat nabídky" → "negative"', () => {
    expect(classifyReply('RE: váš email', 'nechci dostávat nabídky')).toBe('negative')
  })

  it('"unsubscribe" in body → "negative"', () => {
    expect(classifyReply('', 'please unsubscribe me from your list')).toBe('negative')
  })

  it('"Zájem o spolupráci", "" → "positive"', () => {
    expect(classifyReply('Zájem o spolupráci', '')).toBe('positive')
  })

  it('"Rád bych se dozvěděl více" → "positive"', () => {
    expect(classifyReply('Rád bych se dozvěděl více', '')).toBe('positive')
  })

  it('"Re: Nabídka", "Díky za email" → "neutral"', () => {
    expect(classifyReply('Re: Nabídka', 'Díky za email')).toBe('neutral')
  })

  it('empty strings → "neutral"', () => {
    expect(classifyReply('', '')).toBe('neutral')
  })

  it('auto_reply takes priority over negative', () => {
    expect(classifyReply('Out of Office', 'nechci dostávat nabídky')).toBe('auto_reply')
  })

  it('negative takes priority over positive', () => {
    expect(classifyReply('', 'nechci, ale zájem mám')).toBe('negative')
  })
})

// ── shouldThrottle() ──────────────────────────────────────────────
describe('shouldThrottle(sentToday, limit)', () => {
  it('0/100 → "ok"', () => expect(shouldThrottle(0, 100)).toBe('ok'))
  it('79/100 → "ok"', () => expect(shouldThrottle(79, 100)).toBe('ok'))
  it('80/100 → "warn"', () => expect(shouldThrottle(80, 100)).toBe('warn'))
  it('99/100 → "warn"', () => expect(shouldThrottle(99, 100)).toBe('warn'))
  it('100/100 → "block"', () => expect(shouldThrottle(100, 100)).toBe('block'))
  it('150/100 → "block"', () => expect(shouldThrottle(150, 100)).toBe('block'))
  it('0/0 → "ok" (limit=0 edge case)', () => expect(shouldThrottle(0, 0)).toBe('ok'))
  it('string inputs coerced correctly: "80"/"100" → "warn"', () => {
    expect(shouldThrottle('80', '100')).toBe('warn')
  })
  it('0/500 → "ok"', () => expect(shouldThrottle(0, 500)).toBe('ok'))
  it('400/500 → "warn" (exactly 80%)', () => expect(shouldThrottle(400, 500)).toBe('warn'))
})

// ── shouldPauseWarmup() ───────────────────────────────────────────
describe('shouldPauseWarmup(bounceClassification, consecutiveBounces)', () => {
  it('("ok", 0) → false', () => expect(shouldPauseWarmup('ok', 0)).toBe(false))
  it('("ok", 4) → false', () => expect(shouldPauseWarmup('ok', 4)).toBe(false))
  it('("ok", 5) → true', () => expect(shouldPauseWarmup('ok', 5)).toBe(true))
  it('("warn", 0) → false', () => expect(shouldPauseWarmup('warn', 0)).toBe(false))
  it('("critical", 0) → true', () => expect(shouldPauseWarmup('critical', 0)).toBe(true))
  it('("critical", 5) → true', () => expect(shouldPauseWarmup('critical', 5)).toBe(true))
})

// ── classifySmtpError() ───────────────────────────────────────────
describe('classifySmtpError(errorMessage)', () => {
  it('"AUTH: 535 5.7.8 incorrect credentials" → "auth_invalid"', () => {
    expect(classifySmtpError('AUTH: 535 5.7.8 incorrect credentials')).toBe('auth_invalid')
  })

  it('"Authentication failed" → "auth_invalid"', () => {
    expect(classifySmtpError('Authentication failed')).toBe('auth_invalid')
  })

  it('"421 4.7.0 you are not welcome here" → "geo_block"', () => {
    expect(classifySmtpError('421 4.7.0 you are not welcome here')).toBe('geo_block')
  })

  it('"tcp timeout" → "timeout"', () => {
    expect(classifySmtpError('tcp timeout')).toBe('timeout')
  })

  it('"ETIMEDOUT" → "timeout"', () => {
    expect(classifySmtpError('ETIMEDOUT')).toBe('timeout')
  })

  it('"ECONNREFUSED" → "proxy_dead"', () => {
    expect(classifySmtpError('ECONNREFUSED')).toBe('proxy_dead')
  })

  it('"Connection refused" → "proxy_dead"', () => {
    expect(classifySmtpError('Connection refused')).toBe('proxy_dead')
  })

  it('"SOCKS connection failed" → "proxy_dead"', () => {
    expect(classifySmtpError('SOCKS connection failed')).toBe('proxy_dead')
  })

  it('"some random error" → "unknown"', () => {
    expect(classifySmtpError('some random error')).toBe('unknown')
  })

  it('empty string → "unknown"', () => {
    expect(classifySmtpError('')).toBe('unknown')
  })
})

// ── isFailoverWorthy() ────────────────────────────────────────────
describe('isFailoverWorthy(errorType)', () => {
  it('"geo_block" → true', () => expect(isFailoverWorthy('geo_block')).toBe(true))
  it('"proxy_dead" → true', () => expect(isFailoverWorthy('proxy_dead')).toBe(true))
  it('"timeout" → true', () => expect(isFailoverWorthy('timeout')).toBe(true))
  it('"auth_invalid" → true', () => expect(isFailoverWorthy('auth_invalid')).toBe(true))
  it('"unknown" → false', () => expect(isFailoverWorthy('unknown')).toBe(false))
  it('"network_error" → false', () => expect(isFailoverWorthy('network_error')).toBe(false))
})

// ── nextProxyCandidate() ──────────────────────────────────────────
describe('nextProxyCandidate(rankedProxies, triedAddrs)', () => {
  const a = { addr: 'proxy-a:1080' }
  const b = { addr: 'proxy-b:1080' }
  const c = { addr: 'proxy-c:1080' }

  it('empty proxies → null', () => {
    expect(nextProxyCandidate([], [])).toBeNull()
  })

  it('all tried → null', () => {
    expect(nextProxyCandidate([a, b], [a.addr, b.addr])).toBeNull()
  })

  it('[a,b,c], tried=[a] → returns b', () => {
    expect(nextProxyCandidate([a, b, c], [a.addr])).toEqual(b)
  })

  it('[a,b,c], tried=[] → returns a', () => {
    expect(nextProxyCandidate([a, b, c], [])).toEqual(a)
  })

  it('[a,b,c], tried=[a,b] → returns c', () => {
    expect(nextProxyCandidate([a, b, c], [a.addr, b.addr])).toEqual(c)
  })

  it('[a,b], tried=[a,b,c] → null (all tried)', () => {
    expect(nextProxyCandidate([a, b], [a.addr, b.addr, c.addr])).toBeNull()
  })
})

// ── calcNewDailyCap() ─────────────────────────────────────────────
describe('calcNewDailyCap(currentCap, bounceClassification)', () => {
  it('"ok" → null (no change)', () => expect(calcNewDailyCap(100, 'ok')).toBeNull())
  it('"insufficient" → null', () => expect(calcNewDailyCap(100, 'insufficient')).toBeNull())
  it('"warn", cap=100 → 80', () => expect(calcNewDailyCap(100, 'warn')).toBe(80))
  it('"warn", cap=50 → 40', () => expect(calcNewDailyCap(50, 'warn')).toBe(40))
  it('"warn", cap=12 → 10 (floor 10)', () => expect(calcNewDailyCap(12, 'warn')).toBe(10))
  it('"warn", cap=10 → 10 (already at floor)', () => expect(calcNewDailyCap(10, 'warn')).toBe(10))
  it('"critical", cap=100 → 50', () => expect(calcNewDailyCap(100, 'critical')).toBe(50))
  it('"critical", cap=15 → 10 (floor)', () => expect(calcNewDailyCap(15, 'critical')).toBe(10))
  it('"critical", cap=10 → 10', () => expect(calcNewDailyCap(10, 'critical')).toBe(10))
  it('unknown classification → null', () => expect(calcNewDailyCap(100, 'unknown')).toBeNull())
})

// ── shouldAdvanceWarmup() ─────────────────────────────────────────
describe('shouldAdvanceWarmup({ smtpOk, bounceRate, consecutiveBounces, bounceClass })', () => {
  const ok = { smtpOk: true, bounceRate: 2, consecutiveBounces: 0, bounceClass: 'ok' }

  it('all ok → true', () => expect(shouldAdvanceWarmup(ok)).toBe(true))
  it('smtpOk=false → false', () => expect(shouldAdvanceWarmup({ ...ok, smtpOk: false })).toBe(false))
  it('bounceRate=5 → false (≥5% blokuje)', () => expect(shouldAdvanceWarmup({ ...ok, bounceRate: 5 })).toBe(false))
  it('bounceRate=4.9 → true', () => expect(shouldAdvanceWarmup({ ...ok, bounceRate: 4.9 })).toBe(true))
  it('bounceClass="critical" → false', () => expect(shouldAdvanceWarmup({ ...ok, bounceClass: 'critical' })).toBe(false))
  it('consecutiveBounces=5 → false', () => expect(shouldAdvanceWarmup({ ...ok, consecutiveBounces: 5 })).toBe(false))
  it('bounceRate=null (no data) → true', () => expect(shouldAdvanceWarmup({ ...ok, bounceRate: null })).toBe(true))
})

// ── formatDailyReport() ───────────────────────────────────────────
describe('formatDailyReport(mailboxes, date)', () => {
  const healthy = { email: 'a@cz', status: 'active', score: 90, critical: [] }
  const degraded = { email: 'b@cz', status: 'active', score: 65, critical: ['smtp'] }
  const paused   = { email: 'c@cz', status: 'paused', score: 30, critical: ['smtp', 'proxy'] }

  it('returns subject and text', () => {
    const r = formatDailyReport([healthy], '2026-04-18')
    expect(r).toHaveProperty('subject')
    expect(r).toHaveProperty('text')
  })

  it('subject contains date and counts', () => {
    const { subject } = formatDailyReport([healthy, degraded, paused], '2026-04-18')
    expect(subject).toContain('2026-04-18')
    expect(subject).toMatch(/\d+\/\d+/)
  })

  it('text contains all emails', () => {
    const { text } = formatDailyReport([healthy, degraded, paused], '2026-04-18')
    expect(text).toContain('a@cz')
    expect(text).toContain('b@cz')
    expect(text).toContain('c@cz')
  })

  it('text contains critical issues', () => {
    const { text } = formatDailyReport([paused], '2026-04-18')
    expect(text).toContain('smtp')
  })

  it('empty mailboxes → no crash', () => {
    const r = formatDailyReport([], '2026-04-18')
    expect(r.subject).toBeTruthy()
    expect(r.text).toBeTruthy()
  })

  it('text contains per-mailbox score|status|email lines in correct format', () => {
    const mailboxes = [
      { email: 'a@cz', status: 'active',  score: 90, critical: [] },
      { email: 'b@cz', status: 'paused',  score: 30, critical: [] },
      { email: 'c@cz', status: 'active',  score: null, critical: ['smtp down'] },
    ]
    const { text } = formatDailyReport(mailboxes, '2026-04-18')
    // Each mailbox must appear as a structured line
    expect(text).toMatch(/\s+90 \| active\s+\| a@cz/)
    expect(text).toMatch(/\s+30 \| paused\s+\| b@cz/)
    expect(text).toMatch(/\s+\?\? \| active\s+\| c@cz/)
  })

  it('critical issues section lists problems', () => {
    const mailboxes = [
      { email: 'x@cz', status: 'active', score: 40, critical: ['smtp down', 'proxy dead'] },
      { email: 'y@cz', status: 'active', score: 90, critical: [] },
    ]
    const { text } = formatDailyReport(mailboxes, '2026-04-18')
    expect(text).toContain('x@cz: smtp down')
    expect(text).toContain('x@cz: proxy dead')
    expect(text).not.toContain('y@cz:')
  })

  it('no critical issues → "Žádné kritické problémy." in text', () => {
    const mailboxes = [{ email: 'a@cz', status: 'active', score: 95, critical: [] }]
    const { text } = formatDailyReport(mailboxes, '2026-04-18')
    expect(text).toContain('Žádné kritické problémy.')
  })

  it('subject contains healthy/total count', () => {
    const mailboxes = [
      { email: 'a@cz', status: 'active', score: 90, critical: [] },
      { email: 'b@cz', status: 'active', score: 40, critical: [] },
    ]
    const { subject } = formatDailyReport(mailboxes, '2026-04-18')
    expect(subject).toContain('1/2')
    expect(subject).toContain('2026-04-18')
  })
})

// ── processImapReplies() ──────────────────────────────────────────
describe('processImapReplies(messages, sendEvents)', () => {
  const events = [
    { id: 1, contactId: 10, contactEmail: 'jan@firma.cz', mailboxUsed: 'sender@example.com' },
    { id: 2, contactId: 20, contactEmail: 'petr@firma.cz', mailboxUsed: 'sender@example.com' },
  ]

  it('positive reply matched by fromAddr → classification=positive', () => {
    const msgs = [{ fromAddr: 'jan@firma.cz', subject: 'Zájem o spolupráci', snippet: '' }]
    const res = processImapReplies(msgs, events)
    expect(res).toHaveLength(1)
    expect(res[0].sendEventId).toBe(1)
    expect(res[0].contactId).toBe(10)
    expect(res[0].classification).toBe('positive')
  })

  it('negative reply → classification=negative', () => {
    const msgs = [{ fromAddr: 'jan@firma.cz', subject: 'Re:', snippet: 'nechci dostávat nabídky' }]
    const [r] = processImapReplies(msgs, events)
    expect(r.classification).toBe('negative')
  })

  it('auto_reply → classification=auto_reply', () => {
    const msgs = [{ fromAddr: 'petr@firma.cz', subject: 'Out of Office', snippet: '' }]
    const [r] = processImapReplies(msgs, events)
    expect(r.classification).toBe('auto_reply')
    expect(r.contactId).toBe(20)
  })

  it('unknown sender → skipped (no match)', () => {
    const msgs = [{ fromAddr: 'unknown@other.com', subject: 'Hi', snippet: '' }]
    expect(processImapReplies(msgs, events)).toHaveLength(0)
  })

  it('empty messages → []', () => {
    expect(processImapReplies([], events)).toHaveLength(0)
  })

  it('case-insensitive email match', () => {
    const msgs = [{ fromAddr: 'JAN@FIRMA.CZ', subject: 'Zájem', snippet: '' }]
    const [r] = processImapReplies(msgs, events)
    expect(r?.sendEventId).toBe(1)
  })

  it('propagates subject to result', () => {
    const msgs = [{ fromAddr: 'jan@firma.cz', subject: 'Zájem o spolupráci', snippet: '' }]
    const [r] = processImapReplies(msgs, events)
    expect(r.subject).toBe('Zájem o spolupráci')
  })

  it('propagates fromAddr to result', () => {
    const msgs = [{ fromAddr: 'jan@firma.cz', subject: 'Test', snippet: '' }]
    const [r] = processImapReplies(msgs, events)
    expect(r.fromAddr).toBe('jan@firma.cz')
  })

  it('preserves original fromAddr case in result', () => {
    const msgs = [{ fromAddr: 'JAN@FIRMA.CZ', subject: 'Test', snippet: '' }]
    const [r] = processImapReplies(msgs, events)
    expect(r.fromAddr).toBe('JAN@FIRMA.CZ')
  })

  it('empty subject propagates as empty string', () => {
    const msgs = [{ fromAddr: 'jan@firma.cz', subject: '', snippet: '' }]
    const [r] = processImapReplies(msgs, events)
    expect(r.subject).toBe('')
  })
})

// ── shouldSuppress() ──────────────────────────────────────────────
describe('shouldSuppress(classification)', () => {
  it('"negative" → true', () => expect(shouldSuppress('negative')).toBe(true))
  it('"unsubscribe" → true (explicit opt-out, compliance)', () => expect(shouldSuppress('unsubscribe')).toBe(true))
  it('"positive" → false', () => expect(shouldSuppress('positive')).toBe(false))
  it('"neutral" → false', () => expect(shouldSuppress('neutral')).toBe(false))
  it('"auto_reply" → false (OOO není opt-out)', () => expect(shouldSuppress('auto_reply')).toBe(false))
  it('null → false', () => expect(shouldSuppress(null)).toBe(false))
  it('undefined → false', () => expect(shouldSuppress(undefined)).toBe(false))
})

// ── isWithinSendWindow() ──────────────────────────────────────────
describe('isWithinSendWindow(now, tz)', () => {
  const tz = 'Europe/Prague'
  // 2026-04-20 je pondělí
  const mon9am  = new Date('2026-04-20T07:00:00Z')  // 09:00 Prague (UTC+2)
  const mon7am  = new Date('2026-04-20T05:00:00Z')  // 07:00 Prague
  const mon5pm  = new Date('2026-04-20T15:00:00Z')  // 17:00 Prague
  const mon6pm  = new Date('2026-04-20T16:00:00Z')  // 18:00 Prague
  const sat10am = new Date('2026-04-25T08:00:00Z')  // sobota 10:00 Prague
  const sun12pm = new Date('2026-04-26T10:00:00Z')  // neděle 12:00 Prague
  const fri1630 = new Date('2026-04-24T14:30:00Z')  // pátek 16:30 Prague

  it('pondělí 09:00 → true', () => expect(isWithinSendWindow(mon9am, tz)).toBe(true))
  it('pondělí 07:00 → false (před 8h)', () => expect(isWithinSendWindow(mon7am, tz)).toBe(false))
  it('pondělí 17:00 přesně → false (konec okna)', () => expect(isWithinSendWindow(mon5pm, tz)).toBe(false))
  it('pondělí 18:00 → false', () => expect(isWithinSendWindow(mon6pm, tz)).toBe(false))
  it('pátek 16:30 → true', () => expect(isWithinSendWindow(fri1630, tz)).toBe(true))
  it('sobota → false', () => expect(isWithinSendWindow(sat10am, tz)).toBe(false))
  it('neděle → false', () => expect(isWithinSendWindow(sun12pm, tz)).toBe(false))

  it('Saturday → false regardless of hour', () => {
    const sat = new Date('2026-04-18T10:00:00Z') // 2026-04-18 is a Saturday
    expect(isWithinSendWindow(sat, 'Europe/Prague')).toBe(false)
  })

  // ── env overrides (operator-controlled 24/7 send) ──────────────────
  describe('env overrides', () => {
    const ENV_KEYS = ['SEND_WINDOW_START_HOUR', 'SEND_WINDOW_END_HOUR', 'SEND_WEEKDAYS_ONLY']
    let saved
    beforeEach(() => {
      saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
      ENV_KEYS.forEach(k => delete process.env[k])
    })
    afterEach(() => {
      ENV_KEYS.forEach(k => {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      })
    })

    it('SEND_WEEKDAYS_ONLY=false → Saturday noon allowed', () => {
      process.env.SEND_WEEKDAYS_ONLY = 'false'
      expect(isWithinSendWindow(sat10am, 'Europe/Prague')).toBe(true)
    })

    it('SEND_WINDOW_START_HOUR=0 SEND_WINDOW_END_HOUR=24 → Mon 23:00 allowed', () => {
      process.env.SEND_WINDOW_START_HOUR = '0'
      process.env.SEND_WINDOW_END_HOUR = '24'
      const mon11pm = new Date('2026-04-20T21:00:00Z')  // 23:00 Prague
      expect(isWithinSendWindow(mon11pm, 'Europe/Prague')).toBe(true)
    })

    it('full 24/7 (start=0, end=24, weekdays=false) → Sunday 03:00 allowed', () => {
      process.env.SEND_WINDOW_START_HOUR = '0'
      process.env.SEND_WINDOW_END_HOUR = '24'
      process.env.SEND_WEEKDAYS_ONLY = 'false'
      const sun3am = new Date('2026-04-26T01:00:00Z')  // 03:00 Prague Sun
      expect(isWithinSendWindow(sun3am, 'Europe/Prague')).toBe(true)
    })

    it('SEND_WINDOW_END_HOUR=22 → Mon 21:30 allowed, 22:00 not', () => {
      process.env.SEND_WINDOW_END_HOUR = '22'
      const mon930pm = new Date('2026-04-20T19:30:00Z')  // 21:30 Prague
      const mon10pm  = new Date('2026-04-20T20:00:00Z')  // 22:00 Prague (end exclusive)
      expect(isWithinSendWindow(mon930pm, 'Europe/Prague')).toBe(true)
      expect(isWithinSendWindow(mon10pm,  'Europe/Prague')).toBe(false)
    })

    it('SEND_WINDOW_START_HOUR=10 → Mon 09:59 not allowed, 10:00 allowed', () => {
      process.env.SEND_WINDOW_START_HOUR = '10'
      const mon959 = new Date('2026-04-20T07:59:00Z')  // 09:59 Prague
      const mon10  = new Date('2026-04-20T08:00:00Z')  // 10:00 Prague
      expect(isWithinSendWindow(mon959, 'Europe/Prague')).toBe(false)
      expect(isWithinSendWindow(mon10,  'Europe/Prague')).toBe(true)
    })

    it('inverted range (start=20, end=10) → fallback default 8–17', () => {
      process.env.SEND_WINDOW_START_HOUR = '20'
      process.env.SEND_WINDOW_END_HOUR = '10'
      // Mon 09:00 is inside the fallback default 8-17 window
      expect(isWithinSendWindow(mon9am, 'Europe/Prague')).toBe(true)
      // Mon 18:00 is outside fallback
      expect(isWithinSendWindow(mon6pm, 'Europe/Prague')).toBe(false)
    })

    it('NaN env values → fallback default', () => {
      process.env.SEND_WINDOW_START_HOUR = 'abc'
      process.env.SEND_WINDOW_END_HOUR = 'xyz'
      expect(isWithinSendWindow(mon9am, 'Europe/Prague')).toBe(true)   // 09:00 → in default
      expect(isWithinSendWindow(mon7am, 'Europe/Prague')).toBe(false)  // 07:00 → out
    })

    it('SEND_WEEKDAYS_ONLY=0 (string zero) also disables weekday gate', () => {
      process.env.SEND_WEEKDAYS_ONLY = '0'
      expect(isWithinSendWindow(sun12pm, 'Europe/Prague')).toBe(true)
    })

    it('SEND_WEEKDAYS_ONLY=true (explicit) keeps weekday-only', () => {
      process.env.SEND_WEEKDAYS_ONLY = 'true'
      expect(isWithinSendWindow(sat10am, 'Europe/Prague')).toBe(false)
    })

    it('start=0 end=24 weekdays=true → Sat midnight rejected (weekday gate still on)', () => {
      process.env.SEND_WINDOW_START_HOUR = '0'
      process.env.SEND_WINDOW_END_HOUR = '24'
      const satMidnight = new Date('2026-04-25T00:00:00Z')  // 02:00 Prague Sat (CEST)
      expect(isWithinSendWindow(satMidnight, 'Europe/Prague')).toBe(false)
    })

    it('start=0 end=24 weekdays=false → midnight allowed across week', () => {
      process.env.SEND_WINDOW_START_HOUR = '0'
      process.env.SEND_WINDOW_END_HOUR = '24'
      process.env.SEND_WEEKDAYS_ONLY = 'false'
      const satMidnightUTC = new Date('2026-04-24T22:00:00Z')  // Sat 00:00 Prague
      const sun0001UTC     = new Date('2026-04-25T22:01:00Z')  // Sun 00:01 Prague
      expect(isWithinSendWindow(satMidnightUTC, 'Europe/Prague')).toBe(true)
      expect(isWithinSendWindow(sun0001UTC,     'Europe/Prague')).toBe(true)
    })
  })
})

// ── shouldResumeBounceEscalation() ───────────────────────────────
describe('shouldResumeBounceEscalation(mb, current)', () => {
  const base = {
    status: 'paused',
    status_reason: 'auto: sustained bounce warn — daily cap at floor',
    daily_cap_reduced_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
  }

  it('returns true when paused, cooldown elapsed, bounce recovered', () => {
    expect(shouldResumeBounceEscalation(base, { bounceRate: 1, consecutiveBounces: 0 })).toBe(true)
  })

  it('returns true when bounceRate is null (no sends yet)', () => {
    expect(shouldResumeBounceEscalation(base, { bounceRate: null, consecutiveBounces: 0 })).toBe(true)
  })

  it('returns false when cooldown not elapsed', () => {
    const recent = { ...base, daily_cap_reduced_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString() }
    expect(shouldResumeBounceEscalation(recent, { bounceRate: 1, consecutiveBounces: 0 })).toBe(false)
  })

  it('returns false when bounce rate still elevated', () => {
    expect(shouldResumeBounceEscalation(base, { bounceRate: 5, consecutiveBounces: 0 })).toBe(false)
  })

  it('returns false when consecutive bounces > 0', () => {
    expect(shouldResumeBounceEscalation(base, { bounceRate: 1, consecutiveBounces: 1 })).toBe(false)
  })

  it('returns false when status is not paused', () => {
    expect(shouldResumeBounceEscalation({ ...base, status: 'active' }, { bounceRate: 0, consecutiveBounces: 0 })).toBe(false)
  })

  it('returns false when status_reason is different (manual pause)', () => {
    expect(shouldResumeBounceEscalation({ ...base, status_reason: 'manual' }, { bounceRate: 0, consecutiveBounces: 0 })).toBe(false)
  })
})

// ── imapCircuitDecision() ─────────────────────────────────────────
describe('imapCircuitDecision(consecutiveFailures)', () => {
  it('returns open:false for < 5 failures', () => {
    expect(imapCircuitDecision(4)).toEqual({ open: false, durationMinutes: 0 })
  })

  it('returns open:true with 120min for 5–9 failures', () => {
    expect(imapCircuitDecision(5)).toEqual({ open: true, durationMinutes: 120 })
    expect(imapCircuitDecision(9)).toEqual({ open: true, durationMinutes: 120 })
  })

  it('returns open:true with 240min for >= 10 failures', () => {
    expect(imapCircuitDecision(10)).toEqual({ open: true, durationMinutes: 240 })
    expect(imapCircuitDecision(20)).toEqual({ open: true, durationMinutes: 240 })
  })

  it('0 failures → open:false', () => {
    expect(imapCircuitDecision(0)).toEqual({ open: false, durationMinutes: 0 })
  })
})

// ── shouldBreakAuthCircuit() ──────────────────────────────────────
describe('shouldBreakAuthCircuit(consecutiveAuthFailures)', () => {
  it('returns false for 0 failures', () => expect(shouldBreakAuthCircuit(0)).toBe(false))
  it('returns false for 1 failure',  () => expect(shouldBreakAuthCircuit(1)).toBe(false))
  it('returns true for 2 failures',  () => expect(shouldBreakAuthCircuit(2)).toBe(true))
  it('returns true for 3+ failures', () => expect(shouldBreakAuthCircuit(5)).toBe(true))
})

// ── isScoreDrop() ─────────────────────────────────────────────────
describe('isScoreDrop(previousScore, currentScore)', () => {
  it('drop of exactly 20 → true',  () => expect(isScoreDrop(100, 80)).toBe(true))
  it('drop of 21 → true',          () => expect(isScoreDrop(100, 79)).toBe(true))
  it('drop of 19 → false',         () => expect(isScoreDrop(100, 81)).toBe(false))
  it('increase → false',           () => expect(isScoreDrop(80, 100)).toBe(false))
  it('no change → false',          () => expect(isScoreDrop(100, 100)).toBe(false))
  it('null previous → false',      () => expect(isScoreDrop(null, 80)).toBe(false))
  it('null current → false',       () => expect(isScoreDrop(100, null)).toBe(false))
})

// ── shouldProactivelyRotateProxy() ───────────────────────────────
describe('shouldProactivelyRotateProxy(proxyCheck)', () => {
  it('returns true when ok:true and ms > 3000',  () => expect(shouldProactivelyRotateProxy({ ok: true, ms: 3001 })).toBe(true))
  it('returns false when ok:true and ms <= 3000', () => expect(shouldProactivelyRotateProxy({ ok: true, ms: 3000 })).toBe(false))
  it('returns false when ok:false (will be evicted reactively)', () => expect(shouldProactivelyRotateProxy({ ok: false, ms: 5000 })).toBe(false))
  it('returns false for null',                    () => expect(shouldProactivelyRotateProxy(null)).toBe(false))
  it('returns false when ms is null',             () => expect(shouldProactivelyRotateProxy({ ok: true, ms: null })).toBe(false))
})

// ── classifySmtpSteps() ───────────────────────────────────────────
// S6: proxy fail nepauzuje schránku — jen auth/tls selhání pauzují
describe('classifySmtpSteps(steps)', () => {
  // ── null/undefined/missing ──
  it('null → null (no failure info)', () => {
    expect(classifySmtpSteps(null)).toBeNull()
  })

  it('undefined → null', () => {
    expect(classifySmtpSteps(undefined)).toBeNull()
  })

  it('non-array (object) → null', () => {
    expect(classifySmtpSteps({ name: 'socks_dial', ok: false })).toBeNull()
  })

  it('empty array → "unknown" (failed but no recognised step)', () => {
    // An empty steps array means smtp failed but no step info — classify as unknown
    expect(classifySmtpSteps([])).toBe('unknown')
  })

  // ── proxy_fail ──
  it('socks_dial ok=false → "proxy_fail"', () => {
    const steps = [
      { name: 'socks_dial', ok: false, msg: 'ECONNREFUSED' },
    ]
    expect(classifySmtpSteps(steps)).toBe('proxy_fail')
  })

  it('socks_dial ok=false overrides later smtp_auth ok=false → "proxy_fail"', () => {
    const steps = [
      { name: 'socks_dial', ok: false },
      { name: 'smtp_auth', ok: false },
    ]
    expect(classifySmtpSteps(steps)).toBe('proxy_fail')
  })

  it('socks_dial ok=true, smtp_auth ok=false → "auth_fail" (proxy ok, auth failed)', () => {
    const steps = [
      { name: 'socks_dial', ok: true },
      { name: 'smtp_auth', ok: false },
    ]
    expect(classifySmtpSteps(steps)).toBe('auth_fail')
  })

  // ── auth_fail ──
  it('smtp_auth ok=false (no socks step) → "auth_fail"', () => {
    const steps = [
      { name: 'smtp_connect', ok: true },
      { name: 'smtp_auth', ok: false, msg: '535 5.7.8 incorrect credentials' },
    ]
    expect(classifySmtpSteps(steps)).toBe('auth_fail')
  })

  // ── tls_fail ──
  it('tls_handshake ok=false → "tls_fail"', () => {
    const steps = [
      { name: 'socks_dial', ok: true },
      { name: 'smtp_connect', ok: true },
      { name: 'tls_handshake', ok: false },
    ]
    expect(classifySmtpSteps(steps)).toBe('tls_fail')
  })

  it('starttls ok=false → "tls_fail"', () => {
    const steps = [
      { name: 'starttls', ok: false },
    ]
    expect(classifySmtpSteps(steps)).toBe('tls_fail')
  })

  // ── unknown ──
  it('all steps ok=true → "unknown" (smtp failed but all steps ok, anomaly)', () => {
    const steps = [
      { name: 'socks_dial', ok: true },
      { name: 'smtp_auth', ok: true },
    ]
    expect(classifySmtpSteps(steps)).toBe('unknown')
  })

  it('unknown step name with ok=false → "unknown"', () => {
    const steps = [
      { name: 'smtp_connect', ok: false },
    ]
    expect(classifySmtpSteps(steps)).toBe('unknown')
  })

  // ── MONKEY: malformed steps ──
  it('steps with null entries → no crash, returns null or classifies safely', () => {
    const steps = [null, undefined, { name: 'socks_dial', ok: false }]
    expect(() => classifySmtpSteps(steps)).not.toThrow()
    expect(classifySmtpSteps(steps)).toBe('proxy_fail')
  })

  it('steps with missing name field → no crash', () => {
    const steps = [{ ok: false }, { name: null, ok: false }]
    expect(() => classifySmtpSteps(steps)).not.toThrow()
    expect(classifySmtpSteps(steps)).toBe('unknown')
  })

  it('steps with string "ok" instead of boolean → treated as truthy, no crash', () => {
    const steps = [{ name: 'socks_dial', ok: 'false' }] // truthy string
    expect(() => classifySmtpSteps(steps)).not.toThrow()
    // ok='false' is truthy → socks_dial not failed → falls through to unknown
    expect(classifySmtpSteps(steps)).toBe('unknown')
  })
})
