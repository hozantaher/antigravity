// contactVerifyCron.js — Sprint AM2 + Sprint J (tier-priority ordering)
// ─────────────────────────────────────────────────────────────────────────────
// Hourly contact email-verify loop.
//
// Feature-flagged: VERIFY_LOOP_CONTACTS_ENABLED=true must be set by operator
// AFTER AM3 (operator surface) ships. Default is disabled.
//
// Picks contacts due for verification (email_verify_next_at <= NOW()),
// skips terminal statuses + quarantined domains, enforces:
//   - per-domain 5s rate limit (shared _domainProbeLock Map)
//   - daily budget cap (VERIFY_DAILY_MAX, default 500)
//   - DISTINCT ON domain to spread MX load
//
// Sprint J (2026-05-14) — Tier-priority ordering.
//   When operator_settings.verify_queue_tier_priority_enabled = 'true'
//   (default after migration 113), the cron orders the due cohort by
//   contacts.email_verify_priority DESC, email_verify_next_at ASC so
//   A-tier leads (>= 0.90) are picked first within each domain partition.
//   The DISTINCT ON (domain) MX-spread throttle is preserved.
//
//   When the toggle is 'false', the cron falls back to pure FIFO
//   ordering on email_verify_next_at — the pre-Sprint-J behaviour.
//
// Helper pure functions (classifyContactStatus, computeContactNextVerifyAt,
// computeContactRetryAt) live in src/lib/automation.js so they can be tested
// independently without any Express/DB wiring.
//
// op field convention (slog-conventions.md): 'contactVerifyCron.<branch>'

import {
  classifyContactStatus,
  computeContactNextVerifyAt,
  computeContactRetryAt,
} from '../lib/automation.js'
import { isPaused } from '../lib/verifyLoopPaused.js'
import {
  TIER_A_MIN,
  TIER_B_MIN,
  TIER_C_MIN,
  TIER_D_MIN,
} from '../lib/leadTierThresholds.js'

let _contactVerifyInFlight = false

/**
 * Sprint J — summarize tier distribution of a verify-batch cohort.
 *
 * Pure helper so the contract test can assert tier counts without a
 * full Express + Postgres harness. Mirrors the band boundaries from
 * leadTierThresholds.js (single source of truth for tier cutoffs).
 *
 * @param {Array<{ email_verify_priority?: number | null }>} rows
 * @returns {{ A: number, B: number, C: number, D: number, E: number }}
 */
export function summarizeTierBreakdown(rows) {
  const out = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  if (!Array.isArray(rows)) return out
  for (const row of rows) {
    const p = Number(row?.email_verify_priority)
    if (!Number.isFinite(p)) {
      out.E++
      continue
    }
    if (p >= TIER_A_MIN) out.A++
    else if (p >= TIER_B_MIN) out.B++
    else if (p >= TIER_C_MIN) out.C++
    else if (p >= TIER_D_MIN) out.D++
    else out.E++
  }
  return out
}

/**
 * Mount the contact verify cron on a pool + verifyEmail deps.
 * Returns { runContactVerifyCron, scheduleContactVerifyCron } so callers can
 * wire the interval and initial delay without importing a global.
 *
 * @param {{
 *   pool: import('pg').Pool,
 *   verifyEmail: (email: string, opts: unknown) => Promise<{ status: string, confidence?: number, detail?: string }>,
 *   domainCache: { get: (d: string) => Promise<unknown>, set: (d: string, rec: unknown) => Promise<void> },
 *   domainProbeLock: Map<string, number>,
 *   DOMAIN_RATE_MS: number,
 *   capture?: (err: Error, context?: object) => void,
 * }} deps
 */
