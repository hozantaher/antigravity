// Property-based tests using fast-check.
// Goal: invariants checked against thousands of random inputs.
// Each property kills a class of mutants that example-based tests miss.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  score,
  sortMailboxes,
  getBounceRate,
  filterMailboxes,
  analyzeHeaderAnonymity,
  calcFullCheckScore,
  classifyBounceHealth,
  isWarmupStale,
  parseSmtpCheckResult,
  parseImapCheckResult,
  buildFullCheckSummary,
  formatPipelineAge,
  fmtNum,
  parseConfigIssues,
} from '../../../src/lib/mailboxUtils.js'

const arbMailbox = fc.record({
  id: fc.integer({ min: 1, max: 10_000 }),
  email: fc.emailAddress(),
  display_name: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
  host: fc.option(fc.domain(), { nil: null }),
  status: fc.constantFrom('active', 'paused', 'failed', 'warmup'),
  port: fc.constantFrom(25, 465, 587, 2525),
  imap_host: fc.option(fc.domain(), { nil: null }),
  imap_port: fc.constantFrom(143, 993, null),
  proxy_url: fc.option(fc.webUrl(), { nil: null }),
  daily_limit: fc.integer({ min: 0, max: 1000 }),
  total_sent: fc.integer({ min: 0, max: 100_000 }),
  total_bounced: fc.integer({ min: 0, max: 100_000 }),
  consecutive_bounces: fc.integer({ min: 0, max: 50 }),
  warmup_day: fc.integer({ min: 0, max: 30 }),
  password: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  smtp_host: fc.option(fc.domain(), { nil: null }),
  smtp_username: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  smtp_port: fc.constantFrom(25, 465, 587, 2525),
})

// ── score ────────────────────────────────────────────────────────────
describe('score (property)', () => {
  it('result is always integer in [0, 6]', () => {
    fc.assert(fc.property(arbMailbox, fc.option(fc.boolean()), (mb, anti) => {
      const s = score(mb, anti)
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(6)
    }))
  })

  it('proxy_url adds exactly +2 vs same mailbox without proxy', () => {
    fc.assert(fc.property(arbMailbox, fc.option(fc.boolean()), (mb, anti) => {
      const withProxy    = score({ ...mb, proxy_url: 'socks5://x:1' }, anti)
      const withoutProxy = score({ ...mb, proxy_url: null         }, anti)
      expect(withProxy - withoutProxy).toBe(2)
    }))
  })

  it('imap_host adds exactly +1', () => {
    fc.assert(fc.property(arbMailbox, fc.option(fc.boolean()), (mb, anti) => {
      const withImap    = score({ ...mb, imap_host: 'imap.x' }, anti)
      const withoutImap = score({ ...mb, imap_host: null     }, anti)
      expect(withImap - withoutImap).toBe(1)
    }))
  })

  it('port 465 yields +2 over a non-TLS port (e.g. 25)', () => {
    fc.assert(fc.property(arbMailbox, fc.option(fc.boolean()), (mb, anti) => {
      const tls   = score({ ...mb, port: 465 }, anti)
      const plain = score({ ...mb, port: 25  }, anti)
      expect(tls - plain).toBe(2)
    }))
  })

  it('port 587 yields +1 over a non-TLS port (e.g. 25)', () => {
    fc.assert(fc.property(arbMailbox, fc.option(fc.boolean()), (mb, anti) => {
      const starttls = score({ ...mb, port: 587 }, anti)
      const plain    = score({ ...mb, port: 25  }, anti)
      expect(starttls - plain).toBe(1)
    }))
  })

  it('antiTraceOk=true adds exactly +1 over false/null', () => {
    fc.assert(fc.property(arbMailbox, (mb) => {
      const ok    = score(mb, true)
      const notOk = score(mb, false)
      const undef = score(mb, null)
      expect(ok - notOk).toBe(1)
      expect(ok - undef).toBe(1)
    }))
  })
})

