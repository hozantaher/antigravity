// AJ9 (2026-05-15) — preflightChecks helper tests (former PreflightGateModal.test.jsx).
// Modal body deleted; classifyChecks moved to src/lib/preflightChecks.js.

import { describe, it, expect } from 'vitest'
import { classifyChecks } from '../../../src/lib/preflightChecks.js'

describe('preflightChecks — classifyChecks pure logic', () => {
  it('returns 8 rows when all data present', () => {
    const rows = classifyChecks({
      preflight: { checks: [
        { name: 'proxy_assignments', ok: true },
        { name: 'full_check_fresh', ok: true },
        { name: 'suppression_populated', ok: true },
        { name: 'daily_capacity', ok: true },
        { name: 'templates_valid', ok: true },
      ]},
      dnsAudit: { status: 'ok' },
      bottleneck: { antiTraceHealth: { status: 'up' }, engineBootStatus: { status: 'ok' } },
    })
    expect(rows.length).toBe(8)
    expect(rows.every(r => r.ok)).toBe(true)
  })

  it('marks dns_audit failed when status=warn', () => {
    const rows = classifyChecks({ preflight: null, dnsAudit: { status: 'warn' }, bottleneck: null })
    const dns = rows.find(r => r.key === 'dns_audit')
    expect(dns.ok).toBe(false)
  })

  it('marks dns_audit ok when status=skip (no domains)', () => {
    const rows = classifyChecks({ preflight: null, dnsAudit: { status: 'skip' }, bottleneck: null })
    const dns = rows.find(r => r.key === 'dns_audit')
    expect(dns.ok).toBe(true)
  })

  it('marks anti-trace failed when not_configured', () => {
    const rows = classifyChecks({
      preflight: null,
      dnsAudit: null,
      bottleneck: { antiTraceHealth: { status: 'not_configured' } },
    })
    expect(rows.find(r => r.key === 'anti_trace_health').ok).toBe(false)
    expect(rows.find(r => r.key === 'anti_trace_health').reason).toMatch(/ANTI_TRACE/)
  })

  it('marks engine_boot stale → failed', () => {
    const rows = classifyChecks({
      preflight: null,
      dnsAudit: null,
      bottleneck: { engineBootStatus: { status: 'stale' } },
    })
    expect(rows.find(r => r.key === 'engine_boot_status').ok).toBe(false)
  })

  it('handles fully missing data without throwing', () => {
    expect(() => classifyChecks({ preflight: null, dnsAudit: null, bottleneck: null })).not.toThrow()
  })
})
