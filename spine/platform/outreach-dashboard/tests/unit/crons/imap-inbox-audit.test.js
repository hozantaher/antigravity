// imap-inbox-audit.test.js — 2026-05-18 hardening
//
// Covers the runImapInboxAuditCron module: gap calculation, notification
// emission helper, and the orchestrating cron loop. Pool + relay fetch
// are both mocked — no real DB or IMAP touched.
//
// Risk profile per feedback_extreme_testing: this is an observability
// cron that writes to mailbox_alerts + operator_audit_log. Mid-tier risk
// (no money or send mutation). 10+ cases covering happy + edge + error.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  computeGap,
  emitGapNotification,
  runImapInboxAuditCron,
  DEFAULT_GAP_THRESHOLD,
  DEFAULT_ENABLED,
} from '../../../src/crons/runImapInboxAuditCron.js'

// ── Hand-rolled mock pool: same shape as the contract tests. The handler
// closure receives (sql, args) and returns { rows } per query.
function makeMockPool(handler) {
  const calls = []
  return {
    calls,
    async query(sql, args) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      calls.push({ sql: normalized, args })
      const result = handler(normalized, args)
      return result || { rows: [] }
    },
  }
}

// ── computeGap pure helper ───────────────────────────────────────────────

describe('computeGap', () => {
  it('T-1: returns hasGap=false when unseen <= ingested + threshold', () => {
    const r = computeGap({ unseenTotal: 10, ingestedCount: 5, threshold: 10 })
    expect(r.hasGap).toBe(false)
    expect(r.gap).toBe(5)
  })

  it('T-2: returns hasGap=true when unseen - ingested > threshold', () => {
    const r = computeGap({ unseenTotal: 220, ingestedCount: 3, threshold: 10 })
    expect(r.hasGap).toBe(true)
    expect(r.gap).toBe(217)  // mirrors the 2026-05-18 incident numbers
  })

  it('T-3: threshold boundary is strict — gap == threshold does NOT fire', () => {
    const r = computeGap({ unseenTotal: 20, ingestedCount: 10, threshold: 10 })
    expect(r.gap).toBe(10)
    expect(r.hasGap).toBe(false)
  })

  it('T-4: threshold boundary — gap == threshold + 1 DOES fire', () => {
    const r = computeGap({ unseenTotal: 21, ingestedCount: 10, threshold: 10 })
    expect(r.gap).toBe(11)
    expect(r.hasGap).toBe(true)
  })

  it('T-5: tolerates non-numeric inputs by defaulting to 0', () => {
    const r = computeGap({ unseenTotal: 'abc', ingestedCount: null, threshold: 10 })
    expect(r.gap).toBe(0)
    expect(r.hasGap).toBe(false)
  })

  it('T-6: negative gap (ingested > unseen) never fires', () => {
    const r = computeGap({ unseenTotal: 2, ingestedCount: 50, threshold: 10 })
    expect(r.gap).toBe(-48)
    expect(r.hasGap).toBe(false)
  })

  it('T-7: missing threshold falls back to DEFAULT_GAP_THRESHOLD', () => {
    const r = computeGap({ unseenTotal: DEFAULT_GAP_THRESHOLD + 5, ingestedCount: 0, threshold: undefined })
    expect(r.hasGap).toBe(true)
  })
})

// ── emitGapNotification helper ──────────────────────────────────────────