// ── sortMailboxes ────────────────────────────────────────────────────
describe('sortMailboxes (property)', () => {
  it('preserves length', () => {
    fc.assert(fc.property(fc.array(arbMailbox), (arr) => {
      expect(sortMailboxes(arr, 'email', 'asc')).toHaveLength(arr.length)
      expect(sortMailboxes(arr, 'total_sent', 'desc')).toHaveLength(arr.length)
    }))
  })

  it('does not mutate the input array', () => {
    fc.assert(fc.property(fc.array(arbMailbox, { minLength: 2 }), (arr) => {
      const before = JSON.stringify(arr)
      sortMailboxes(arr, 'email', 'asc')
      expect(JSON.stringify(arr)).toBe(before)
    }))
  })

  it('asc and desc are reverse of each other for the SAME stable key', () => {
    // Use a key with no duplicates to avoid stability ambiguity.
    fc.assert(fc.property(
      fc.uniqueArray(arbMailbox, { selector: x => x.id, minLength: 2 }),
      (arr) => {
        const asc  = sortMailboxes(arr, 'id', 'asc')
        const desc = sortMailboxes(arr, 'id', 'desc')
        expect(asc.map(x => x.id)).toEqual([...desc].reverse().map(x => x.id))
      }
    ))
  })

  it('numeric sort: every adjacent pair satisfies a[k] <= b[k]', () => {
    fc.assert(fc.property(fc.array(arbMailbox, { minLength: 2 }), (arr) => {
      const sorted = sortMailboxes(arr, 'total_sent', 'asc')
      for (let i = 1; i < sorted.length; i++) {
        expect(Number(sorted[i - 1].total_sent || 0))
          .toBeLessThanOrEqual(Number(sorted[i].total_sent || 0))
      }
    }))
  })

  it('avoids "10 < 2" string-compare bug on numeric keys', () => {
    const arr = [{ total_sent: 2 }, { total_sent: 10 }, { total_sent: 1 }]
    const sorted = sortMailboxes(arr, 'total_sent', 'asc')
    expect(sorted.map(x => x.total_sent)).toEqual([1, 2, 10])
  })
})

// ── getBounceRate ────────────────────────────────────────────────────
describe('getBounceRate (property)', () => {
  it('returns null iff total_sent is 0', () => {
    fc.assert(fc.property(fc.nat({ max: 100_000 }), (tb) => {
      expect(getBounceRate(0, tb)).toBeNull()
    }))
  })

  it('result parsed as number is in [0, 100] when bounces ≤ sent', () => {
    fc.assert(fc.property(
      fc.nat({ max: 100_000 }),
      fc.nat({ max: 100_000 }),
      (sent, bounces) => {
        if (sent === 0) return
        const cappedBounces = Math.min(bounces, sent)
        const r = parseFloat(getBounceRate(sent, cappedBounces))
        expect(r).toBeGreaterThanOrEqual(0)
        expect(r).toBeLessThanOrEqual(100)
      }
    ))
  })

  it('always returns one decimal digit', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 100_000 }),
      fc.nat({ max: 100_000 }),
      (sent, bounces) => {
        const r = getBounceRate(sent, bounces)
        expect(r).toMatch(/^-?\d+\.\d$/)
      }
    ))
  })
})

// ── filterMailboxes ──────────────────────────────────────────────────
describe('filterMailboxes (property)', () => {
  it('result is always a subset of input', () => {
    fc.assert(fc.property(
      fc.array(arbMailbox),
      fc.string(),
      fc.constantFrom('', 'all', 'active', 'paused', 'failed', 'warmup'),
      (arr, q, status) => {
        const out = filterMailboxes(arr, q, status)
        expect(out.length).toBeLessThanOrEqual(arr.length)
        for (const x of out) expect(arr).toContain(x)
      }
    ))
  })

  it('empty search + empty status returns the whole input', () => {
    fc.assert(fc.property(fc.array(arbMailbox), (arr) => {
      expect(filterMailboxes(arr, '', '')).toHaveLength(arr.length)
    }))
  })

  it('status="all" is identical to status=""', () => {
    fc.assert(fc.property(fc.array(arbMailbox), fc.string(), (arr, q) => {
      expect(filterMailboxes(arr, q, 'all'))
        .toEqual(filterMailboxes(arr, q, ''))
    }))
  })

  it('search is case-insensitive', () => {
    fc.assert(fc.property(fc.array(arbMailbox), (arr) => {
      if (arr.length === 0) return
      const q = arr[0].email.slice(0, 3)
      const lower = filterMailboxes(arr, q.toLowerCase(), '')
      const upper = filterMailboxes(arr, q.toUpperCase(), '')
      expect(lower.map(x => x.id).sort()).toEqual(upper.map(x => x.id).sort())
    }))
  })
})

