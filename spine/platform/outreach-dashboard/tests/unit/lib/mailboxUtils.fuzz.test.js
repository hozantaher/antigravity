// Fuzz tests — random/adversarial inputs at the parser surface.
// Goal: never crash, always return a well-formed result.
// Different signal from properties: we don't assert behavior, only stability.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  parseSmtpCheckResult,
  parseImapCheckResult,
  parseConfigIssues,
  analyzeHeaderAnonymity,
  buildFullCheckSummary,
} from '../../../src/lib/mailboxUtils.js'

// ── Adversarial inputs: anything goes ────────────────────────────────
const arbAnything = fc.anything({
  withBigInt: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withTypedArray: true,
})

// SMTP/IMAP step shape: name + ok, but with deliberate noise
const arbStep = fc.record({
  name: fc.oneof(fc.string(), fc.constant(undefined), fc.constant(null), fc.constant('')),
  ok: fc.oneof(fc.boolean(), fc.constant(undefined), fc.constant(null), fc.integer()),
  msg: fc.option(fc.oneof(fc.string({ maxLength: 500 }), fc.constant(undefined))),
}, { requiredKeys: [] })

const arbSteps = fc.option(fc.array(arbStep, { maxLength: 30 }), { nil: undefined })

describe('parseSmtpCheckResult (fuzz)', () => {
  it('never throws on arbitrary input', () => {
    fc.assert(fc.property(arbAnything, (input) => {
      try { parseSmtpCheckResult(input) } catch { return false }
      return true
    }), { numRuns: 500 })
  })

  it('result is always shaped {ok, failStep, failMsg}', () => {
    fc.assert(fc.property(arbSteps, (steps) => {
      const r = parseSmtpCheckResult(steps)
      expect(typeof r).toBe('object')
      expect(r).not.toBeNull()
      expect('ok' in r).toBe(true)
      expect('failStep' in r).toBe(true)
      expect('failMsg' in r).toBe(true)
    }), { numRuns: 200 })
  })
})

describe('parseImapCheckResult (fuzz)', () => {
  it('never throws on arbitrary input', () => {
    fc.assert(fc.property(arbAnything, (input) => {
      try { parseImapCheckResult(input) } catch { return false }
      return true
    }), { numRuns: 500 })
  })
})

// ── parseConfigIssues — adversarial mailbox shapes ───────────────────
const arbMailboxNoise = fc.record({
  password: fc.option(arbAnything, { nil: undefined }),
  smtp_host: fc.option(arbAnything, { nil: undefined }),
  smtp_username: fc.option(arbAnything, { nil: undefined }),
  smtp_port: fc.option(fc.oneof(fc.integer(), fc.string(), fc.float(), fc.constant(NaN), fc.constant(Infinity), fc.constant(-1)), { nil: undefined }),
  daily_cap_override: fc.option(fc.oneof(fc.integer(), fc.string(), fc.constant(0), fc.constant(-5)), { nil: undefined }),
  imap_host: fc.option(arbAnything, { nil: undefined }),
  imap_username: fc.option(arbAnything, { nil: undefined }),
  imap_port: fc.option(fc.oneof(fc.integer(), fc.string()), { nil: undefined }),
  proxy_url: fc.option(fc.oneof(
    fc.constant('socks5://1.2.3.4:1080'),
    fc.constant('http://1.2.3.4:8080'),
    fc.constant('not a url'),
    fc.constant(''),
    fc.string(),
  ), { nil: undefined }),
}, { requiredKeys: [] })

