// Sprint U2 — exhaustive truth-table coverage for classifyChecks().
//
// Targets all 2^4 = 16 combinations of:
//   preflight: ok / null
//   dnsAudit:  status='ok' / status='warn'
//   antiTrace: status='up'  / status='down'
//   engineBoot: status='ok' / status='stale'
//
// Plus boundary enum cases for skip/not_configured/timeout/unknown/down.
// Total: 16 truth-table + 11 boundary = 27 cases, plus 4 row-count sanity
// assertions = 31 it() blocks (well above the ≥25 target from the sprint
// brief and ≥10 from feedback_extreme_testing memory).
//
// Pure-function tests only — no React rendering, no fetch mocking.

import { describe, it, expect } from 'vitest'
import { classifyChecks } from '../../../src/lib/preflightChecks.js'

// ---------- fixtures ----------

const PFOK = {
  checks: [
    { name: 'proxy_assignments',     ok: true },
    { name: 'full_check_fresh',      ok: true },
    { name: 'suppression_populated', ok: true },
    { name: 'daily_capacity',        ok: true },
    { name: 'templates_valid',       ok: true },
  ],
}

const DNS_OK   = { status: 'ok' }
const DNS_WARN = { status: 'warn' }

const AT_UP   = { status: 'up' }
const AT_DOWN = { status: 'down' }

const EB_OK    = { status: 'ok' }
const EB_STALE = { status: 'stale' }

function build({ preflight = null, dns = null, at = null, eb = null }) {
  return classifyChecks({
    preflight,
    dnsAudit: dns,
    bottleneck: { antiTraceHealth: at, engineBootStatus: eb },
  })
}

function rowOk(rows, key) {
  const r = rows.find(x => x.key === key)
  if (!r) throw new Error(`row ${key} not found in [${rows.map(x => x.key).join(', ')}]`)
  return r.ok
}

function rowReason(rows, key) {
  const r = rows.find(x => x.key === key)
  return r ? r.reason : undefined
}

// ---------- 16 truth-table combinations ----------
//
// Naming convention: TT-<preflight><dns><at><eb>
//   P = preflight present (5 ok checks);  N = preflight null
//   O = dns ok;                            W = dns warn
//   U = antiTrace up;                      D = antiTrace down
//   O = engineBoot ok;                     S = engineBoot stale
//
// Expected row count:
//   P → 5 server rows + 3 extras = 8
//   N → 0 server rows + 3 extras = 3