// ── analyzeHeaderAnonymity ────────────────────────────────────────────
describe('analyzeHeaderAnonymity (property)', () => {
  it('score always integer in [0, 100]', () => {
    fc.assert(fc.property(fc.string(), (raw) => {
      const r = analyzeHeaderAnonymity(raw)
      expect(Number.isInteger(r.score)).toBe(true)
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(100)
    }))
  })

  it('safe = (score >= 70)', () => {
    fc.assert(fc.property(fc.string(), (raw) => {
      const r = analyzeHeaderAnonymity(raw)
      expect(r.safe).toBe(r.score >= 70)
    }))
  })

  it('clean headers always score 100, safe', () => {
    expect(analyzeHeaderAnonymity('From: x@y.com\r\nTo: a@b.com\r\nSubject: hi').score).toBe(100)
    expect(analyzeHeaderAnonymity('').score).toBe(100)
  })

  it('X-Originating-IP always deducts ≥ 40 → never safe', () => {
    fc.assert(fc.property(fc.ipV4(), (ip) => {
      const r = analyzeHeaderAnonymity(`X-Originating-IP: ${ip}`)
      expect(r.score).toBeLessThanOrEqual(60)
      expect(r.safe).toBe(false)
      expect(r.issues.some(i => i.field === 'X-Originating-IP')).toBe(true)
    }))
  })

  it('X-Forwarded-For always deducts ≥ 40', () => {
    fc.assert(fc.property(fc.ipV4(), (ip) => {
      const r = analyzeHeaderAnonymity(`X-Forwarded-For: ${ip}`)
      expect(r.score).toBeLessThanOrEqual(60)
    }))
  })

  it('private IP (10.x) in Received deducts 15', () => {
    const r = analyzeHeaderAnonymity('Received: from internal (10.0.0.5)')
    expect(r.score).toBe(85)
    expect(r.issues.some(i => i.field === 'Received')).toBe(true)
  })

  it('private IP (192.168.x) in Received deducts 15', () => {
    const r = analyzeHeaderAnonymity('Received: from lan (192.168.1.1)')
    expect(r.score).toBe(85)
  })

  it('private IP (172.16-31.x) in Received deducts 15', () => {
    for (const sec of [16, 20, 31]) {
      const r = analyzeHeaderAnonymity(`Received: from x (172.${sec}.0.1)`)
      expect(r.score).toBe(85)
    }
  })

  it('public IP in Received does NOT deduct', () => {
    const r = analyzeHeaderAnonymity('Received: from public (8.8.8.8)')
    expect(r.score).toBe(100)
  })

  it('X-Mailer deducts 10', () => {
    const r = analyzeHeaderAnonymity('X-Mailer: Outlook 2021')
    expect(r.score).toBe(90)
  })

  it('User-Agent deducts 10', () => {
    const r = analyzeHeaderAnonymity('User-Agent: Thunderbird/115')
    expect(r.score).toBe(90)
  })

  it('all 5 leaks combined: floors at 0', () => {
    const raw = [
      'X-Originating-IP: 1.2.3.4',
      'X-Forwarded-For: 1.2.3.4',
      'Received: from x (10.0.0.1)',
      'X-Mailer: Foo',
      'User-Agent: Bar',
    ].join('\r\n')
    const r = analyzeHeaderAnonymity(raw)
    expect(r.score).toBe(0)
    expect(r.safe).toBe(false)
  })
})