describe('parseConfigIssues (fuzz)', () => {
  it('never throws on adversarial mailbox', () => {
    fc.assert(fc.property(arbMailboxNoise, (mb) => {
      try { parseConfigIssues(mb) } catch { return false }
      return true
    }), { numRuns: 500 })
  })

  it('always returns array of well-formed issue objects', () => {
    fc.assert(fc.property(arbMailboxNoise, (mb) => {
      const issues = parseConfigIssues(mb)
      expect(Array.isArray(issues)).toBe(true)
      for (const it of issues) {
        expect(typeof it.field).toBe('string')
        expect(['critical', 'warn']).toContain(it.severity)
        expect(typeof it.msg).toBe('string')
      }
    }), { numRuns: 200 })
  })

  it('rejects non-socks5 proxy schemes (http, ftp, ws…)', () => {
    fc.assert(fc.property(
      fc.constantFrom('http', 'https', 'ftp', 'ws', 'wss', 'gopher'),
      (scheme) => {
        const issues = parseConfigIssues({
          password: 'x', smtp_host: 'h', smtp_username: 'u', smtp_port: 587,
          proxy_url: `${scheme}://1.2.3.4:8080`,
        })
        const proxyIssue = issues.find(i => i.field === 'proxy_url')
        expect(proxyIssue).toBeDefined()
        expect(proxyIssue.severity).toBe('warn')
      }
    ), { numRuns: 50 })
  })
})

// ── analyzeHeaderAnonymity — adversarial header strings ──────────────
describe('analyzeHeaderAnonymity (fuzz)', () => {
  it('never throws on arbitrary header string', () => {
    fc.assert(fc.property(fc.string({ maxLength: 5000 }), (headers) => {
      try { analyzeHeaderAnonymity(headers) } catch { return false }
      return true
    }), { numRuns: 500 })
  })

  it('survives null / undefined / non-string', () => {
    fc.assert(fc.property(arbAnything, (x) => {
      try { analyzeHeaderAnonymity(x) } catch { return false }
      return true
    }), { numRuns: 200 })
  })

  it('control characters in headers do not crash', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 31 }), { minLength: 1, maxLength: 200 }),
      (codes) => {
        const s = String.fromCharCode(...codes)
        try { analyzeHeaderAnonymity(s) } catch { return false }
        return true
      }
    ), { numRuns: 100 })
  })

  it('extremely long header (10k chars) does not crash or hang', () => {
    const huge = 'X-Forwarded-For: 1.1.1.1\n'.repeat(500)
    const start = Date.now()
    const r = analyzeHeaderAnonymity(huge)
    expect(Date.now() - start).toBeLessThan(1000) // <1s for 12kb
    expect(typeof r.score).toBe('number')
  })
})

// ── buildFullCheckSummary — fuzz against random check rows ───────────
const arbCheckRow = fc.record({
  ok: fc.option(fc.boolean(), { nil: undefined }),
  fail_step: fc.option(fc.string({ maxLength: 50 }), { nil: null }),
  fail_msg: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
}, { requiredKeys: [] })

const arbChecks = fc.record({
  smtp: fc.option(arbCheckRow, { nil: null }),
  imap: fc.option(arbCheckRow, { nil: null }),
  config: fc.option(arbCheckRow, { nil: null }),
  proxy: fc.option(arbCheckRow, { nil: null }),
  anti_trace: fc.option(arbCheckRow, { nil: null }),
  warmup: fc.option(arbCheckRow, { nil: null }),
  bounce: fc.option(arbCheckRow, { nil: null }),
  send_rate: fc.option(arbCheckRow, { nil: null }),
  pipeline: fc.option(arbCheckRow, { nil: null }),
})

describe('buildFullCheckSummary (fuzz)', () => {
  it('never throws on partial/random check inputs', () => {
    fc.assert(fc.property(arbChecks, (checks) => {
      try { buildFullCheckSummary(checks) } catch { return false }
      return true
    }), { numRuns: 500 })
  })

  it('always returns summary with score in [0, 100]', () => {
    fc.assert(fc.property(arbChecks, (checks) => {
      const r = buildFullCheckSummary(checks)
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(100)
      expect(Number.isInteger(r.score)).toBe(true)
    }), { numRuns: 200 })
  })
})
