// verifyLoop.js — Sprint AM3 + H1 + ADD-2
// ─────────────────────────────────────────────────────────────────────────────
// Operator surface for contact verification loop (AM2/H1). Exposes status,
// pause/resume, manual trigger, queue inspection, bulk-enqueue, and
// DB-backed config management.
//
// Routes (AM3):
//   GET    /api/verify-loop/status      — overall loop state
//   POST   /api/verify-loop/pause       — pause with reason
//   POST   /api/verify-loop/resume      — resume
//   POST   /api/verify-loop/trigger     — manual run
//   GET    /api/verify-loop/queue       — pending contacts
//   POST   /api/contacts/:id/reverify   — bump priority + schedule immediate
//
// Routes (H1 — bulk verify UI):
//   POST   /api/contacts/verify/bulk-enqueue  — schedule N contacts for verify
//   POST   /api/contacts/verify/pause         — flip verify_loop_paused in operator_settings
//   POST   /api/contacts/verify/resume        — clear pause flag
//   GET    /api/contacts/verify/progress      — rich stats + ETA for UI card
//   PUT    /api/contacts/verify/config        — tune daily_max / batch_size / enabled
//
// Routes (ADD-2 — verify queue health signal):
//   GET    /api/verify-queue/health           — cron liveness for Home widget
//   POST   /api/contacts/verify/tick          — manual single-tick trigger
//
// Security gate: state-changing H1 + ADD-2 routes require X-Confirm-Send: yes.
//
// op field convention: 'verifyLoop.<branch>'

import { getPaused, setPaused, clearPaused } from '../lib/verifyLoopPaused.js'

// ─── ADD-2 health thresholds (HARD RULE: no_magic_thresholds) ───────────────
//
// Past incident (2026-05-14): operator panicked seeing
// "31198 pending, 0 processed". VerifyQueueWidget showed depth but
// not whether the cron was draining. ADD-2 surfaces last_tick_at +
// derived status so the operator knows running vs stuck vs disabled
// at a glance.
//
// VERIFY_HEALTH_STUCK_MINUTES — cron is considered stuck (red) if
// the most recent email_verification_log entry with trigger='cron'
// is older than this many minutes. 90 min picks up a hard stall well
// before a half-day of silent inactivity (the 2026-05-14 panic state).
//
// VERIFY_HEALTH_STALE_MINUTES — cron is considered stale (amber) if
// the last tick is older than this but younger than the stuck bar.
// 45 min covers slow / quiet hours without flapping to red.
//
// Both values are overridable via operator_settings keys
//   verify_health_stuck_minutes
//   verify_health_stale_minutes
// when an operator has a non-default daily_max / cron cadence.
export const VERIFY_HEALTH_STUCK_MINUTES_DEFAULT = 90
export const VERIFY_HEALTH_STALE_MINUTES_DEFAULT = 45

/**
 * Classify health status from the timestamp of the most recent cron
 * tick. Pure helper exported for unit-test coverage.
 *
 * @param {Date | string | null | undefined} lastTickAt
 * @param {{ enabled?: boolean, paused?: boolean,
 *           stuckMinutes?: number, staleMinutes?: number,
 *           now?: Date }} opts
 * @returns {{
 *   is_healthy: boolean,
 *   status_reason:
 *     | 'disabled'
 *     | 'paused'
 *     | 'no_ticks_yet'
 *     | 'stuck'
 *     | 'stale'
 *     | 'running',
 *   stuck_threshold_minutes: number,
 *   stale_threshold_minutes: number,
 *   minutes_since_last_tick: number | null,
 * }}
 */