export function mountContactVerifyCron(deps) {
  const {
    pool,
    verifyEmail,
    domainCache,
    domainProbeLock,
    DOMAIN_RATE_MS,
    capture,
  } = deps

  /**
   * maybeQuarantineDomain: if 3+ timeout errors in the last hour for a domain,
   * upsert a 24h quarantine row so subsequent ticks skip the domain entirely.
   *
   * @param {string} domain
   */
  async function maybeQuarantineDomain(domain) {
    if (!domain) return
    try {
      const { rows } = await pool.query(`
        SELECT count(*)::int AS n
          FROM email_verification_log
         WHERE contact_id IS NOT NULL
           AND detail LIKE '%timeout%'
           AND email ILIKE $1
           AND created_at >= now() - interval '1 hour'
      `, [`%@${domain}`])
      const timeouts = rows[0]?.n ?? 0
      if (timeouts >= 3) {
        await pool.query(`
          INSERT INTO email_verify_domain_quarantine (domain, quarantine_until, reason)
          VALUES ($1, now() + interval '24 hours', 'AM2: 3+ timeouts in 1h')
          ON CONFLICT (domain) DO UPDATE
            SET quarantine_until = GREATEST(
              email_verify_domain_quarantine.quarantine_until,
              now() + interval '24 hours'
            ),
            reason = EXCLUDED.reason
        `, [domain])
        console.log(`[contact-verify] op=contactVerifyCron.quarantine domain=${domain} timeouts=${timeouts} → 24h quarantine`)
      }
    } catch (e) {
      console.error(`[contact-verify] op=contactVerifyCron.quarantine_error domain=${domain}:`, e.message)
    }
  }

  /**
   * Read a setting from operator_settings; fall back to fallback value on error/missing.
   * H3: contactVerifyCron reads config from DB first, then env vars.
   * @param {string} key
   * @param {string|null} fallback
   * @returns {Promise<string|null>}
   */
  async function getOperatorSetting(key, fallback = null) {
    try {
      const { rows } = await pool.query(
        `SELECT value FROM operator_settings WHERE key = $1 LIMIT 1`,
        [key]
      )
      return rows[0]?.value ?? fallback
    } catch {
      return fallback
    }
  }

  async function runContactVerifyCron() {
    // H3: check DB-backed enabled flag first; fall back to env var
    const dbEnabled = await getOperatorSetting('verify_loop_enabled', null)
    const enabled = dbEnabled === 'true'
      || (dbEnabled === null && process.env.VERIFY_LOOP_CONTACTS_ENABLED === 'true')
    if (!enabled) return

    // H3: check DB-backed paused flag
    const dbPaused = await getOperatorSetting('verify_loop_paused', 'false')
    if (dbPaused === 'true' || isPaused()) {
      console.log('[contact-verify] op=contactVerifyCron.skip_paused — loop paused by operator')
      return
    }
    if (_contactVerifyInFlight) {
      console.log('[contact-verify] op=contactVerifyCron.skip_inflight — previous run still in flight')
      return
    }
    _contactVerifyInFlight = true
    console.log('[contact-verify] op=contactVerifyCron.start')

    try {
      // H3: read batch/daily config from operator_settings; fall back to env
      const batchSizeSetting = await getOperatorSetting('email_verify_batch_size', null)
      const dailyMaxSetting  = await getOperatorSetting('email_verify_daily_max',  null)
      const batchSize = Number(batchSizeSetting ?? process.env.VERIFY_BATCH_SIZE ?? 20)
      const dailyMax  = Number(dailyMaxSetting  ?? process.env.VERIFY_DAILY_MAX  ?? 500)

      // Daily budget guard — count today's contact verifications
      const { rows: usedRows } = await pool.query(`
        SELECT count(*)::int AS used FROM email_verification_log
         WHERE contact_id IS NOT NULL
           AND trigger = 'cron'
           AND created_at >= (now() AT TIME ZONE 'Europe/Prague')::date
      `).catch(() => ({ rows: [{ used: 0 }] }))
      const used      = usedRows[0]?.used ?? 0
      const remaining = dailyMax - used
      if (remaining <= 0) {
        console.log(`[contact-verify] op=contactVerifyCron.budget_exhausted used=${used} dailyMax=${dailyMax}`)
        return
      }

      const limit = Math.min(batchSize, remaining)

      // Sprint J — tier-priority ordering toggle. Default 'true' once
      // migration 113 lands; pre-migration callers fall back to FIFO
      // because the operator_settings row simply doesn't exist yet.
      const tierPriorityEnabled =
        (await getOperatorSetting('verify_queue_tier_priority_enabled', 'true'))
          === 'true'

      // Pick due contacts — DISTINCT ON domain to spread MX load.
      //
      // Sprint J ordering rationale:
      //   PostgreSQL DISTINCT ON requires the leading ORDER BY column to
      //   match the DISTINCT ON expression. The MX-spread throttle is
      //   therefore preserved as the first ORDER BY key. Within each
      //   domain partition we then prefer the highest tier (A_top first)
      //   and the oldest due timestamp as the secondary tiebreaker.
      //
      //   When the toggle is OFF we drop the tier key and fall back to
      //   FIFO inside each domain (the pre-Sprint-J behaviour).
      const orderClause = tierPriorityEnabled
        ? `ORDER BY lower(split_part(email, '@', 2)),
                   email_verify_priority DESC NULLS LAST,
                   email_verify_next_at ASC`
        : `ORDER BY lower(split_part(email, '@', 2)),
                   email_verify_next_at ASC`

      const { rows: due } = await pool.query(`
        SELECT DISTINCT ON (lower(split_part(email, '@', 2)))
               id,
               email,
               lower(split_part(email, '@', 2)) AS email_domain,
               email_status,
               email_verify_attempts,
               email_verify_priority
          FROM contacts
         WHERE email_verify_next_at <= NOW()
           AND email_status NOT IN ('bounce_hold', 'spamtrap', 'invalid')
           AND email IS NOT NULL
           AND lower(split_part(email, '@', 2)) NOT IN (
               SELECT domain FROM email_verify_domain_quarantine
                WHERE quarantine_until > NOW()
           )
         ${orderClause}
         LIMIT $1
      `, [limit])

      // Sprint J — emit batch-start audit row with tier breakdown so
      // operators can verify in operator_audit_log that A-tier contacts
      // are landing first. HARD RULE feedback_audit_log_on_mutations
      // (T0): every batch that mutates contacts.email_status to
      // 'verifying' records the cohort tier mix.
      const tierBreakdown = summarizeTierBreakdown(due)
      await pool
        .query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, details)
           VALUES ('verify_batch_start', $1, 'verify_loop', $2)`,
          [
            'contactVerifyCron',
            JSON.stringify({
              picked: due.length,
              budget_remaining: remaining,
              tier_priority_enabled: tierPriorityEnabled,
              tiers: tierBreakdown,
            }),
          ],
        )
        .catch((auditErr) => {
          console.warn(
            '[contact-verify] op=contactVerifyCron.audit_warn:',
            auditErr.message,
          )
        })

      console.log(
        `[contact-verify] op=contactVerifyCron.picked count=${due.length} ` +
          `budget_remaining=${remaining} tier_priority=${tierPriorityEnabled} ` +
          `tiers=${JSON.stringify(tierBreakdown)}`,
      )

      let ok = 0, changed = 0

      for (const c of due) {
        try {
          // Per-domain rate limit — reuse shared domainProbeLock Map
          const lastProbe = domainProbeLock.get(c.email_domain) ?? 0
          const sinceMs   = Date.now() - lastProbe
          if (sinceMs < DOMAIN_RATE_MS) {
            console.log(`[contact-verify] op=contactVerifyCron.rate_limited domain=${c.email_domain} wait=${DOMAIN_RATE_MS - sinceMs}ms`)
            continue
          }
          domainProbeLock.set(c.email_domain, Date.now())

          // Mark verifying to prevent double-pick across parallel ticks
          await pool.query(
            `UPDATE contacts SET email_status='verifying' WHERE id=$1 AND email_status != 'verifying'`,
            [c.id]
          )

          // Probe via existing verifyEmail (Railway-direct TCP, not Mullvad)
          const result = await verifyEmail(c.email, {
            enableSMTP: process.env.EMAIL_VERIFY_SMTP !== '0',
            domainCache,
            fromAddr: process.env.EMAIL_VERIFY_FROM || 'probe@example.com',
          })

          const prevStatus = c.email_status
          let   newStatus  = classifyContactStatus(result)
          const attempts   = (c.email_verify_attempts ?? 0) + 1

          // 5+ attempts on risky → permanent invalid
          if (newStatus === 'risky' && attempts >= 5) {
            newStatus = 'invalid'
          }

          const nextAt = computeContactNextVerifyAt(newStatus, attempts)

          await pool.query(`
            UPDATE contacts SET
              email_status        = $1,
              email_verified_at   = NOW(),
              email_verification  = $2,
              email_confidence    = $3,
              email_verify_attempts = $4,
              email_verify_next_at  = $5
            WHERE id = $6
          `, [newStatus, JSON.stringify(result), result.confidence ?? null, attempts, nextAt, c.id])

          await pool.query(`
            INSERT INTO email_verification_log
              (contact_id, email, old_status, new_status, detail, trigger, verification)
            VALUES ($1, $2, $3, $4, $5, 'cron', $6)
          `, [c.id, c.email, prevStatus, newStatus, result.detail ?? null, JSON.stringify(result)])

          ok++
          if (prevStatus !== newStatus) {
            changed++
            console.log(`[contact-verify] op=contactVerifyCron.status_change id=${c.id} ${prevStatus}→${newStatus}`)
          }
        } catch (e) {
          console.error(`[contact-verify] op=contactVerifyCron.contact_error id=${c.id} email=${c.email?.split('@')[0]}@…:`, e.message)
          if (capture) capture(e, { op: 'contactVerifyCron.contact_error', contactId: c.id })

          // Increment attempts + schedule retry per backoff.
          //
          // A transient probe I/O failure must NOT demote a previously
          // known-good status (valid/catch_all/role_only) to 'risky': we
          // eagerly flipped this row to 'verifying' before probing, so the
          // old `CASE WHEN email_status='verifying' THEN 'risky'` collapsed
          // every error onto 'risky'. Restore the pre-probe status
          // (c.email_status, captured at SELECT time) verbatim instead.
          //
          // Also never strand a (non-terminal) contact with next_at=NULL:
          // computeContactRetryAt returns null at attempt>=5, which the picker
          // can never re-select (it requires email_verify_next_at <= NOW()).
          // Clamp to the longest finite backoff (attempt 4 → +7d) so the row
          // stays reachable rather than vanishing from the queue forever.
          const nextAttempts = (c.email_verify_attempts ?? 0) + 1
          const retryAt = computeContactRetryAt(nextAttempts)
            ?? computeContactRetryAt(4)
          await pool.query(`
            UPDATE contacts SET
              email_status          = $1,
              email_verify_attempts = $2,
              email_verify_next_at  = $3
            WHERE id = $4
          `, [c.email_status, nextAttempts, retryAt, c.id]).catch(() => {})

          // Log timeout for domain quarantine tracking
          if (e.message?.includes('timeout')) {
            await pool.query(`
              INSERT INTO email_verification_log
                (contact_id, email, old_status, new_status, detail, trigger, verification)
              VALUES ($1, $2, $3, 'risky', $4, 'cron', NULL)
            `, [c.id, c.email, c.email_status, `timeout: ${e.message}`]).catch(() => {})
            await maybeQuarantineDomain(c.email_domain)
          }
        }
      }

      console.log(`[contact-verify] op=contactVerifyCron.done ok=${ok}/${due.length} changed=${changed}`)
    } catch (e) {
      console.error('[contact-verify] op=contactVerifyCron.fatal_error:', e.message)
      if (capture) capture(e, { op: 'contactVerifyCron.fatal_error' })
    } finally {
      _contactVerifyInFlight = false
    }
  }

  /**
   * Wire the hourly schedule onto the process.
   * Initial tick fires 90s after boot (staggered from other crons).
   */
  function scheduleContactVerifyCron() {
    const INTERVAL_MS = 60 * 60 * 1000 // 1h
    const INITIAL_DELAY_MS = 90_000    // 90s
    setTimeout(() => {
      runContactVerifyCron()
      setInterval(runContactVerifyCron, INTERVAL_MS)
    }, INITIAL_DELAY_MS)
  }

  return { runContactVerifyCron, scheduleContactVerifyCron }
}
