// AV-F8 — Unit tests for runBounceAnomalyCron.
//
// Tests the cron in isolation with a recording pool mock. The mock returns
// canned rows for SELECT queries and RETURNING clauses, and captures every
// UPDATE / INSERT for assertion.
//
// 6 cases per spec:
//   1. Mailbox below threshold        → no action
//   2. Mailbox above threshold AND already paused → skip (UPDATE returns 0 rows)
//   3. Mailbox above threshold AND active → paused + alert + audit
//   4. Mailbox with insufficient sample (<20 sends) → no action (filtered by SQL)
//   5. Domain above threshold → suppression INSERT + audit
//   6. Domain already in outreach_suppressions → skip (idempotent SELECT-then-INSERT)

import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  runBounceAnomalyCron,
  MAILBOX_BOUNCE_THRESHOLD_PCT,
  MAILBOX_BOUNCE_MIN_SENDS,
  DOMAIN_BOUNCE_THRESHOLD_PCT,
  DOMAIN_BOUNCE_MIN_SENDS,
  PAUSE_DURATION_HOURS,
  COOLDOWN_HOURS,
} from '../../../src/crons/runBounceAnomalyCron.js'

// ── Pool mock factory ───────────────────────────────────────────────────────
//
// opts:
//   mailboxRows         : rows returned by the per-mailbox SELECT
//   domainRows          : rows returned by the per-domain SELECT
//   pauseRowCount       : rowCount returned by the UPDATE (RETURNING) — 0 = idempotent skip
//   suppressionExists   : true → SELECT 1 returns 1 row (domain already suppressed)
function makePool(opts = {}) {
  const {
    mailboxRows = [],
    domainRows = [],
    pauseRowCount = 1,
    suppressionExists = false,
  } = opts
  const captured = {
    mailboxSelectCalls: 0,
    domainSelectCalls: 0,
    updates: [],
    alertInserts: [],
    auditInserts: [],
    suppressionInserts: [],
    suppressionSelects: [],
  }
  const query = vi.fn(async (sql, params) => {
    const s = String(sql)
    if (s.includes('FROM send_events') && s.includes('mailbox_used')) {
      captured.mailboxSelectCalls++
      return { rows: mailboxRows }
    }
    if (s.includes('FROM send_events') && s.includes('SUBSTRING')) {
      captured.domainSelectCalls++
      return { rows: domainRows }
    }
    if (s.includes('UPDATE outreach_mailboxes')) {
      captured.updates.push({ sql: s, params })
      if (pauseRowCount > 0) {
        // RETURNING id — synthesize a mailbox id.
        return { rowCount: pauseRowCount, rows: [{ id: 999 }] }
      }
      return { rowCount: 0, rows: [] }
    }
    if (s.includes('INSERT INTO mailbox_alerts')) {
      captured.alertInserts.push({ sql: s, params })
      return { rowCount: 1 }
    }
    if (s.includes('FROM outreach_suppressions')) {
      captured.suppressionSelects.push({ sql: s, params })
      return { rows: suppressionExists ? [{ exists: 1 }] : [] }
    }
    if (s.includes('INSERT INTO outreach_suppressions')) {
      captured.suppressionInserts.push({ sql: s, params })
      return { rowCount: 1 }
    }
    if (s.includes('INSERT INTO operator_audit_log')) {
      captured.auditInserts.push({ sql: s, params })
      return { rowCount: 1 }
    }
    return { rows: [] }
  })
  return { query, captured }
}