describe('emitGapNotification', () => {
  it('T-8: writes a mailbox_alerts row + operator_audit_log row in one call', async () => {
    const pool = makeMockPool(() => ({ rows: [] }))
    await emitGapNotification(pool, {
      mailboxId:      42,
      mailboxAddress: 'someone@seznam.cz',
      unseen:         217,
      ingested:       3,
      gap:            214,
      threshold:      10,
    })
    const alertCall = pool.calls.find(c => c.sql.includes('INSERT INTO mailbox_alerts'))
    const auditCall = pool.calls.find(c => c.sql.includes('INSERT INTO operator_audit_log'))
    expect(alertCall).toBeDefined()
    expect(auditCall).toBeDefined()
    expect(alertCall.args[0]).toBe(42)
    expect(alertCall.args[1]).toContain('gap=214')
    expect(alertCall.args[1]).toContain('threshold=10')
    expect(auditCall.args[0]).toBe('42')  // entity_id is text
    const details = JSON.parse(auditCall.args[1])
    expect(details.unseen).toBe(217)
    expect(details.ingested).toBe(3)
    expect(details.gap).toBe(214)
    expect(details.threshold).toBe(10)
    expect(details.mailbox_address_domain).toBe('seznam.cz')
  })

  it('T-9: redacts the mailbox local-part in the alert message', async () => {
    const pool = makeMockPool(() => ({ rows: [] }))
    await emitGapNotification(pool, {
      mailboxId:      7,
      mailboxAddress: 'sensitive.local.part@example.com',
      unseen:         100,
      ingested:       0,
      gap:            100,
      threshold:      10,
    })
    const alertCall = pool.calls.find(c => c.sql.includes('INSERT INTO mailbox_alerts'))
    expect(alertCall).toBeDefined()
    // local-part must NOT appear in the human-readable message; only the domain.
    expect(alertCall.args[1]).not.toContain('sensitive.local.part')
    expect(alertCall.args[1]).toContain('***@example.com')
  })

  it('T-10: tolerates missing mailbox_address (yields <mailbox> placeholder)', async () => {
    const pool = makeMockPool(() => ({ rows: [] }))
    await emitGapNotification(pool, {
      mailboxId:      7,
      mailboxAddress: '',
      unseen:         50,
      ingested:       0,
      gap:            50,
      threshold:      10,
    })
    const alertCall = pool.calls.find(c => c.sql.includes('INSERT INTO mailbox_alerts'))
    expect(alertCall.args[1]).toContain('<mailbox>')
  })

  it('T-11: alert INSERT failure does NOT block the audit log INSERT', async () => {
    let alertAttempts = 0
    let auditAttempts = 0
    const pool = {
      calls: [],
      async query(sql) {
        const s = String(sql)
        if (s.includes('INSERT INTO mailbox_alerts')) {
          alertAttempts++
          throw new Error('boom — alerts table missing')
        }
        if (s.includes('INSERT INTO operator_audit_log')) {
          auditAttempts++
          return { rows: [] }
        }
        return { rows: [] }
      },
    }
    await emitGapNotification(pool, {
      mailboxId: 1, mailboxAddress: 'a@b.cz',
      unseen: 30, ingested: 5, gap: 25, threshold: 10,
    })
    expect(alertAttempts).toBe(1)
    expect(auditAttempts).toBe(1)
  })
})

// ── runImapInboxAuditCron orchestrator ──────────────────────────────────