// ── calcFullCheckScore ────────────────────────────────────────────────
describe('calcFullCheckScore (property)', () => {
  const arbCheck = fc.option(fc.record({ ok: fc.boolean() }), { nil: null })
  const arbChecks = fc.record({
    smtp: arbCheck, imap: arbCheck, config: arbCheck, proxy: arbCheck,
    anti_trace: arbCheck, warmup: arbCheck, bounce: arbCheck,
    send_rate: arbCheck, pipeline: arbCheck,
  })

  it('result always integer in [0, 100]', () => {
    fc.assert(fc.property(arbChecks, (c) => {
      const s = calcFullCheckScore(c)
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(100)
    }))
  })

  it('all checks ok = 100', () => {
    const c = Object.fromEntries(
      ['smtp','imap','config','proxy','anti_trace','warmup','bounce','send_rate','pipeline']
        .map(k => [k, { ok: true }])
    )
    expect(calcFullCheckScore(c)).toBe(100)
  })

  it('all checks fail = 0', () => {
    const c = Object.fromEntries(
      ['smtp','imap','config','proxy','anti_trace','warmup','bounce','send_rate','pipeline']
        .map(k => [k, { ok: false }])
    )
    expect(calcFullCheckScore(c)).toBe(0)
  })

  it('no checks (all null) = 100 (no data, no penalty)', () => {
    expect(calcFullCheckScore({})).toBe(100)
    expect(calcFullCheckScore({ smtp: null, imap: null })).toBe(100)
  })

  it('monotonic: flipping a failing check to ok never decreases score', () => {
    fc.assert(fc.property(arbChecks, fc.constantFrom(
      'smtp','imap','config','proxy','anti_trace','warmup','bounce','send_rate','pipeline'
    ), (c, key) => {
      const failed = { ...c, [key]: { ok: false } }
      const passed = { ...c, [key]: { ok: true  } }
      expect(calcFullCheckScore(passed)).toBeGreaterThanOrEqual(calcFullCheckScore(failed))
    }))
  })
})

// ── classifyBounceHealth ──────────────────────────────────────────────
describe('classifyBounceHealth (property)', () => {
  it('returns one of {ok, warn, critical}', () => {
    fc.assert(fc.property(
      fc.option(fc.float({ min: 0, max: 100, noNaN: true })),
      fc.nat({ max: 100 }),
      (rate, c) => {
        const r = classifyBounceHealth(rate, c)
        expect(['ok', 'warn', 'critical']).toContain(r)
      }
    ))
  })

  it('consecutive ≥ 5 → always critical', () => {
    fc.assert(fc.property(
      fc.option(fc.double({ min: 0, max: 100, noNaN: true })),
      fc.integer({ min: 5, max: 100 }),
      (rate, c) => { expect(classifyBounceHealth(rate, c)).toBe('critical') }
    ))
  })

  it('consecutive in [3, 4] with low rate → warn', () => {
    expect(classifyBounceHealth(0, 3)).toBe('warn')
    expect(classifyBounceHealth(0, 4)).toBe('warn')
    expect(classifyBounceHealth(null, 3)).toBe('warn')
  })

  it('rate ≥ 10 → critical (when consecutive < 3)', () => {
    fc.assert(fc.property(
      fc.double({ min: 10, max: 100, noNaN: true }),
      fc.integer({ min: 0, max: 2 }),
      (rate, c) => { expect(classifyBounceHealth(rate, c)).toBe('critical') }
    ))
  })

  it('rate in [5,10) → warn (when consecutive < 3)', () => {
    fc.assert(fc.property(
      fc.double({ min: 5, max: 9.999, noNaN: true }),
      fc.integer({ min: 0, max: 2 }),
      (rate, c) => { expect(classifyBounceHealth(rate, c)).toBe('warn') }
    ))
  })

  it('rate < 5 and consecutive < 3 → ok', () => {
    fc.assert(fc.property(
      fc.double({ min: 0, max: 4.999, noNaN: true }),
      fc.integer({ min: 0, max: 2 }),
      (rate, c) => { expect(classifyBounceHealth(rate, c)).toBe('ok') }
    ))
  })
})

// ── isWarmupStale ────────────────────────────────────────────────────
describe('isWarmupStale (property)', () => {
  it('null/undefined → always stale', () => {
    expect(isWarmupStale(null)).toBe(true)
    expect(isWarmupStale(undefined)).toBe(true)
  })

  it('age ≥ threshold → true; age < threshold → false', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 168 }),
      fc.integer({ min: 0, max: 1000 }),
      (thresholdH, ageH) => {
        const past = new Date(Date.now() - ageH * 3600_000).toISOString()
        const expected = ageH >= thresholdH
        expect(isWarmupStale(past, thresholdH)).toBe(expected)
      }
    ))
  })

  it('boundary at exactly threshold → true', () => {
    const exact24h = new Date(Date.now() - 24 * 3600_000 - 100).toISOString()
    expect(isWarmupStale(exact24h, 24)).toBe(true)
  })
})