describe('classifyChecks — truth table (U2)', () => {
  // 1. P-O-U-O — all green
  it('TT-1: preflight=ok, dns=ok, at=up, eb=ok → all 8 rows green', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_UP, eb: EB_OK })
    expect(rows.length).toBe(8)
    expect(rows.every(r => r.ok)).toBe(true)
    expect(rowOk(rows, 'dns_audit')).toBe(true)
    expect(rowOk(rows, 'anti_trace_health')).toBe(true)
    expect(rowOk(rows, 'engine_boot_status')).toBe(true)
  })

  // 2. P-O-U-S — engine stale only
  it('TT-2: preflight=ok, dns=ok, at=up, eb=stale → engine_boot fails', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_UP, eb: EB_STALE })
    expect(rows.length).toBe(8)
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
    expect(rowReason(rows, 'engine_boot_status')).toMatch(/zastaralý/)
    expect(rowOk(rows, 'dns_audit')).toBe(true)
    expect(rowOk(rows, 'anti_trace_health')).toBe(true)
  })

  // 3. P-O-D-O — anti-trace down only
  it('TT-3: preflight=ok, dns=ok, at=down, eb=ok → anti_trace fails', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_DOWN, eb: EB_OK })
    expect(rows.length).toBe(8)
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowReason(rows, 'anti_trace_health')).toMatch(/relay down/)
    expect(rowOk(rows, 'engine_boot_status')).toBe(true)
  })

  // 4. P-O-D-S — at down + eb stale
  it('TT-4: preflight=ok, dns=ok, at=down, eb=stale → anti_trace+engine_boot fail', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_DOWN, eb: EB_STALE })
    expect(rows.length).toBe(8)
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
    expect(rowOk(rows, 'dns_audit')).toBe(true)
  })

  // 5. P-W-U-O — dns warn only
  it('TT-5: preflight=ok, dns=warn, at=up, eb=ok → dns_audit fails', () => {
    const rows = build({ preflight: PFOK, dns: DNS_WARN, at: AT_UP, eb: EB_OK })
    expect(rows.length).toBe(8)
    expect(rowOk(rows, 'dns_audit')).toBe(false)
    expect(rowReason(rows, 'dns_audit')).toMatch(/varováním/)
    expect(rowOk(rows, 'anti_trace_health')).toBe(true)
    expect(rowOk(rows, 'engine_boot_status')).toBe(true)
  })

  // 6. P-W-U-S — dns warn + eb stale
  it('TT-6: preflight=ok, dns=warn, at=up, eb=stale → dns+engine_boot fail', () => {
    const rows = build({ preflight: PFOK, dns: DNS_WARN, at: AT_UP, eb: EB_STALE })
    expect(rows.length).toBe(8)
    expect(rowOk(rows, 'dns_audit')).toBe(false)
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
    expect(rowOk(rows, 'anti_trace_health')).toBe(true)
  })

  // 7. P-W-D-O — dns warn + at down
  it('TT-7: preflight=ok, dns=warn, at=down, eb=ok → dns+anti_trace fail', () => {
    const rows = build({ preflight: PFOK, dns: DNS_WARN, at: AT_DOWN, eb: EB_OK })
    expect(rows.length).toBe(8)
    expect(rowOk(rows, 'dns_audit')).toBe(false)
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowOk(rows, 'engine_boot_status')).toBe(true)
  })

  // 8. P-W-D-S — all 3 extras red, server still green
  it('TT-8: preflight=ok, dns=warn, at=down, eb=stale → server ok, all 3 extras fail', () => {
    const rows = build({ preflight: PFOK, dns: DNS_WARN, at: AT_DOWN, eb: EB_STALE })
    expect(rows.length).toBe(8)
    // server rows still green
    expect(rowOk(rows, 'proxy_assignments')).toBe(true)
    expect(rowOk(rows, 'full_check_fresh')).toBe(true)
    expect(rowOk(rows, 'suppression_populated')).toBe(true)
    expect(rowOk(rows, 'daily_capacity')).toBe(true)
    expect(rowOk(rows, 'templates_valid')).toBe(true)
    // all 3 extras red
    expect(rowOk(rows, 'dns_audit')).toBe(false)
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
  })

  // 9. N-O-U-O — preflight null, extras green
  it('TT-9: preflight=null, dns=ok, at=up, eb=ok → 3 rows, all green', () => {
    const rows = build({ preflight: null, dns: DNS_OK, at: AT_UP, eb: EB_OK })
    expect(rows.length).toBe(3)
    expect(rows.every(r => r.ok)).toBe(true)
  })

  // 10. N-O-U-S
  it('TT-10: preflight=null, dns=ok, at=up, eb=stale → 3 rows, eb fails', () => {
    const rows = build({ preflight: null, dns: DNS_OK, at: AT_UP, eb: EB_STALE })
    expect(rows.length).toBe(3)
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
    expect(rowOk(rows, 'dns_audit')).toBe(true)
    expect(rowOk(rows, 'anti_trace_health')).toBe(true)
  })

  // 11. N-O-D-O
  it('TT-11: preflight=null, dns=ok, at=down, eb=ok → 3 rows, at fails', () => {
    const rows = build({ preflight: null, dns: DNS_OK, at: AT_DOWN, eb: EB_OK })
    expect(rows.length).toBe(3)
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowOk(rows, 'engine_boot_status')).toBe(true)
  })

  // 12. N-O-D-S
  it('TT-12: preflight=null, dns=ok, at=down, eb=stale → 3 rows, at+eb fail', () => {
    const rows = build({ preflight: null, dns: DNS_OK, at: AT_DOWN, eb: EB_STALE })
    expect(rows.length).toBe(3)
    expect(rowOk(rows, 'dns_audit')).toBe(true)
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
  })

  // 13. N-W-U-O
  it('TT-13: preflight=null, dns=warn, at=up, eb=ok → 3 rows, dns fails', () => {
    const rows = build({ preflight: null, dns: DNS_WARN, at: AT_UP, eb: EB_OK })
    expect(rows.length).toBe(3)
    expect(rowOk(rows, 'dns_audit')).toBe(false)
    expect(rowOk(rows, 'anti_trace_health')).toBe(true)
    expect(rowOk(rows, 'engine_boot_status')).toBe(true)
  })

  // 14. N-W-U-S
  it('TT-14: preflight=null, dns=warn, at=up, eb=stale → 3 rows, dns+eb fail', () => {
    const rows = build({ preflight: null, dns: DNS_WARN, at: AT_UP, eb: EB_STALE })
    expect(rows.length).toBe(3)
    expect(rowOk(rows, 'dns_audit')).toBe(false)
    expect(rowOk(rows, 'anti_trace_health')).toBe(true)
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
  })

  // 15. N-W-D-O
  it('TT-15: preflight=null, dns=warn, at=down, eb=ok → 3 rows, dns+at fail', () => {
    const rows = build({ preflight: null, dns: DNS_WARN, at: AT_DOWN, eb: EB_OK })
    expect(rows.length).toBe(3)
    expect(rowOk(rows, 'dns_audit')).toBe(false)
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowOk(rows, 'engine_boot_status')).toBe(true)
  })

  // 16. N-W-D-S — worst case
  it('TT-16: preflight=null, dns=warn, at=down, eb=stale → 3 rows, all fail', () => {
    const rows = build({ preflight: null, dns: DNS_WARN, at: AT_DOWN, eb: EB_STALE })
    expect(rows.length).toBe(3)
    expect(rows.every(r => !r.ok)).toBe(true)
  })
})