describe('runImapInboxAuditCron', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('T-12: bails out early when imap_inbox_audit_enabled = false', async () => {
    const pool = makeMockPool((sql, args) => {
      // The SQL is parameterised — the key lives in args[0], not the SQL text.
      if (sql.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_enabled') {
        return { rows: [{ value: 'false' }] }
      }
      return { rows: [] }
    })
    const relayImapFetch = vi.fn()
    const summary = await runImapInboxAuditCron(pool, { relayImapFetch })
    expect(summary.enabled).toBe(false)
    expect(summary.scanned).toBe(0)
    expect(relayImapFetch).not.toHaveBeenCalled()
  })

  it('T-13: scans every active production mailbox and counts scanned correctly', async () => {
    const pool = makeMockPool((sql, args) => {
      if (sql.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_enabled') return { rows: [{ value: 'true' }] }
      if (sql.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_gap_threshold') return { rows: [{ value: '10' }] }
      if (sql.includes('FROM outreach_mailboxes')) {
        return {
          rows: [
            { id: 1, from_address: 'a@seznam.cz', imap_host: 'imap.seznam.cz', imap_port: 993, imap_username: 'a', smtp_username: 'a', password: 'p', preferred_country: 'CZ' },
            { id: 2, from_address: 'b@seznam.cz', imap_host: 'imap.seznam.cz', imap_port: 993, imap_username: 'b', smtp_username: 'b', password: 'p', preferred_country: 'CZ' },
          ],
        }
      }
      if (sql.includes('FROM reply_inbox')) return { rows: [{ c: 5 }] }
      return { rows: [] }
    })
    const relayImapFetch = vi.fn().mockResolvedValue({ ok: true, unseen_total: 7, messages: [] })
    const summary = await runImapInboxAuditCron(pool, { relayImapFetch })
    expect(summary.enabled).toBe(true)
    expect(summary.scanned).toBe(2)
    expect(summary.gapped).toBe(0)
    expect(relayImapFetch).toHaveBeenCalledTimes(2)
  })

  it('T-14: emits a notification when a mailbox crosses the threshold', async () => {
    let alertInserts = 0
    let auditInserts = 0
    const pool = {
      async query(sql, args) {
        const s = String(sql).replace(/\s+/g, ' ').trim()
        if (s.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_enabled') return { rows: [{ value: 'true' }] }
        if (s.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_gap_threshold') return { rows: [{ value: '10' }] }
        if (s.includes('FROM outreach_mailboxes')) {
          return {
            rows: [{
              id: 99, from_address: 'c@seznam.cz', imap_host: 'imap.seznam.cz',
              imap_port: 993, imap_username: 'c', smtp_username: 'c',
              password: 'p', preferred_country: 'CZ',
            }],
          }
        }
        if (s.includes('FROM reply_inbox')) return { rows: [{ c: 3 }] }
        if (s.includes('INSERT INTO mailbox_alerts')) { alertInserts++; return { rows: [] } }
        if (s.includes('INSERT INTO operator_audit_log')) { auditInserts++; return { rows: [] } }
        return { rows: [] }
      },
    }
    const relayImapFetch = vi.fn().mockResolvedValue({ ok: true, unseen_total: 217, messages: [] })
    const sentryCalls = []
    const Sentry = {
      captureMessage: (msg, ctx) => { sentryCalls.push({ msg, ctx }) },
    }
    const summary = await runImapInboxAuditCron(pool, { relayImapFetch, Sentry })
    expect(summary.gapped).toBe(1)
    expect(alertInserts).toBe(1)
    expect(auditInserts).toBe(1)
    expect(sentryCalls).toHaveLength(1)
    expect(sentryCalls[0].ctx.tags.mailbox_id).toBe('99')
  })

  it('T-15: relay fetch failure increments skipped, does not emit alert', async () => {
    let alertInserts = 0
    const pool = {
      async query(sql, args) {
        const s = String(sql).replace(/\s+/g, ' ').trim()
        if (s.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_enabled') return { rows: [{ value: 'true' }] }
        if (s.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_gap_threshold') return { rows: [{ value: '10' }] }
        if (s.includes('FROM outreach_mailboxes')) {
          return { rows: [{
            id: 1, from_address: 'x@seznam.cz', imap_host: 'h',
            imap_port: 993, imap_username: 'x', smtp_username: 'x',
            password: 'p', preferred_country: 'CZ',
          }] }
        }
        if (s.includes('INSERT INTO mailbox_alerts')) { alertInserts++; return { rows: [] } }
        return { rows: [] }
      },
    }
    const relayImapFetch = vi.fn().mockResolvedValue({ ok: false, error: 'timeout', unseen_total: 0 })
    const summary = await runImapInboxAuditCron(pool, { relayImapFetch })
    expect(summary.skipped).toBe(1)
    expect(summary.scanned).toBe(0)
    expect(summary.gapped).toBe(0)
    expect(alertInserts).toBe(0)
  })

  it('T-16: relay fetch thrown error increments skipped, never throws upstream', async () => {
    let alertInserts = 0
    const pool = {
      async query(sql, args) {
        const s = String(sql).replace(/\s+/g, ' ').trim()
        if (s.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_enabled') return { rows: [{ value: 'true' }] }
        if (s.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_gap_threshold') return { rows: [{ value: '10' }] }
        if (s.includes('FROM outreach_mailboxes')) {
          return { rows: [{
            id: 1, from_address: 'x@seznam.cz', imap_host: 'h',
            imap_port: 993, imap_username: 'x', smtp_username: 'x',
            password: 'p', preferred_country: 'CZ',
          }] }
        }
        if (s.includes('INSERT INTO mailbox_alerts')) { alertInserts++; return { rows: [] } }
        return { rows: [] }
      },
    }
    const relayImapFetch = vi.fn().mockRejectedValue(new Error('network down'))
    await expect(runImapInboxAuditCron(pool, { relayImapFetch })).resolves.toBeDefined()
    expect(alertInserts).toBe(0)
  })

  it('T-17: missing relayImapFetch dep returns early with no work done', async () => {
    const pool = makeMockPool((sql, args) => {
      if (sql.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_enabled') return { rows: [{ value: 'true' }] }
      if (sql.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_gap_threshold') return { rows: [{ value: '10' }] }
      return { rows: [] }
    })
    const summary = await runImapInboxAuditCron(pool, {})  // no relayImapFetch
    expect(summary.scanned).toBe(0)
    expect(summary.enabled).toBe(true)
  })

  it('T-18: falls back to DEFAULT_GAP_THRESHOLD when operator_settings row missing', async () => {
    // unseen=15, ingested=3, gap=12 → would NOT fire at default (10) since 12 > 10
    // is true → SHOULD fire. Confirms the default is wired through.
    let alertInserts = 0
    const pool = {
      async query(sql, args) {
        const s = String(sql).replace(/\s+/g, ' ').trim()
        if (s.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_enabled') return { rows: [] }  // missing
        if (s.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_gap_threshold') return { rows: [] }  // missing
        if (s.includes('FROM outreach_mailboxes')) {
          return { rows: [{
            id: 1, from_address: 'x@seznam.cz', imap_host: 'h',
            imap_port: 993, imap_username: 'x', smtp_username: 'x',
            password: 'p', preferred_country: 'CZ',
          }] }
        }
        if (s.includes('FROM reply_inbox')) return { rows: [{ c: 3 }] }
        if (s.includes('INSERT INTO mailbox_alerts')) { alertInserts++; return { rows: [] } }
        return { rows: [] }
      },
    }
    const relayImapFetch = vi.fn().mockResolvedValue({ ok: true, unseen_total: 15, messages: [] })
    const summary = await runImapInboxAuditCron(pool, { relayImapFetch })
    expect(summary.enabled).toBe(DEFAULT_ENABLED)
    expect(summary.gapped).toBe(1)
    expect(alertInserts).toBe(1)
  })

  it('T-19: empty mailbox set returns zero-summary without errors', async () => {
    const pool = makeMockPool((sql, args) => {
      if (sql.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_enabled') return { rows: [{ value: 'true' }] }
      if (sql.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_gap_threshold') return { rows: [{ value: '10' }] }
      return { rows: [] }
    })
    const relayImapFetch = vi.fn()
    const summary = await runImapInboxAuditCron(pool, { relayImapFetch })
    expect(summary.scanned).toBe(0)
    expect(summary.gapped).toBe(0)
    expect(summary.skipped).toBe(0)
    expect(relayImapFetch).not.toHaveBeenCalled()
  })

  it('T-20: mailbox query includes status=active AND environment=production filters', async () => {
    // Verify the SQL contract — this is what protects us from accidentally
    // scanning retired/paused/auth_locked mailboxes (PII + wrong creds).
    const pool = makeMockPool((sql, args) => {
      if (sql.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_enabled') return { rows: [{ value: 'true' }] }
      if (sql.includes('FROM operator_settings') && args?.[0] === 'imap_inbox_audit_gap_threshold') return { rows: [{ value: '10' }] }
      return { rows: [] }
    })
    const relayImapFetch = vi.fn()
    await runImapInboxAuditCron(pool, { relayImapFetch })
    const mbCall = pool.calls.find(c => c.sql.includes('FROM outreach_mailboxes'))
    expect(mbCall).toBeDefined()
    expect(mbCall.sql).toMatch(/status\s*=\s*'active'/i)
    expect(mbCall.sql).toMatch(/environment\s*=\s*'production'/i)
    expect(mbCall.sql).toMatch(/imap_host IS NOT NULL/i)
  })
})