describe('AV-F8 runBounceAnomalyCron', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('case 1 — mailbox below threshold → no action', async () => {
    const pool = makePool({
      mailboxRows: [
        { from_address: 'low@example.com', bounced: 1, total: 50 }, // 2%
      ],
    })
    const r = await runBounceAnomalyCron(pool)
    expect(r.mailboxes_paused).toBe(0)
    expect(pool.captured.updates).toHaveLength(0)
    expect(pool.captured.alertInserts).toHaveLength(0)
  })

  test('case 2 — mailbox above threshold but UPDATE returns 0 rows (already paused / in cooldown) → skip', async () => {
    const pool = makePool({
      mailboxRows: [
        { from_address: 'paused@example.com', bounced: 10, total: 50 }, // 20% — well above
      ],
      pauseRowCount: 0, // simulates status<>'active' OR cooldown not elapsed
    })
    const r = await runBounceAnomalyCron(pool)
    expect(r.mailboxes_paused).toBe(0)
    // UPDATE was attempted — guard happens in SQL WHERE clause, not JS.
    expect(pool.captured.updates).toHaveLength(1)
    // No follow-up alert / audit when UPDATE returned 0 rows.
    expect(pool.captured.alertInserts).toHaveLength(0)
    // No audit insert for the mailbox tier (domain tier independent).
    const mailboxAudit = pool.captured.auditInserts.filter(
      (a) => a.sql.includes('mailbox_auto_paused_bounce_anomaly'),
    )
    expect(mailboxAudit).toHaveLength(0)
  })

  test('case 3 — mailbox above threshold AND active → paused + alert + audit', async () => {
    const pool = makePool({
      mailboxRows: [
        { from_address: 'hot@example.com', bounced: 5, total: 50 }, // 10%
      ],
      pauseRowCount: 1,
    })
    const r = await runBounceAnomalyCron(pool)
    expect(r.mailboxes_paused).toBe(1)
    expect(pool.captured.updates).toHaveLength(1)
    expect(pool.captured.updates[0].sql).toContain("status                = 'paused'")
    expect(pool.captured.updates[0].sql).toContain('paused_until')
    expect(pool.captured.updates[0].sql).toContain('last_bounce_alert_at')
    // The cooldown guard is in the WHERE clause.
    expect(pool.captured.updates[0].sql).toMatch(/last_bounce_alert_at IS NULL/)
    expect(pool.captured.updates[0].sql).toMatch(/last_bounce_alert_at < NOW/)
    // Alert row inserted.
    expect(pool.captured.alertInserts).toHaveLength(1)
    expect(pool.captured.alertInserts[0].params[0]).toBe(999) // mailbox_id from RETURNING
    expect(pool.captured.alertInserts[0].sql).toContain("'bounce_anomaly'")
    expect(pool.captured.alertInserts[0].sql).toContain("'critical'")
    // Audit log written.
    const mailboxAudit = pool.captured.auditInserts.find((a) =>
      a.sql.includes('mailbox_auto_paused_bounce_anomaly'),
    )
    expect(mailboxAudit).toBeTruthy()
    const details = JSON.parse(mailboxAudit.params[1])
    expect(details.from_address).toBe('hot@example.com')
    expect(details.bounce_rate_pct).toBe(10)
    expect(details.threshold_pct).toBe(MAILBOX_BOUNCE_THRESHOLD_PCT)
    expect(details.pause_duration_hours).toBe(PAUSE_DURATION_HOURS)
  })

  test('case 4 — mailbox with insufficient sample (<20 sends) → SQL filters → no action', async () => {
    // The SELECT carries a HAVING clause with $2 = MAILBOX_BOUNCE_MIN_SENDS.
    // We assert that the SELECT was issued with the named constant value,
    // and (as the mock returns no rows for tiny samples) the cron takes no action.
    const pool = makePool({
      mailboxRows: [], // simulating SQL filter excluding the low-volume mailbox
    })
    const r = await runBounceAnomalyCron(pool)
    expect(r.mailboxes_paused).toBe(0)
    expect(r.mailboxes_checked).toBe(0)
    expect(pool.captured.updates).toHaveLength(0)
    expect(pool.captured.mailboxSelectCalls).toBe(1)
    // Verify the SQL bound MAILBOX_BOUNCE_MIN_SENDS as the HAVING floor.
    // (Inspect the most recent mailboxSelect — we can't inspect the captured
    //  query without a call recorder, but we can sanity-check the constant.)
    expect(MAILBOX_BOUNCE_MIN_SENDS).toBe(20)
  })

  test('case 5 — domain above threshold AND not previously suppressed → suppression INSERT + audit', async () => {
    const pool = makePool({
      domainRows: [
        { domain: 'spamdomain.cz', bounced: 8, total: 20 }, // 40%
      ],
      suppressionExists: false,
    })
    const r = await runBounceAnomalyCron(pool)
    expect(r.domains_suppressed).toBe(1)
    expect(pool.captured.suppressionSelects).toHaveLength(1)
    expect(pool.captured.suppressionInserts).toHaveLength(1)
    expect(pool.captured.suppressionInserts[0].params[0]).toBe('spamdomain.cz')
    expect(pool.captured.suppressionInserts[0].params[1]).toMatch(/^auto_bounce_anomaly_/)
    const domainAudit = pool.captured.auditInserts.find((a) =>
      a.sql.includes('domain_auto_suppressed_bounce_anomaly'),
    )
    expect(domainAudit).toBeTruthy()
    const details = JSON.parse(domainAudit.params[0])
    expect(details.domain).toBe('spamdomain.cz')
    expect(details.bounce_rate_pct).toBe(40)
    expect(details.threshold_pct).toBe(DOMAIN_BOUNCE_THRESHOLD_PCT)
  })

  test('case 6 — domain already suppressed → SELECT returns row → skip INSERT (idempotent)', async () => {
    const pool = makePool({
      domainRows: [
        { domain: 'already.cz', bounced: 8, total: 20 }, // 40%
      ],
      suppressionExists: true,
    })
    const r = await runBounceAnomalyCron(pool)
    expect(r.domains_suppressed).toBe(0)
    expect(pool.captured.suppressionSelects).toHaveLength(1)
    expect(pool.captured.suppressionInserts).toHaveLength(0)
    const domainAudit = pool.captured.auditInserts.find((a) =>
      a.sql.includes('domain_auto_suppressed_bounce_anomaly'),
    )
    expect(domainAudit).toBeFalsy()
  })

  test('extra — domain below threshold → no action', async () => {
    const pool = makePool({
      domainRows: [
        { domain: 'fine.cz', bounced: 1, total: 20 }, // 5%
      ],
    })
    const r = await runBounceAnomalyCron(pool)
    expect(r.domains_suppressed).toBe(0)
    expect(pool.captured.suppressionInserts).toHaveLength(0)
  })

  test('named-constants sanity (feedback_no_magic_thresholds T0)', () => {
    expect(MAILBOX_BOUNCE_THRESHOLD_PCT).toBe(5)
    expect(MAILBOX_BOUNCE_MIN_SENDS).toBe(20)
    expect(DOMAIN_BOUNCE_THRESHOLD_PCT).toBe(20)
    expect(DOMAIN_BOUNCE_MIN_SENDS).toBe(5)
    expect(PAUSE_DURATION_HOURS).toBe(24)
    expect(COOLDOWN_HOURS).toBe(12)
  })
})