// ---------- Boundary enum cases ----------

describe('classifyChecks — boundary enum cases (U2)', () => {
  // dnsAudit boundary
  it("BD-1: dnsAudit.status='skip' → dns_audit ok=true with 'žádné odesílací domény'", () => {
    const rows = build({ preflight: PFOK, dns: { status: 'skip' }, at: AT_UP, eb: EB_OK })
    expect(rowOk(rows, 'dns_audit')).toBe(true)
    expect(rowReason(rows, 'dns_audit')).toMatch(/žádné odesílací domény/)
  })

  it("BD-2: dnsAudit.status='ok' but missing latency_ms → still ok=true", () => {
    // classifyChecks ignores latency_ms entirely; this guards regression where
    // someone might add a latency-based gate without considering missing data.
    const rows = build({ preflight: PFOK, dns: { status: 'ok' /* no latency_ms */ }, at: AT_UP, eb: EB_OK })
    expect(rowOk(rows, 'dns_audit')).toBe(true)
    expect(rowReason(rows, 'dns_audit')).toBeNull()
  })

  it("BD-3: dnsAudit.status='error' (unrecognized non-warn fail) → ok=false with chyba reason", () => {
    const rows = build({ preflight: PFOK, dns: { status: 'error' }, at: AT_UP, eb: EB_OK })
    expect(rowOk(rows, 'dns_audit')).toBe(false)
    expect(rowReason(rows, 'dns_audit')).toMatch(/SPF\/DMARC chyba/)
  })

  it('BD-4: dnsAudit=null → ok=false with data nedostupná reason', () => {
    const rows = build({ preflight: PFOK, dns: null, at: AT_UP, eb: EB_OK })
    expect(rowOk(rows, 'dns_audit')).toBe(false)
    expect(rowReason(rows, 'dns_audit')).toMatch(/data nedostupná/)
  })

  // antiTrace boundary
  it("BD-5: antiTrace.status='not_configured' → reason mentions ANTI_TRACE", () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: { status: 'not_configured' }, eb: EB_OK })
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowReason(rows, 'anti_trace_health')).toMatch(/ANTI_TRACE/)
  })

  it("BD-6: antiTrace.status='timeout' → ok=false with relay timeout reason", () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: { status: 'timeout' }, eb: EB_OK })
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowReason(rows, 'anti_trace_health')).toMatch(/relay timeout/)
  })

  it("BD-7: antiTrace.status='unknown' → ok=false (data unavailable)", () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: { status: 'unknown' }, eb: EB_OK })
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowReason(rows, 'anti_trace_health')).toMatch(/data nedostupná/)
  })

  it('BD-8: antiTrace=null (bottleneck.antiTraceHealth missing) → ok=false data nedostupná', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: null, eb: EB_OK })
    expect(rowOk(rows, 'anti_trace_health')).toBe(false)
    expect(rowReason(rows, 'anti_trace_health')).toMatch(/data nedostupná/)
  })

  // engineBoot boundary
  it("BD-9: engineBoot.status='down' → reason includes 'down'", () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_UP, eb: { status: 'down' } })
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
    expect(rowReason(rows, 'engine_boot_status')).toMatch(/down/)
  })

  it("BD-10: engineBoot.status='unknown' → ok=false (data unavailable)", () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_UP, eb: { status: 'unknown' } })
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
    expect(rowReason(rows, 'engine_boot_status')).toMatch(/data nedostupná/)
  })

  it('BD-11: engineBoot=null → ok=false data nedostupná', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_UP, eb: null })
    expect(rowOk(rows, 'engine_boot_status')).toBe(false)
    expect(rowReason(rows, 'engine_boot_status')).toMatch(/data nedostupná/)
  })
})