export function classifyVerifyHealth(lastTickAt, opts = {}) {
  const stuck = Number(opts.stuckMinutes ?? VERIFY_HEALTH_STUCK_MINUTES_DEFAULT)
  const stale = Number(opts.staleMinutes ?? VERIFY_HEALTH_STALE_MINUTES_DEFAULT)
  const now = opts.now instanceof Date ? opts.now : new Date()

  if (opts.paused) {
    return {
      is_healthy: false,
      status_reason: 'paused',
      stuck_threshold_minutes: stuck,
      stale_threshold_minutes: stale,
      minutes_since_last_tick: null,
    }
  }
  if (opts.enabled === false) {
    return {
      is_healthy: false,
      status_reason: 'disabled',
      stuck_threshold_minutes: stuck,
      stale_threshold_minutes: stale,
      minutes_since_last_tick: null,
    }
  }

  if (!lastTickAt) {
    return {
      is_healthy: false,
      status_reason: 'no_ticks_yet',
      stuck_threshold_minutes: stuck,
      stale_threshold_minutes: stale,
      minutes_since_last_tick: null,
    }
  }

  const lastDate = lastTickAt instanceof Date ? lastTickAt : new Date(lastTickAt)
  if (Number.isNaN(lastDate.getTime())) {
    return {
      is_healthy: false,
      status_reason: 'no_ticks_yet',
      stuck_threshold_minutes: stuck,
      stale_threshold_minutes: stale,
      minutes_since_last_tick: null,
    }
  }
  const minutes = Math.max(0, Math.floor((now.getTime() - lastDate.getTime()) / 60_000))

  if (minutes >= stuck) {
    return {
      is_healthy: false,
      status_reason: 'stuck',
      stuck_threshold_minutes: stuck,
      stale_threshold_minutes: stale,
      minutes_since_last_tick: minutes,
    }
  }
  if (minutes >= stale) {
    return {
      is_healthy: false,
      status_reason: 'stale',
      stuck_threshold_minutes: stuck,
      stale_threshold_minutes: stale,
      minutes_since_last_tick: minutes,
    }
  }
  return {
    is_healthy: true,
    status_reason: 'running',
    stuck_threshold_minutes: stuck,
    stale_threshold_minutes: stale,
    minutes_since_last_tick: minutes,
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Read a single key from operator_settings. Returns null if missing or on error.
 * @param {import('pg').Pool} pool
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function getOperatorSetting(pool, key) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM operator_settings WHERE key = $1 LIMIT 1`,
      [key]
    )
    return rows[0]?.value ?? null
  } catch {
    return null
  }
}

/**
 * Upsert a single key in operator_settings with audit log entry.
 * @param {import('pg').Pool} pool
 * @param {string} key
 * @param {string} value
 * @param {string} actor
 */
async function setOperatorSetting(pool, key, value, actor = 'dashboard') {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO operator_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
      [key, value, actor]
    )
    await client.query(
      `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
       VALUES ('operator_settings_update', $1, 'operator_settings', $2, $3)`,
      [actor, key, JSON.stringify({ key, new_value: value })]
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Mount the verify-loop operator routes (AM3 + H1).
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   runContactVerifyCron: () => Promise<void>,
 *   capture?: (err: Error, context?: object) => void,
 * }} deps
 */
export function mountVerifyLoopRoutes(app, { pool, runContactVerifyCron, capture }) {
  // ── GET /api/verify-loop/status ──────────────────────────────────────
  app.get('/api/verify-loop/status', async (req, res) => {
    try {
      // Resolve enabled / daily_max / paused DB-first from operator_settings
      // (mirror of /progress + the cron) so this surface can't disagree with
      // the loop's real config — env is only the bootstrap fallback.
      const [dailyMaxSetting, pausedSetting, enabledSetting] = await Promise.all([
        getOperatorSetting(pool, 'email_verify_daily_max'),
        getOperatorSetting(pool, 'verify_loop_paused'),
        getOperatorSetting(pool, 'verify_loop_enabled'),
      ])
      const enabled = enabledSetting === 'true'
        || process.env.VERIFY_LOOP_CONTACTS_ENABLED === 'true'
      const dailyMax = Number(dailyMaxSetting ?? process.env.VERIFY_DAILY_MAX ?? 500)

      // Count today's verifications (Prague timezone)
      const { rows: usedRows } = await pool.query(`
        SELECT count(*)::int AS used FROM email_verification_log
         WHERE contact_id IS NOT NULL
           AND trigger = 'cron'
           AND created_at >= (now() AT TIME ZONE 'Europe/Prague')::date
      `)
      const dailyUsed = usedRows[0]?.used ?? 0
      const dailyRemaining = Math.max(0, dailyMax - dailyUsed)

      // Count inflight (status = 'verifying')
      const { rows: inflightRows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM contacts WHERE email_status = 'verifying'
      `)
      const inflight = inflightRows[0]?.cnt ?? 0

      // Count pending queue
      const { rows: queueRows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM contacts
         WHERE email_verify_next_at <= NOW()
           AND email_status NOT IN ('bounce_hold', 'spamtrap', 'invalid')
           AND email IS NOT NULL
           AND lower(split_part(email, '@', 2)) NOT IN (
               SELECT domain FROM email_verify_domain_quarantine
                WHERE quarantine_until > NOW()
           )
      `)
      const queueDepth = queueRows[0]?.cnt ?? 0

      // Error rate (24h window)
      const { rows: errorRows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM email_verification_log
         WHERE contact_id IS NOT NULL
           AND created_at >= now() - interval '24 hours'
           AND detail LIKE '%timeout%'
      `)
      const errorCount24h = errorRows[0]?.cnt ?? 0
      const totalCount24h = Math.max(1, dailyUsed + errorCount24h)
      const errorRate24h = Number((errorCount24h / totalCount24h).toFixed(3))

      // Last tick (most recent log entry)
      const { rows: tickRows } = await pool.query(`
        SELECT created_at FROM email_verification_log
         WHERE trigger = 'cron'
         ORDER BY created_at DESC LIMIT 1
      `)
      const lastTickAt = tickRows[0]?.created_at ?? null

      // DB-first paused (mirror /progress): operator_settings flag OR the
      // in-memory pause. Reason only lives in-memory.
      const memPaused = getPaused()
      const paused = pausedSetting === 'true' || memPaused.paused

      res.json({
        enabled,
        paused,
        paused_reason: memPaused.reason,
        daily_max: dailyMax,
        daily_used: dailyUsed,
        daily_remaining: dailyRemaining,
        inflight,
        queue_depth: queueDepth,
        last_tick_at: lastTickAt,
        error_rate_24h: errorRate24h,
      })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.status_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.status' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── POST /api/verify-loop/pause ──────────────────────────────────────
  app.post('/api/verify-loop/pause', async (req, res) => {
    try {
      const { reason } = req.body
      setPaused(reason || 'paused by operator')
      console.log(`[verify-loop] op=verifyLoop.pause reason=${reason || '(none)'}`)
      res.json({ ok: true, paused: true, reason: reason || 'paused by operator' })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.pause_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.pause' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── POST /api/verify-loop/resume ─────────────────────────────────────
  app.post('/api/verify-loop/resume', async (req, res) => {
    try {
      clearPaused()
      console.log('[verify-loop] op=verifyLoop.resume')
      res.json({ ok: true, paused: false })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.resume_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.resume' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── POST /api/verify-loop/trigger ────────────────────────────────────
  app.post('/api/verify-loop/trigger', async (req, res) => {
    try {
      // Check if already running
      const { rows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM contacts WHERE email_status = 'verifying'
      `)
      if (rows[0]?.cnt > 0) {
        return res.status(202).json({ busy: true, message: 'verification already in flight' })
      }

      console.log('[verify-loop] op=verifyLoop.trigger_manual manual trigger by operator')
      // Fire async in background — don't wait for completion
      runContactVerifyCron().catch(e => {
        console.error('[verify-loop] op=verifyLoop.trigger_error:', e.message)
        if (capture) capture(e, { op: 'verifyLoop.trigger' })
      })

      res.json({ ok: true, started: true })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.trigger_check_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.trigger_check' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── GET /api/verify-loop/queue ──────────────────────────────────────
  app.get('/api/verify-loop/queue', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 50), 500)

      const { rows } = await pool.query(`
        SELECT
          id,
          email,
          email_status,
          email_verify_attempts,
          email_verify_next_at,
          email_verify_priority,
          email_confidence
        FROM contacts
        WHERE email_verify_next_at <= NOW()
          AND email_status NOT IN ('bounce_hold', 'spamtrap', 'invalid')
          AND email IS NOT NULL
          AND lower(split_part(email, '@', 2)) NOT IN (
              SELECT domain FROM email_verify_domain_quarantine
               WHERE quarantine_until > NOW()
          )
        ORDER BY email_verify_priority DESC, email_verify_next_at ASC
        LIMIT $1
      `, [limit])

      res.json(rows)
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.queue_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.queue' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── POST /api/contacts/:id/reverify ──────────────────────────────────
  app.post('/api/contacts/:id/reverify', async (req, res) => {
    const { id } = req.params
    const { priority } = req.body
    const contactId = Number(id)

    if (!contactId || contactId <= 0) {
      return res.status(400).json({ error: 'invalid contact id' })
    }

    const hasPriority = priority !== undefined && priority !== null
    const actor = req.headers['x-actor'] || 'dashboard'

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Set next_at to NOW() to mark as due immediately
      const upd = await client.query(`
        UPDATE contacts
        SET
          email_verify_next_at = NOW()
          ${hasPriority ? ', email_verify_priority = $2' : ''}
        WHERE id = $1
      `, hasPriority ? [contactId, priority] : [contactId])

      // HARD RULE feedback_audit_log_on_mutations: the audit row lands in the
      // SAME tx as the contacts UPDATE so a reverify can never be applied
      // without its forensic trail (nor rolled back leaving an orphan row).
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('contact_reverify', $1, 'contacts', $2, $3)`,
        [
          String(actor),
          String(contactId),
          JSON.stringify({
            contact_id: contactId,
            priority: hasPriority ? Number(priority) : null,
            matched: upd.rowCount,
          }),
        ],
      )

      await client.query('COMMIT')

      console.log(`[verify-loop] op=verifyLoop.reverify_manual contact_id=${contactId} priority=${hasPriority ? priority : '(unchanged)'} actor=${actor}`)

      res.json({ ok: true, contact_id: contactId })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('[verify-loop] op=verifyLoop.reverify_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.reverify' })
      res.status(500).json({ error: 'internal error' })
    } finally {
      client.release()
    }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // H1 — Bulk verify UI endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  // ── POST /api/contacts/verify/bulk-enqueue ────────────────────────────────
  // body: { scope: 'all' | 'unverified' | 'campaign:<id>' }
  // Sets email_verify_next_at = NOW() on matching contacts that don't already
  // have a past verify_next_at scheduled. Excludes terminal statuses.
  // Requires X-Confirm-Send: yes header.
  app.post('/api/contacts/verify/bulk-enqueue', async (req, res) => {
    const confirm = req.headers['x-confirm-send']
    if (confirm !== 'yes') {
      return res.status(400).json({ error: 'Missing X-Confirm-Send: yes header' })
    }

    const { scope } = req.body
    if (!scope || (!['all', 'unverified'].includes(scope) && !String(scope).startsWith('campaign:'))) {
      return res.status(400).json({ error: 'scope must be "all", "unverified", or "campaign:<id>"' })
    }

    try {
      const TERMINAL = ['bounce_hold', 'spamtrap', 'invalid']
      const queryParams = []

      // Build scope filter clause
      let scopeFilter = ''
      if (scope === 'unverified') {
        scopeFilter = `AND email_verification IS NULL`
      } else if (String(scope).startsWith('campaign:')) {
        const campaignId = Number(scope.split(':')[1])
        if (!campaignId || campaignId <= 0) {
          return res.status(400).json({ error: 'invalid campaign id in scope' })
        }
        queryParams.push(campaignId)
        // Campaigns enroll contacts via campaign_contacts — there is no
        // campaigns.segment_id column and no segment_companies table (the
        // prior join 500'd, leaving this scope non-functional). Scope the
        // re-arm to exactly this campaign's enrolled contacts. The COUNT(*)
        // prechecks below reuse this same filter + params, so they stay
        // consistent with the UPDATE.
        scopeFilter = `
          AND id IN (
            SELECT contact_id FROM campaign_contacts
             WHERE campaign_id = $${queryParams.length}
          )`
      }

      // Count total eligible (before skip logic)
      const totalRes = await pool.query(
        `SELECT count(*)::int AS cnt FROM contacts
          WHERE email IS NOT NULL
            AND email_status NOT IN (${TERMINAL.map(s => `'${s}'`).join(',')})
            ${scopeFilter}`,
        queryParams
      )
      const total = totalRes.rows[0]?.cnt ?? 0

      // Count terminal-status contacts (skipped)
      const terminalRes = await pool.query(
        `SELECT count(*)::int AS cnt FROM contacts
          WHERE email IS NOT NULL
            AND email_status IN (${TERMINAL.map(s => `'${s}'`).join(',')})
            ${scopeFilter}`,
        queryParams
      )
      const skippedTerminal = terminalRes.rows[0]?.cnt ?? 0

      // Enqueue: set email_verify_next_at = NOW() only where not already past-due
      const { rowCount: enqueued } = await pool.query(
        `UPDATE contacts
            SET email_verify_next_at = NOW()
          WHERE email IS NOT NULL
            AND email_status NOT IN (${TERMINAL.map(s => `'${s}'`).join(',')})
            AND (email_verify_next_at IS NULL OR email_verify_next_at > NOW())
            ${scopeFilter}`,
        queryParams
      )

      const actor = req.headers['x-actor'] || 'dashboard'
      console.log(`[verify-loop] op=verifyLoop.bulk_enqueue scope=${scope} enqueued=${enqueued} total=${total} actor=${actor}`)

      await pool.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('verify_bulk_enqueue', $1, 'contacts', 'bulk', $2)`,
        [actor, JSON.stringify({ scope, enqueued, total, skipped_terminal: skippedTerminal })]
      ).catch(() => {})

      res.json({ enqueued, total, skipped_terminal: skippedTerminal })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.bulk_enqueue_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.bulk_enqueue' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── POST /api/contacts/verify/pause (H1) ─────────────────────────────────
  // Flips verify_loop_paused = 'true' in operator_settings + in-memory flag.
  // Requires X-Confirm-Send: yes header.
  app.post('/api/contacts/verify/pause', async (req, res) => {
    const confirm = req.headers['x-confirm-send']
    if (confirm !== 'yes') {
      return res.status(400).json({ error: 'Missing X-Confirm-Send: yes header' })
    }
    try {
      const { reason } = req.body
      const actor = req.headers['x-actor'] || 'dashboard'
      await setOperatorSetting(pool, 'verify_loop_paused', 'true', actor)
      setPaused(reason || 'paused by operator via UI')
      console.log(`[verify-loop] op=verifyLoop.h1_pause reason=${reason || '(none)'} actor=${actor}`)
      res.json({ ok: true, paused: true, reason: reason || 'paused by operator via UI' })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.h1_pause_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.h1_pause' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── POST /api/contacts/verify/resume (H1) ────────────────────────────────
  // Flips verify_loop_paused = 'false' in operator_settings + clears in-memory flag.
  // Requires X-Confirm-Send: yes header.
  app.post('/api/contacts/verify/resume', async (req, res) => {
    const confirm = req.headers['x-confirm-send']
    if (confirm !== 'yes') {
      return res.status(400).json({ error: 'Missing X-Confirm-Send: yes header' })
    }
    try {
      const actor = req.headers['x-actor'] || 'dashboard'
      await setOperatorSetting(pool, 'verify_loop_paused', 'false', actor)
      clearPaused()
      console.log(`[verify-loop] op=verifyLoop.h1_resume actor=${actor}`)
      res.json({ ok: true, paused: false })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.h1_resume_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.h1_resume' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── GET /api/contacts/verify/progress (H1) ───────────────────────────────
  // Rich stats + ETA for UI card. Read-only; no X-Confirm-Send required.
  app.get('/api/contacts/verify/progress', async (req, res) => {
    try {
      const [dailyMaxSetting, pausedSetting, enabledSetting] = await Promise.all([
        getOperatorSetting(pool, 'email_verify_daily_max'),
        getOperatorSetting(pool, 'verify_loop_paused'),
        getOperatorSetting(pool, 'verify_loop_enabled'),
      ])
      const dailyMax = Number(dailyMaxSetting ?? process.env.VERIFY_DAILY_MAX ?? 500)
      const dbPaused = pausedSetting === 'true'
      const enabled = enabledSetting === 'true'
        || process.env.VERIFY_LOOP_CONTACTS_ENABLED === 'true'

      // Total eligible contacts (not terminal, has email)
      const { rows: totalRows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM contacts
         WHERE email IS NOT NULL
           AND email_status NOT IN ('bounce_hold','spamtrap','invalid')
      `)
      const totalEligible = totalRows[0]?.cnt ?? 0

      // Verified total (has email_verified_at)
      const { rows: verifiedRows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM contacts
         WHERE email_verified_at IS NOT NULL
      `)
      const verifiedTotal = verifiedRows[0]?.cnt ?? 0

      // Pending queue depth (due within 24h)
      const { rows: pendingRows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM contacts
         WHERE email_verify_next_at IS NOT NULL
           AND email_verify_next_at <= NOW() + interval '24 hours'
           AND email_status NOT IN ('bounce_hold','spamtrap','invalid')
      `)
      const pending = pendingRows[0]?.cnt ?? 0

      // Daily used today (Prague timezone)
      const { rows: usedRows } = await pool.query(`
        SELECT count(*)::int AS used FROM email_verification_log
         WHERE contact_id IS NOT NULL
           AND trigger = 'cron'
           AND created_at >= (now() AT TIME ZONE 'Europe/Prague')::date
      `)
      const dailyUsed = usedRows[0]?.used ?? 0

      // Status breakdown
      const { rows: breakdownRows } = await pool.query(`
        SELECT email_status, count(*)::int AS cnt
          FROM contacts
         WHERE email IS NOT NULL
         GROUP BY email_status
      `)
      const statusBreakdown = {}
      for (const row of breakdownRows) {
        statusBreakdown[row.email_status ?? 'unknown'] = row.cnt
      }

      // Last-minute throughput for ETA
      const { rows: recentRows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM email_verification_log
         WHERE contact_id IS NOT NULL
           AND trigger = 'cron'
           AND created_at >= now() - interval '1 minute'
      `)
      const recentPerMinute = recentRows[0]?.cnt ?? 0

      // ETA calculation
      const unverified = totalEligible - verifiedTotal
      const hourlyRate = recentPerMinute > 0
        ? recentPerMinute * 60
        : dailyMax / 24
      const etaDaysRemaining = hourlyRate > 0 && unverified > 0
        ? Math.ceil(unverified / (hourlyRate * 24))
        : null

      const paused = dbPaused || getPaused().paused

      res.json({
        total_eligible: totalEligible,
        verified_total: verifiedTotal,
        pending,
        daily_used: dailyUsed,
        daily_max: dailyMax,
        eta_days_remaining: etaDaysRemaining,
        status_breakdown: statusBreakdown,
        recent_per_minute: recentPerMinute,
        paused,
        enabled,
      })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.h1_progress_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.h1_progress' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── PUT /api/contacts/verify/config (H1) ─────────────────────────────────
  // body: { daily_max?: int, batch_size?: int, enabled?: boolean }
  // Validates ranges. Writes to operator_settings with audit log.
  // Requires X-Confirm-Send: yes header.
  app.put('/api/contacts/verify/config', async (req, res) => {
    const confirm = req.headers['x-confirm-send']
    if (confirm !== 'yes') {
      return res.status(400).json({ error: 'Missing X-Confirm-Send: yes header' })
    }

    const { daily_max, batch_size, enabled } = req.body
    const actor = req.headers['x-actor'] || 'dashboard'
    const updates = []
    const errors = []

    if (daily_max !== undefined) {
      const n = Number(daily_max)
      if (!Number.isInteger(n) || n < 100 || n > 50000) {
        errors.push('daily_max must be integer 100..50000')
      } else {
        updates.push(['email_verify_daily_max', String(n)])
      }
    }

    if (batch_size !== undefined) {
      const n = Number(batch_size)
      if (!Number.isInteger(n) || n < 5 || n > 200) {
        errors.push('batch_size must be integer 5..200')
      } else {
        updates.push(['email_verify_batch_size', String(n)])
      }
    }

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        errors.push('enabled must be boolean')
      } else {
        updates.push(['verify_loop_enabled', String(enabled)])
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('; ') })
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'no valid fields provided' })
    }

    try {
      for (const [key, value] of updates) {
        await setOperatorSetting(pool, key, value, actor)
        console.log(`[verify-loop] op=verifyLoop.h1_config_set key=${key} value=${value} actor=${actor}`)
      }
      res.json({ ok: true, updated: updates.map(([k]) => k) })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.h1_config_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.h1_config' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // ADD-2 — Verify queue health signal (2026-05-14)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Past incident: operator panicked seeing "31198 pending, 0 processed".
  // The VerifyQueueWidget (UX-2) showed queue depth + recent_per_minute but
  // had no glanceable "is the cron alive?" signal. ADD-2 surfaces:
  //
  //   - last_tick_at: timestamp of the most recent email_verification_log
  //     row written by the cron path (trigger='cron').
  //   - last_tick_processed: how many rows that most-recent batch wrote.
  //   - is_healthy + status_reason derived from named thresholds.
  //
  // Plus a manual trigger endpoint that re-uses runContactVerifyCron with
  // an audit-log emit (HARD RULE feedback_audit_log_on_mutations).
  // ─────────────────────────────────────────────────────────────────────────

  // ── GET /api/verify-queue/health ────────────────────────────────────────
  // Read-only; no X-Confirm-Send required.
  app.get('/api/verify-queue/health', async (req, res) => {
    try {
      const [dailyMaxSetting, pausedSetting, enabledSetting, stuckSetting, staleSetting] =
        await Promise.all([
          getOperatorSetting(pool, 'email_verify_daily_max'),
          getOperatorSetting(pool, 'verify_loop_paused'),
          getOperatorSetting(pool, 'verify_loop_enabled'),
          getOperatorSetting(pool, 'verify_health_stuck_minutes'),
          getOperatorSetting(pool, 'verify_health_stale_minutes'),
        ])
      const dailyMax = Number(dailyMaxSetting ?? process.env.VERIFY_DAILY_MAX ?? 500)
      const dbPaused = pausedSetting === 'true'
      const enabled =
        enabledSetting === 'true' ||
        process.env.VERIFY_LOOP_CONTACTS_ENABLED === 'true'
      const paused = dbPaused || getPaused().paused
      const stuckMinutes = Number(stuckSetting ?? VERIFY_HEALTH_STUCK_MINUTES_DEFAULT)
      const staleMinutes = Number(staleSetting ?? VERIFY_HEALTH_STALE_MINUTES_DEFAULT)

      // Most-recent cron tick (single row, indexed lookup).
      const { rows: tickRows } = await pool.query(`
        SELECT created_at FROM email_verification_log
         WHERE trigger = 'cron'
         ORDER BY created_at DESC
         LIMIT 1
      `)
      const lastTickAt = tickRows[0]?.created_at ?? null

      // Count of rows written by the cron path inside the most-recent
      // 60-second window starting at last_tick_at. This is the best
      // proxy for "batch size processed by the last tick" without a
      // dedicated cron_runs table.
      let lastTickProcessed = 0
      if (lastTickAt) {
        const { rows: batchRows } = await pool.query(
          `SELECT count(*)::int AS cnt FROM email_verification_log
            WHERE trigger = 'cron'
              AND created_at >= $1::timestamptz - interval '60 seconds'
              AND created_at <= $1::timestamptz`,
          [lastTickAt],
        )
        lastTickProcessed = batchRows[0]?.cnt ?? 0
      }

      // Pending right now (same definition as /progress endpoint).
      const { rows: pendingRows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM contacts
         WHERE email_verify_next_at IS NOT NULL
           AND email_verify_next_at <= NOW() + interval '24 hours'
           AND email_status NOT IN ('bounce_hold','spamtrap','invalid')
      `)
      const pendingNow = pendingRows[0]?.cnt ?? 0

      const health = classifyVerifyHealth(lastTickAt, {
        enabled,
        paused,
        stuckMinutes,
        staleMinutes,
      })

      res.json({
        last_tick_at: lastTickAt,
        last_tick_processed: lastTickProcessed,
        pending_now: pendingNow,
        daily_max: dailyMax,
        enabled,
        paused,
        is_healthy: health.is_healthy,
        status_reason: health.status_reason,
        stuck_threshold_minutes: health.stuck_threshold_minutes,
        stale_threshold_minutes: health.stale_threshold_minutes,
        minutes_since_last_tick: health.minutes_since_last_tick,
      })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.health_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.health' })
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── POST /api/contacts/verify/tick ──────────────────────────────────────
  // Manual single-tick trigger. Re-uses runContactVerifyCron under the
  // hood. Requires X-Confirm-Send: yes header. Emits operator_audit_log
  // in the same path (HARD RULE feedback_audit_log_on_mutations).
  app.post('/api/contacts/verify/tick', async (req, res) => {
    const confirm = req.headers['x-confirm-send']
    if (confirm !== 'yes') {
      return res.status(400).json({ error: 'Missing X-Confirm-Send: yes header' })
    }
    try {
      // Refuse to stack tickers — if a batch is in flight, return 202.
      const { rows } = await pool.query(`
        SELECT count(*)::int AS cnt FROM contacts WHERE email_status = 'verifying'
      `)
      if (rows[0]?.cnt > 0) {
        return res.status(202).json({ busy: true, message: 'verification already in flight' })
      }

      const actor = req.headers['x-actor'] || 'dashboard'
      console.log(`[verify-loop] op=verifyLoop.tick_manual actor=${actor}`)

      // Audit log emit BEFORE firing so a crash in runContactVerifyCron
      // still leaves a forensic trail of the operator action.
      await pool
        .query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('verify_manual_tick', $1, 'verify_loop', 'cron', $2)`,
          [actor, JSON.stringify({ triggered_at: new Date().toISOString() })],
        )
        .catch((e) => {
          console.warn('[verify-loop] op=verifyLoop.tick_audit_warn:', e.message)
        })

      // Fire async — do not block the response.
      runContactVerifyCron().catch((e) => {
        console.error('[verify-loop] op=verifyLoop.tick_error:', e.message)
        if (capture) capture(e, { op: 'verifyLoop.tick' })
      })

      res.json({ ok: true, started: true })
    } catch (e) {
      console.error('[verify-loop] op=verifyLoop.tick_check_error:', e.message)
      if (capture) capture(e, { op: 'verifyLoop.tick_check' })
      res.status(500).json({ error: 'internal error' })
    }
  })
}