// ── parseSmtpCheckResult / parseImapCheckResult ──────────────────────
describe('parseSmtp/Imap checkResult (property)', () => {
  const arbStep = fc.record({
    name: fc.string({ minLength: 1, maxLength: 20 }),
    ok: fc.boolean(),
    msg: fc.option(fc.string({ maxLength: 50 })),
  })

  for (const [name, fn] of [['smtp', parseSmtpCheckResult], ['imap', parseImapCheckResult]]) {
    describe(name, () => {
      it('empty/null/undefined → ok=false', () => {
        expect(fn(null).ok).toBe(false)
        expect(fn(undefined).ok).toBe(false)
        expect(fn([]).ok).toBe(false)
      })

      it('all steps ok=true → ok:true', () => {
        fc.assert(fc.property(
          fc.array(fc.record({ name: fc.string({ minLength: 1 }), ok: fc.constant(true), msg: fc.option(fc.string()) }), { minLength: 1, maxLength: 8 }),
          (steps) => {
            const r = fn(steps)
            expect(r.ok).toBe(true)
            expect(r.failStep).toBeNull()
            expect(r.failMsg).toBeNull()
          }
        ))
      })

      it('any step ok=false → ok:false with that step name', () => {
        fc.assert(fc.property(
          fc.array(arbStep, { minLength: 1, maxLength: 8 }),
          (steps) => {
            const firstFail = steps.find(s => !s.ok)
            const r = fn(steps)
            if (firstFail) {
              expect(r.ok).toBe(false)
              expect(r.failStep).toBe(firstFail.name)
            } else {
              expect(r.ok).toBe(true)
            }
          }
        ))
      })
    })
  }
})

// ── buildFullCheckSummary ─────────────────────────────────────────────
describe('buildFullCheckSummary (property)', () => {
  const arbCheck = fc.option(fc.record({
    ok: fc.boolean(),
    near_limit: fc.option(fc.boolean()),
    warn: fc.option(fc.boolean()),
    near_end: fc.option(fc.boolean()),
    insufficient_data: fc.option(fc.boolean()),
  }), { nil: null })

  it('score is in [0, 100]', () => {
    fc.assert(fc.property(
      fc.record({
        smtp: arbCheck, imap: arbCheck, config: arbCheck, proxy: arbCheck,
        anti_trace: arbCheck, warmup: arbCheck, bounce: arbCheck,
        send_rate: arbCheck, pipeline: arbCheck,
      }),
      (c) => {
        const s = buildFullCheckSummary(c)
        expect(s.score).toBeGreaterThanOrEqual(0)
        expect(s.score).toBeLessThanOrEqual(100)
      }
    ))
  })

  it('proxy.ok=false caps effective score at 74', () => {
    const c = Object.fromEntries(
      ['smtp','imap','config','anti_trace','warmup','bounce','send_rate','pipeline']
        .map(k => [k, { ok: true }])
    )
    c.proxy = { ok: false }
    const s = buildFullCheckSummary(c)
    expect(s.score).toBeLessThanOrEqual(74)
    expect(s.send_ready).toBe(false)
  })

  it('send_ready=true requires proxy.ok≠false AND score≥50', () => {
    fc.assert(fc.property(
      fc.record({
        smtp: arbCheck, imap: arbCheck, config: arbCheck,
        proxy: arbCheck, anti_trace: arbCheck, warmup: arbCheck,
        bounce: arbCheck, send_rate: arbCheck, pipeline: arbCheck,
      }),
      (c) => {
        const s = buildFullCheckSummary(c)
        if (s.send_ready) {
          expect(c.proxy?.ok === false).toBe(false)
          expect(s.score).toBeGreaterThanOrEqual(50)
        }
      }
    ))
  })

  it('failing critical (smtp/imap/config) appears in critical, never in warnings', () => {
    fc.assert(fc.property(fc.constantFrom('smtp','imap','config'), (key) => {
      const c = { [key]: { ok: false } }
      const s = buildFullCheckSummary(c)
      expect(s.critical).toContain(key)
      expect(s.warnings).not.toContain(key)
    }))
  })

  it('passing checks appear in passing', () => {
    const c = { smtp: { ok: true }, imap: { ok: true } }
    const s = buildFullCheckSummary(c)
    expect(s.passing).toContain('smtp')
    expect(s.passing).toContain('imap')
  })
})