// ---------- Row-shape & cardinality sanity ----------

describe('classifyChecks — row shape & cardinality (U2)', () => {
  it('SH-1: every row has {key, ok, label, reason} keys', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_UP, eb: EB_OK })
    for (const r of rows) {
      expect(r).toHaveProperty('key')
      expect(r).toHaveProperty('ok')
      expect(r).toHaveProperty('label')
      expect(r).toHaveProperty('reason')
      expect(typeof r.key).toBe('string')
      expect(typeof r.ok).toBe('boolean')
      expect(typeof r.label).toBe('string')
    }
  })

  it('SH-2: row keys are unique within result', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_UP, eb: EB_OK })
    const keys = rows.map(r => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('SH-3: extras come AFTER server rows (deterministic order)', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_UP, eb: EB_OK })
    const keys = rows.map(r => r.key)
    expect(keys).toEqual([
      'proxy_assignments',
      'full_check_fresh',
      'suppression_populated',
      'daily_capacity',
      'templates_valid',
      'dns_audit',
      'anti_trace_health',
      'engine_boot_status',
    ])
  })

  it('SH-4: ok=true rows always have reason=null (server checks)', () => {
    const rows = build({ preflight: PFOK, dns: DNS_OK, at: AT_UP, eb: EB_OK })
    for (const r of rows) {
      if (r.ok) expect(r.reason).toBeNull()
    }
  })

  it('SH-5: server-side ok=false propagates reason field from preflight payload', () => {
    const rows = classifyChecks({
      preflight: { checks: [
        { name: 'proxy_assignments', ok: false, reason: 'mailbox 3 missing proxy' },
        { name: 'full_check_fresh', ok: true },
        { name: 'suppression_populated', ok: true },
        { name: 'daily_capacity', ok: true },
        { name: 'templates_valid', ok: true },
      ]},
      dnsAudit: DNS_OK,
      bottleneck: { antiTraceHealth: AT_UP, engineBootStatus: EB_OK },
    })
    const proxy = rows.find(r => r.key === 'proxy_assignments')
    expect(proxy.ok).toBe(false)
    expect(proxy.reason).toBe('mailbox 3 missing proxy')
  })

  it('SH-6: fully-empty input → 3 extras, all ok=false, no throw', () => {
    expect(() => classifyChecks({})).not.toThrow()
    const rows = classifyChecks({})
    expect(rows.length).toBe(3)
    expect(rows.every(r => !r.ok)).toBe(true)
  })

  it('SH-7: preflight.checks not an array (malformed) → no server rows, only 3 extras', () => {
    const rows = classifyChecks({
      preflight: { checks: null },
      dnsAudit: DNS_OK,
      bottleneck: { antiTraceHealth: AT_UP, engineBootStatus: EB_OK },
    })
    expect(rows.length).toBe(3)
    expect(rows.map(r => r.key)).toEqual(['dns_audit', 'anti_trace_health', 'engine_boot_status'])
  })
})