// ── formatPipelineAge ─────────────────────────────────────────────────
describe('formatPipelineAge (property)', () => {
  it('null → stale=true with "Nikdy" label', () => {
    const r = formatPipelineAge(null)
    expect(r.stale).toBe(true)
    expect(r.label).toBe('Nikdy')
  })

  it('age ≥ 24h → stale', () => {
    fc.assert(fc.property(fc.integer({ min: 24, max: 1000 }), (h) => {
      const past = new Date(Date.now() - h * 3600_000).toISOString()
      expect(formatPipelineAge(past).stale).toBe(true)
    }))
  })

  it('age in [12, 24) → warn, not stale', () => {
    fc.assert(fc.property(fc.integer({ min: 12, max: 23 }), (h) => {
      const past = new Date(Date.now() - h * 3600_000 - 60_000).toISOString()
      const r = formatPipelineAge(past)
      expect(r.stale).toBe(false)
      expect(r.warn).toBe(true)
    }))
  })

  it('age < 12h → not warn, not stale', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 11 }), (h) => {
      const past = new Date(Date.now() - h * 3600_000).toISOString()
      const r = formatPipelineAge(past)
      expect(r.stale).toBe(false)
      expect(r.warn).toBe(false)
    }))
  })
})

// ── fmtNum ────────────────────────────────────────────────────────────
describe('fmtNum (property)', () => {
  it('returns a string', () => {
    fc.assert(fc.property(fc.option(fc.integer()), (n) => {
      expect(typeof fmtNum(n)).toBe('string')
    }))
  })

  it('null/undefined/0 → "0"', () => {
    expect(fmtNum(null)).toBe('0')
    expect(fmtNum(undefined)).toBe('0')
    expect(fmtNum(0)).toBe('0')
  })
})

// ── parseConfigIssues ─────────────────────────────────────────────────
describe('parseConfigIssues (property)', () => {
  it('returns an array of issue objects with required fields', () => {
    fc.assert(fc.property(arbMailbox, (mb) => {
      const issues = parseConfigIssues(mb)
      expect(Array.isArray(issues)).toBe(true)
      for (const i of issues) {
        expect(i).toHaveProperty('field')
        expect(i).toHaveProperty('severity')
        expect(i).toHaveProperty('msg')
        expect(['critical', 'warn']).toContain(i.severity)
      }
    }))
  })

  it('missing password → critical issue', () => {
    fc.assert(fc.property(arbMailbox, (mb) => {
      const issues = parseConfigIssues({ ...mb, password: null })
      expect(issues.some(i => i.field === 'password' && i.severity === 'critical')).toBe(true)
    }))
  })

  it('missing smtp_host → critical issue', () => {
    fc.assert(fc.property(arbMailbox, (mb) => {
      const issues = parseConfigIssues({ ...mb, smtp_host: null })
      expect(issues.some(i => i.field === 'smtp_host' && i.severity === 'critical')).toBe(true)
    }))
  })

  it('invalid smtp_port → critical issue', () => {
    fc.assert(fc.property(arbMailbox, fc.constantFrom(0, -1, 65536, 99999, NaN), (mb, badPort) => {
      const issues = parseConfigIssues({ ...mb, smtp_port: badPort })
      expect(issues.some(i => i.field === 'smtp_port' && i.severity === 'critical')).toBe(true)
    }))
  })

  it('non-socks5 proxy → warn', () => {
    fc.assert(fc.property(arbMailbox, fc.constantFrom('http://x', 'https://x', 'socks4://x'), (mb, url) => {
      const issues = parseConfigIssues({ ...mb, proxy_url: url })
      expect(issues.some(i => i.field === 'proxy_url' && i.severity === 'warn')).toBe(true)
    }))
  })
})
