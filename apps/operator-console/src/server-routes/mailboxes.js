import { canUnlock } from '../lib/mailboxAuthFailGuard.js'
import { clampInt } from '../lib/clampInt.js'
import { checkAndRecord } from '../lib/mailboxOpRateLimit.js'
import { getRelayBase, relayFetch } from '../lib/relayClient.js'
import { runDNSCheck } from '../lib/dnsCheck.js'
import { PHASE_ORDER } from '../lib/lifecyclePhaseCaps.js'
// BFF mailbox CRUD + operational/admin route surface.
// ─────────────────────────────────────────────────────────────────────────────
// Operator-facing routes for the outreach mailbox roster. The BFF talks
// directly to Postgres (`outreach_mailboxes`) and joins the per-mailbox
// warmup state. Heal/diagnostic routes (smtp-check, imap-check, full-check,
// pipeline-test, proxy-live-check, assign-proxy, header-probe, bulk-*,
// send-test, anonymity-probe, health-stream, health-summary,
// send-trends, watchdog daemon control, queue depth) stay in server.js
// for now — they reach into helpers (`smtpCheck`, `imapCheck`,
// `assignBestProxy`, `getProxyPool`, `socks5Probe`, `relay*`) that are
// declared further down in the monolith. Those move out in Batch B.
//
// Sprint AP6 (2026-05-07): POST /api/mailboxes/:id/clear-auth-lock
//   Operator unlock after 24h cooldown for auth_locked mailboxes.
//   Sets status='paused' (NOT 'active') — operator must explicitly resume.
//
// Module sequence (ADR-008 D2):
//   T3.5 (2026-05-01): extracted CRUD verbatim from server.js.
//   G1     (2026-05-03): extracted Batch A — 12 operational/admin routes
//                        (stats, send-log, campaigns, watchdog-events,
//                         recover, auth-reset, cooldown-log,
//                         pipeline-results, warmup PATCH + warmup/start,
//                         alerts list + resolve).
//
// Behavior is byte-equivalent to the inline declarations: same SQL, same
// response shape, same cache-invalidation side effects, same console.log
// audit on PATCH, same Sentry capture on 500.
//
// HARD RULE — `feedback_mailbox_passwords_via_db`: response NEVER includes
// the raw password. `sanitizeMailboxRow` strips `password` and injects the
// derived `has_valid_password` flag. The placeholder-password detector is
// kept in sync with Go's `mailbox.IsPlaceholderPassword` (see
// modules/outreach/internal/mailbox/password_validation.go). New routes
// added in G1 do NOT echo password back — they only manipulate
// auth_fail_count / circuit state / warmup state, never the password
// itself. Password mutation stays on PATCH /api/mailboxes/:id (CRUD).
//
// HARD RULE — `feedback_anti_trace_full_stack`: none of these handlers
// dial SMTP/IMAP/SOCKS directly. /recover and /auth-reset only update
// DB state; the actual reconnect happens via the engine on next send.
//
// Routes mounted (17 total — 5 CRUD + 12 G1 admin/operational):
//   GET    /api/mailboxes
//   GET    /api/mailboxes/:id
//   POST   /api/mailboxes
//   PATCH  /api/mailboxes/:id
//   DELETE /api/mailboxes/:id
//   GET    /api/mailboxes/:id/stats
//   PATCH  /api/mailboxes/:id/warmup
//   GET    /api/mailboxes/:id/send-log
//   GET    /api/mailboxes/:id/campaigns
//   GET    /api/mailboxes/:id/watchdog-events
//   POST   /api/mailboxes/:id/recover
//   POST   /api/mailboxes/:id/auth-reset
//   GET    /api/mailboxes/:id/cooldown-log
//   GET    /api/mailboxes/:id/pipeline-results
//   POST   /api/mailboxes/:id/warmup/start
//   GET    /api/mailboxes/:id/alerts
//   PATCH  /api/mailboxes/:id/alerts/:alertId/resolve
//   POST   /api/mailboxes/:id/clear-auth-lock   (AP6 — 24h cooldown unlock)
//   PATCH  /api/mailboxes/:id/lifecycle-phase   (AH3 — operator manual phase override)
//   PATCH  /api/mailboxes/:id/status            (AH3 — operator manual status flip)

// SEND-S6.2: `m.password` is selected ONLY so the handler can derive the
// `has_valid_password` boolean. It is stripped from every JSON response
// before the row leaves the BFF (see sanitizeMailboxRow below).
// P2 FIX: proxy_url removed — deprecated since migration 077; use relay JIT lookup instead
const MB_SELECT = `
  SELECT m.id, m.from_address AS email, m.display_name,
         m.smtp_host AS host, m.smtp_port AS port, m.smtp_username, m.imap_username,
         m.imap_host, m.imap_port, m.daily_cap_override AS daily_limit,
         m.status, m.status_reason, COALESCE(m.total_sent, 0) AS total_sent, m.total_bounced, m.consecutive_bounces,
         m.last_send_at, m.tz, m.locale, m.created_at, m.updated_at,
         m.password, m.environment,
         w.warmup_day, w.plan_name AS warmup_plan, w.is_paused AS warmup_paused,
         w.started_at AS warmup_started_at, w.last_advanced_at AS warmup_last_advanced,
         w.pause_reason AS warmup_pause_reason,
         EXISTS(SELECT 1 FROM outreach_config WHERE key='anti_trace_url' AND value IS NOT NULL AND value<>'') AS anti_trace_enabled
  FROM outreach_mailboxes m
  LEFT JOIN mailbox_warmup w ON w.mailbox_address=m.from_address`

// MB_SELECT_PROD appends a WHERE clause to restrict to production mailboxes.
// Use this for all campaign-facing list queries to prevent test mailboxes
// (environment='test') from appearing even when status='active'.
const MB_SELECT_PROD = MB_SELECT + ` WHERE m.environment = 'production'`

// SEND-S6.2: placeholder-password detector. Conservative — false positives
// are cheaper than shipping a silent auth failure. Kept in sync with Go
// mailbox.IsPlaceholderPassword.
const MIN_REAL_PASSWORD_LEN = 8
const KNOWN_BAD_PREFIXES = ['xxxx', 'password', 'admin', 'test', 'heslo', 'change-me']
function hasRepeatedTrigram(s, minRepeats = 3) {
  if (typeof s !== 'string' || s.length < 3 * minRepeats) return false
  const counts = new Map()
  for (let i = 0; i + 3 <= s.length; i++) {
    const tri = s.slice(i, i + 3)
    const n = (counts.get(tri) || 0) + 1
    counts.set(tri, n)
    if (n >= minRepeats) return true
  }
  return false
}
function isPlaceholderPassword(p) {
  if (p == null || p === '') return true
  if (typeof p !== 'string') return true
  if (p.length < MIN_REAL_PASSWORD_LEN) return true
  const lower = p.toLowerCase()
  for (const prefix of KNOWN_BAD_PREFIXES) {
    if (lower.startsWith(prefix)) return true
  }
  if (hasRepeatedTrigram(p, 7)) return true
  return false
}
// Strip password + add derived has_valid_password flag. NEVER leak the raw
// password to the HTTP response.
function sanitizeMailboxRow(row) {
  const hasValidPassword = !isPlaceholderPassword(row?.password)
  const { password: _pw, ...safe } = row || {}
  return { ...safe, has_valid_password: hasValidPassword }
}

/**
 * AS3: Check how many Mullvad wgpool endpoints are still free.
 *
 * WIREPROXY_POOL_CONFIG is a JSON array of endpoint objects (same format as
 * relay's WIREPROXY_POOL_CONFIG env var). Each object has at minimum a "label"
 * field. The count of objects is the total pool size.
 *
 * @param {import('pg').Pool} pgPool
 * @param {string|undefined} env  'production' or 'test' (default 'production')
 * @returns {Promise<{pool_size: number, pinned_count: number, free_count: number, can_add: boolean}>}
 */
export async function preFlightPoolCapacity(pgPool, env) {
  let poolConfig
  try {
    poolConfig = JSON.parse(process.env.WIREPROXY_POOL_CONFIG || '[]')
  } catch {
    poolConfig = []
  }
  const totalEndpoints = Array.isArray(poolConfig) ? poolConfig.length : 0

  const environment = env || 'production'
  const { rows: [{ pinned }] } = await pgPool.query(
    `SELECT count(*)::int AS pinned
       FROM outreach_mailboxes
      WHERE pinned_endpoint_label IS NOT NULL
        AND environment = $1`,
    [environment]
  )

  const pinnedCount = pinned || 0
  return {
    pool_size: totalEndpoints,
    pinned_count: pinnedCount,
    free_count: Math.max(0, totalEndpoints - pinnedCount),
    can_add: pinnedCount < totalEndpoints,
  }
}

/**
 * Mount the mailbox CRUD + operational routes on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   setRouteTags: (tags: Record<string, unknown>) => void,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountMailboxRoutes(app, { pool, setRouteTags, capture500, safeError }) {
  app.get('/api/mailboxes', async (req, res) => {
    try {
      // ?q= is server-side search over from_address + display_name. Capped at
      // 200 chars (long strings are abusive). Whitespace-only → no filter.
      // LIKE metacharacters escaped so "50% off" doesn't wildcard everything.
      // ?all=1 lets admin/test callers see non-production mailboxes. Default is
      // production-only (environment='production') to prevent test mailboxes
      // from appearing in the UI even if their status is 'active' (J3/H6.3).
      const showAll = req.query.all === '1'
      const baseSelect = showAll ? MB_SELECT : MB_SELECT_PROD
      const q = String(req.query.q ?? '').trim().slice(0, 200)
      if (q) {
        const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
        const pattern = '%' + escaped + '%'
        const andOrWhere = showAll ? ' WHERE' : ' AND'
        const { rows } = await pool.query(
          baseSelect + `${andOrWhere} (m.from_address ILIKE $1 OR m.display_name ILIKE $1) ORDER BY m.created_at DESC`,
          [pattern]
        )
        res.json(rows.map(sanitizeMailboxRow))
      } else {
        const { rows } = await pool.query(baseSelect + ' ORDER BY m.created_at DESC')
        res.json(rows.map(sanitizeMailboxRow))
      }
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/mailboxes/:id', async (req, res, next) => {
    try {
      // Yield to sibling routes when :id is not numeric — sub-resources like
      // /api/mailboxes/health-summary live in server.js and would otherwise
      // be shadowed by this list-item route.
      const raw = req.params.id
      if (!/^\d+$/.test(raw)) return next()
      const id = Number(raw)
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' })
      const showAll = req.query.all === '1'
      const baseSelect = showAll ? MB_SELECT : MB_SELECT_PROD
      const andOrWhere = showAll ? ' WHERE' : ' AND'
      const { rows } = await pool.query(
        baseSelect + `${andOrWhere} m.id = $1 LIMIT 1`,
        [id]
      )
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
      res.json(sanitizeMailboxRow(rows[0]))
    } catch (e) { capture500(res, e, safeError) }
  })

  app.post('/api/mailboxes', async (req, res) => {
    // AS3: pre-flight pool capacity gate — refuse if all wgpool endpoints
    // are already assigned. WIREPROXY_POOL_CONFIG may be unset in dev/test
    // environments (totalEndpoints = 0) — when pool_size is 0 we skip the
    // gate to preserve backward compatibility with pools that are not yet
    // configured.
    //
    // AS3 P1.12 concurrent race fix: advisory lock (pg_advisory_xact_lock) held
    // for the duration of the transaction ensures only one mailbox creation runs
    // the capacity check + INSERT atomically. Two concurrent requests near the
    // pool limit can both pass a non-atomic pre-flight check without this lock.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Acquire transaction-scoped advisory lock for mailbox_creation.
      // Lock is released automatically at COMMIT/ROLLBACK — no explicit release needed.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('mailbox_creation'))")

      try {
        const cap = await preFlightPoolCapacity(pool, req.body.environment || 'production')
        if (cap.pool_size > 0 && !cap.can_add) {
          await client.query('ROLLBACK')
          // client released in the finally block below
          return res.status(503).json({
            error: 'pool_exhausted',
            pool_size: cap.pool_size,
            pinned_count: cap.pinned_count,
            message: 'All Mullvad endpoints already assigned. Expand WIREPROXY_POOL_CONFIG before adding more mailboxes.',
            runbook: 'docs/playbooks/mullvad-pool-expansion.md',
          })
        }
      } catch (capacityErr) {
        // Non-fatal: if capacity check fails (e.g. table missing in older dev
        // schema), log and proceed — adding the mailbox is still better than
        // silently blocking on a capacity check error.
        console.warn('[mailboxes] pool capacity pre-flight failed:', capacityErr?.message)
      }

      const b = req.body
      const { rows } = await client.query(`
        INSERT INTO outreach_mailboxes(from_address,display_name,smtp_host,smtp_port,smtp_username,password,daily_cap_override,imap_host,imap_port)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING id, from_address AS email, display_name, smtp_host AS host, smtp_port AS port,
                  smtp_username, imap_host, imap_port, status, status_reason,
                  daily_cap_override AS daily_limit, total_sent, total_bounced, consecutive_bounces,
                  last_send_at, created_at, updated_at`,
        [b.email, b.display_name||b.email, b.smtp_host, b.smtp_port||587,
         b.smtp_username||b.email, b.password, b.daily_limit||100, b.imap_host||null, b.imap_port||null]
      )
      const newMailbox = rows[0]

      // Audit log the creation
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('mailbox_create', 'dashboard', 'mailbox', $1, $2::jsonb)`,
        [String(newMailbox.id), JSON.stringify({
          id: newMailbox.id,
          email: newMailbox.email,
          host: newMailbox.host,
          display_name: newMailbox.display_name
        })]
      )

      await client.query('COMMIT')
      res.json(newMailbox)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  app.patch('/api/mailboxes/:id', async (req, res) => {
    setRouteTags({ 'mailbox.id': req.params.id, 'mailbox.action': 'update' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Fetch current state for audit comparison
      const { rows: [before] } = await client.query(
        'SELECT id, status, daily_cap_override FROM outreach_mailboxes WHERE id=$1',
        [req.params.id]
      )
      if (!before) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'not_found' })
      }

      const FIELD_MAP = {
        status: 'status', display_name: 'display_name',
        smtp_host: 'smtp_host', smtp_port: 'smtp_port', smtp_username: 'smtp_username',
        imap_host: 'imap_host', imap_port: 'imap_port', imap_username: 'imap_username',
        daily_cap_override: 'daily_cap_override', daily_limit: 'daily_cap_override',
        // P2 FIX: proxy_url removed — deprecated since migration 077
      }
      const sets=[], params=[]
      let p=1
      const usedCols = new Set()
      for (const [bodyKey, col] of Object.entries(FIELD_MAP)) {
        if (req.body[bodyKey] !== undefined && !usedCols.has(col)) {
          usedCols.add(col)
          sets.push(`${col}=$${p++}`)
          params.push(req.body[bodyKey] ?? null)
        }
      }
      if (req.body.password) { sets.push(`password=$${p++}`); params.push(req.body.password) }
      if (!sets.length) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'nothing_to_update' })
      }
      params.push(req.params.id)
      await client.query(
        `UPDATE outreach_mailboxes SET ${sets.join(',')} WHERE id=$${p}`, params)
      console.log('[patch] mailbox', req.params.id, 'fields:', [...usedCols, ...(req.body.password ? ['password'] : [])])
      // Fetch full MB_SELECT shape so FE gets warmup_*, environment, anti_trace_enabled
      // without needing a second GET /api/mailboxes/:id call.
      const showAll = req.query.all === '1'
      const baseSelect = showAll ? MB_SELECT : MB_SELECT_PROD
      const andOrWhere = showAll ? ' WHERE' : ' AND'
      const { rows } = await client.query(
        baseSelect + `${andOrWhere} m.id = $1 LIMIT 1`,
        [req.params.id]
      )

      // Audit log status changes
      if (usedCols.has('status') && req.body.status !== before.status) {
        const action = req.body.status === 'paused' ? 'mailbox_pause' : 'mailbox_resume'
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ($1, 'dashboard', 'mailbox', $2, $3::jsonb)`,
          [action, String(req.params.id), JSON.stringify({
            prev_status: before.status,
            new_status: req.body.status
          })]
        )
      }

      // Audit log daily-cap changes — operator-visible cap mutation must leave a
      // trail. FIELD_MAP routes both `daily_cap_override` and `daily_limit` to the
      // same column, so resolve the new value the same way the UPDATE did.
      if (usedCols.has('daily_cap_override')) {
        const newCap = req.body.daily_cap_override !== undefined
          ? (req.body.daily_cap_override ?? null)
          : (req.body.daily_limit ?? null)
        const normCap = v => (v === null || v === undefined || v === '') ? null : Number(v)
        if (normCap(newCap) !== normCap(before.daily_cap_override)) {
          await client.query(
            `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
             VALUES ('mailbox_cap_update', 'dashboard', 'mailbox', $1, $2::jsonb)`,
            [String(req.params.id), JSON.stringify({
              prev_cap: before.daily_cap_override,
              new_cap: newCap
            })]
          )
        }
      }

      // Audit log credential/host changes (#842 mailbox_credentials_update)
      const CREDENTIAL_COLS = new Set(['smtp_host', 'smtp_port', 'smtp_username', 'imap_host', 'imap_port', 'imap_username'])
      const touchesCreds = [...usedCols].some(c => CREDENTIAL_COLS.has(c)) || !!req.body.password
      if (touchesCreds) {
        const changedFields = [...usedCols].filter(c => CREDENTIAL_COLS.has(c))
        if (req.body.password) changedFields.push('password')
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('mailbox_credentials_update', 'dashboard', 'mailbox', $1, $2::jsonb)`,
          [String(req.params.id), JSON.stringify({ changed_fields: changedFields })]
        )
      }

      await client.query('COMMIT')

      // Cache invalidation — fields that affect the probe outcome (creds / host / port)
      // make the cached score stale, so drop the cache entry. Next /full-check or
      // /health-summary re-runs against fresh state.
      // P2 FIX: proxy_url removed — deprecated since migration 077
      const probeAffecting = new Set([
        'password', 'smtp_host', 'smtp_port', 'smtp_username',
        'imap_host', 'imap_port', 'imap_username',
      ])
      const touchesProbe =
        [...usedCols].some(c => probeAffecting.has(c)) || !!req.body.password
      if (touchesProbe) {
        pool.query('DELETE FROM mailbox_check_cache WHERE mailbox_id=$1', [req.params.id])
          .catch(e => console.warn('[patch] cache invalidate failed:', e.message))
      }
      res.json(rows.length ? sanitizeMailboxRow(rows[0]) : { id: Number(req.params.id) })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  app.delete('/api/mailboxes/:id', async (req, res) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Fetch the mailbox for audit details before deletion
      const { rows: [mailbox] } = await client.query(
        'SELECT id, email, from_address FROM outreach_mailboxes WHERE id=$1',
        [req.params.id]
      )
      if (!mailbox) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'mailbox_not_found' })
      }

      // Delete the mailbox
      await client.query('DELETE FROM outreach_mailboxes WHERE id=$1', [req.params.id])

      // Audit log the deletion
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('mailbox_delete', 'dashboard', 'mailbox', $1, $2::jsonb)`,
        [String(req.params.id), JSON.stringify({
          id: mailbox.id,
          email: mailbox.email,
          from_address: mailbox.from_address
        })]
      )

      await client.query('COMMIT')
      res.json({ ok: true })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // ── G1 Batch A: operational/admin routes (extracted from server.js) ────────

  app.get('/api/mailboxes/:id/stats', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT m.total_sent, m.total_bounced, m.consecutive_bounces,
                COALESCE((SELECT COUNT(*) FROM send_events WHERE mailbox_used=m.from_address AND sent_at>now()-interval'30d'),0) AS sent_30d
         FROM outreach_mailboxes m WHERE m.id=$1`, [req.params.id])
      res.json(rows[0] || {total_sent:0,total_bounced:0,sent_30d:0,consecutive_bounces:0})
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── ADD-4: 7-day health-history trend for one mailbox ────────────────
  // GET /api/mailboxes/:id/health-history?days=N
  //   Returns daily aggregates of sent / bounced events + average mailbox
  //   reputation score across the requested window. Used by the
  //   MailboxHealthChart component on the MailboxDrawer "Pokročilé" section.
  //
  //   Output: { days: [{ day, sends, bounces, bounce_rate_pct, avg_score }] }
  //
  //   `days` query param defaults to MAILBOX_HEALTH_TREND_DAYS from
  //   lib/leadTierThresholds.js (per HARD RULE feedback_no_magic_thresholds).
  //   Capped at 30 to keep response size bounded.
  app.get('/api/mailboxes/:id/health-history', async (req, res) => {
    try {
      const rawId = String(req.params.id || '')
      if (!/^\d+$/.test(rawId)) return res.status(400).json({ error: 'invalid_id' })
      const id = Number(rawId)
      // Hard cap at 30 days — bigger windows belong to dedicated analytics
      // surface, not this drawer widget.
      const daysParam = clampInt(Number(req.query.days) || 7, 1, 30)

      const { rows: mb } = await pool.query(
        'SELECT from_address FROM outreach_mailboxes WHERE id=$1',
        [id],
      )
      if (!mb.length) return res.status(404).json({ error: 'not_found' })
      const fromAddress = mb[0].from_address

      // Group send_events by Europe/Prague calendar day. We LEFT JOIN
      // bounce_events on send_event_id so a single bounced send_event
      // contributes 1 bounce row even if multiple BE rows were emitted.
      const { rows } = await pool.query(
        `
        WITH days AS (
          SELECT generate_series(
            date_trunc('day', (now() AT TIME ZONE 'Europe/Prague')) - ($1::int - 1) * interval '1 day',
            date_trunc('day', (now() AT TIME ZONE 'Europe/Prague')),
            interval '1 day'
          ) AS day
        ),
        agg AS (
          SELECT
            date_trunc('day', (se.sent_at AT TIME ZONE 'Europe/Prague')) AS day,
            COUNT(*) FILTER (WHERE se.status IN ('sent','queued','bounced','failed'))::int AS sends,
            COUNT(*) FILTER (WHERE se.status = 'bounced')::int AS bounces
          FROM send_events se
          WHERE se.mailbox_used = $2
            AND se.sent_at >= date_trunc('day', (now() AT TIME ZONE 'Europe/Prague')) - ($1::int - 1) * interval '1 day'
          GROUP BY 1
        )
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
               COALESCE(a.sends, 0)   AS sends,
               COALESCE(a.bounces, 0) AS bounces
        FROM days d
        LEFT JOIN agg a ON a.day = d.day
        ORDER BY d.day
        `,
        [daysParam, fromAddress],
      )

      // last_score lives on outreach_mailboxes (single row, no per-day
      // history table at the moment). Surface it once at top level so the
      // chart can paint a single horizontal reputation line.
      const { rows: scoreRows } = await pool.query(
        'SELECT last_score, last_score_at FROM outreach_mailboxes WHERE id=$1',
        [id],
      )
      const lastScore = scoreRows[0]?.last_score ?? null
      const lastScoreAt = scoreRows[0]?.last_score_at ?? null

      const series = rows.map(r => {
        const sends = Number(r.sends) || 0
        const bounces = Number(r.bounces) || 0
        const bounceRatePct = sends > 0 ? Math.round((bounces / sends) * 1000) / 10 : 0
        return {
          day: r.day,
          sends,
          bounces,
          bounce_rate_pct: bounceRatePct,
        }
      })

      res.json({
        mailbox_id: id,
        days_requested: daysParam,
        last_score: lastScore != null ? Number(lastScore) : null,
        last_score_at: lastScoreAt,
        series,
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.patch('/api/mailboxes/:id/warmup', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT from_address FROM outreach_mailboxes WHERE id=$1',[req.params.id])
      if (!rows.length) return res.status(404).json({ error: 'not_found' })
      await pool.query('UPDATE mailbox_warmup SET is_paused=$1 WHERE mailbox_address=$2',[req.body.paused,rows[0].from_address])
      res.json({ok:true})
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── Mailbox send-log ───────────────────────────────────────────────
  app.get('/api/mailboxes/:id/send-log', async (req, res) => {
    try {
      const { rows: mb } = await pool.query('SELECT from_address FROM outreach_mailboxes WHERE id=$1', [req.params.id])
      if (!mb.length) return res.status(404).json({ error: 'not_found' })
      const { rows } = await pool.query(
        `SELECT se.sent_at, se.status, se.subject, se.smtp_response,
                c.email AS contact_email, c.first_name, c.last_name, c.company_name
         FROM send_events se
         LEFT JOIN contacts c ON c.id = se.contact_id
         WHERE se.mailbox_used=$1 ORDER BY se.sent_at DESC LIMIT 30`,
        [mb[0].from_address]
      )
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── Mailbox → Campaigns usage (KT-A28 drawer "Použití" section) ──
  // Returns campaigns where this mailbox has been used (joined via
  // send_events.mailbox_used = outreach_mailboxes.from_address). Pure read
  // path used by the MailboxDrawer "Použití" section to render
  // "Použito v N kampaních" + a link to CampaignDetail.
  app.get('/api/mailboxes/:id/campaigns', async (req, res) => {
    try {
      const { rows: mb } = await pool.query(
        'SELECT from_address FROM outreach_mailboxes WHERE id=$1',
        [req.params.id],
      )
      if (!mb.length) return res.status(404).json({ error: 'not_found' })
      const { rows } = await pool.query(
        `SELECT c.id, c.name, c.status,
                COUNT(se.id)::int AS sent_count,
                MAX(se.sent_at)   AS last_sent_at
         FROM send_events se
         JOIN campaigns c ON c.id = se.campaign_id
         WHERE se.mailbox_used = $1
         GROUP BY c.id, c.name, c.status
         ORDER BY MAX(se.sent_at) DESC NULLS LAST
         LIMIT 50`,
        [mb[0].from_address],
      )
      res.json({ total: rows.length, campaigns: rows })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── Watchdog self-heal timeline for one mailbox ──────────────────
  app.get('/api/mailboxes/:id/watchdog-events', async (req, res) => {
    try {
      const limit = clampInt(Number(req.query.limit || 10), 1, 50)
      const { rows } = await pool.query(
        `SELECT id, event_type, auto_healed, reason, metadata, created_at
         FROM watchdog_events
         WHERE mailbox_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [req.params.id, limit]
      )
      res.json(rows)
    } catch (e) {
      // Table may not exist yet (migration pending). Return empty timeline
      // instead of 500 so the drawer renders gracefully.
      if (/relation .* does not exist/i.test(e.message)) return res.json([])
      return capture500(res, e, safeError)
    }
  })

  // ── Manual "Recover now" — operator force-releases a mailbox ─────
  // Resets status to active, zeroes consecutive_bounces, seeds a 10-send
  // canary window, closes any open cooldown log row, and records a
  // manual_trigger watchdog event so the timeline captures the action.
  // Safe to call on already-active mailboxes (idempotent).
  app.post('/api/mailboxes/:id/recover', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' })
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : 'operator_recover'
    const canaryCount = 10
    try {
      const { rows } = await pool.query(
        `UPDATE outreach_mailboxes
            SET status               = 'active',
                status_reason        = 'manual_recover',
                consecutive_bounces  = 0,
                canary_remaining     = $2,
                released_at          = now(),
                last_canary_send     = NULL,
                circuit_opened_at    = NULL
          WHERE id = $1
          RETURNING id, from_address, status`,
        [id, canaryCount]
      )
      if (!rows.length) return res.status(404).json({ error: 'not_found' })

      // Best-effort: close any open cooldown row and record watchdog event.
      try {
        await pool.query(
          `UPDATE mailbox_cooldown_log
              SET left_at = now(),
                  release_reason = 'manual_recover',
                  release_window_hours = 0
            WHERE mailbox_id = $1 AND left_at IS NULL`,
          [id]
        )
      } catch {}
      try {
        await pool.query(
          `INSERT INTO watchdog_events (mailbox_id, event_type, auto_healed, reason, metadata)
           VALUES ($1, 'manual_trigger', false, $2, $3::jsonb)`,
          [id, reason, JSON.stringify({ canary_remaining: canaryCount })]
        )
      } catch {}
      res.json({ ok: true, mailbox: rows[0], canary_remaining: canaryCount })
    } catch (e) {
      return capture500(res, e, safeError)
    }
  })

  // ── SEND-S2: operator-triggered AUTH reset ──────────────────────
  // After operator fixes a mailbox password via UI, the auth_fail_count still
  // reflects pre-fix failures and existing auth_fail_alert watchdog rows keep
  // the banner red. This endpoint zeroes the counter, closes the circuit, and
  // marks outstanding alerts as healed so the banner clears immediately. Never
  // touches consecutive_bounces or status — that's /recover's job.
  app.post('/api/mailboxes/:id/auth-reset', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' })
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : 'operator_reset'
    try {
      const { rows } = await pool.query(
        `UPDATE outreach_mailboxes
            SET auth_fail_count   = 0,
                auth_fail_at      = NULL,
                circuit_opened_at = NULL
          WHERE id = $1
          RETURNING id, from_address, auth_fail_count, circuit_opened_at`,
        [id]
      )
      if (!rows.length) return res.status(404).json({ error: 'not_found' })

      // Best-effort: mark active auth_fail_alert rows as healed so the banner
      // clears. Also insert an audit row so the timeline captures the action.
      try {
        await pool.query(
          `UPDATE watchdog_events
              SET auto_healed = true, healed_at = now()
            WHERE mailbox_id = $1
              AND event_type = 'auth_fail_alert'
              AND auto_healed = false`,
          [id]
        )
      } catch {}
      try {
        await pool.query(
          `INSERT INTO watchdog_events (mailbox_id, event_type, auto_healed, reason)
           VALUES ($1, 'auth_reset', true, $2)`,
          [id, reason]
        )
      } catch {}
      res.json({ ok: true, mailbox: rows[0] })
    } catch (e) {
      return capture500(res, e, safeError)
    }
  })

  // ── Bounce-hold cooldown audit log for one mailbox ───────────────
  app.get('/api/mailboxes/:id/cooldown-log', async (req, res) => {
    try {
      const limit = clampInt(Number(req.query.limit || 20), 1, 100)
      const { rows } = await pool.query(
        `SELECT id, entered_at, left_at, bounces_at_entry, sent_7d_at_entry,
                release_reason, release_window_hours
           FROM mailbox_cooldown_log
          WHERE mailbox_id = $1
          ORDER BY entered_at DESC
          LIMIT $2`,
        [req.params.id, limit]
      )
      res.json(rows)
    } catch (e) {
      if (/relation .* does not exist/i.test(e.message)) return res.json([])
      return capture500(res, e, safeError)
    }
  })

  // ── Mailbox pipeline results (written by Go backend) ──────────────
  app.get('/api/mailboxes/:id/pipeline-results', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, overall_ok, steps, tested_at FROM mailbox_pipeline_results
         WHERE mailbox_id=$1 ORDER BY tested_at DESC LIMIT 5`,
        [req.params.id]
      )
      // Normalize: ensure every section has a steps array (older rows may not)
      const normalized = rows.map(r => {
        const s = r.steps || {}
        const norm = k => s[k] == null ? s[k] : { ...s[k], steps: Array.isArray(s[k].steps) ? s[k].steps : [] }
        return { ...r, steps: { ...s, smtp: norm('smtp'), imap: norm('imap'), warmup: norm('warmup'), backpressure: norm('backpressure') } }
      })
      res.json(normalized)
    } catch (e) { capture500(res, e, safeError) }
  })

  // Start warmup for a mailbox
  app.post('/api/mailboxes/:id/warmup/start', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT from_address FROM outreach_mailboxes WHERE id=$1`, [req.params.id])
      if (!rows.length) return res.status(404).json({ error: 'not_found' })
      const addr = rows[0].from_address
      await pool.query(
        `INSERT INTO mailbox_warmup(mailbox_address, warmup_day, is_paused, last_advanced_at)
         VALUES($1, 1, false, now())
         ON CONFLICT(mailbox_address) DO UPDATE
           SET warmup_day = COALESCE(mailbox_warmup.warmup_day, 1),
               is_paused = false,
               last_advanced_at = CASE WHEN mailbox_warmup.last_advanced_at IS NULL THEN now()
                                       ELSE mailbox_warmup.last_advanced_at END`,
        [addr])
      res.json({ ok: true, mailbox_address: addr })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── Mailbox alerts ────────────────────────────────────────────────
  app.get('/api/mailboxes/:id/alerts', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, type, severity, message, created_at, resolved_at
         FROM mailbox_alerts WHERE mailbox_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [req.params.id]
      )
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })

  app.patch('/api/mailboxes/:id/alerts/:alertId/resolve', async (req, res) => {
    try {
      await pool.query(
        `UPDATE mailbox_alerts SET resolved_at=now() WHERE id=$1 AND mailbox_id=$2`,
        [req.params.alertId, req.params.id]
      )
      res.json({ ok: true })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── AP6: operator unlock after 24h cooldown ─────────────────────────────
  // POST /api/mailboxes/:id/clear-auth-lock
  //
  // Requires X-Confirm-Send: yes header (operator intent guard).
  // Returns HTTP 425 with { hours_remaining } if 24h cooldown not elapsed.
  // On success sets status='paused' (NOT 'active') — operator must explicitly
  // resume so they are forced to sanity-check credentials first.
  app.post('/api/mailboxes/:id/clear-auth-lock', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' })

    // Operator intent guard
    if (req.headers['x-confirm-send'] !== 'yes') {
      return res.status(403).json({ error: 'missing X-Confirm-Send: yes header' })
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : 'operator_manual_review'

    try {
      // Check mailbox exists + get lock state
      const { rows: mbRows } = await pool.query(
        `SELECT id, status, from_address, auth_locked_at FROM outreach_mailboxes WHERE id=$1`,
        [id]
      )
      if (!mbRows.length) return res.status(404).json({ error: 'not_found' })

      const mb = mbRows[0]
      if (mb.status !== 'auth_locked') {
        return res.status(409).json({ error: 'mailbox is not in auth_locked status', status: mb.status })
      }

      // 24h cooldown check
      const unlockInfo = await canUnlock(pool, id)
      if (!unlockInfo.cooldown_passed) {
        return res.status(425).json({
          error: 'cooldown_not_elapsed',
          hours_remaining: unlockInfo.hours_remaining,
          locked_at: unlockInfo.locked_at,
        })
      }

      // Unlock: set to 'paused' so operator must explicitly resume after credential check
      const { rows: updated } = await pool.query(
        `UPDATE outreach_mailboxes
            SET status                  = 'paused',
                status_reason           = $2,
                auth_locked_at          = NULL,
                auth_locked_reason      = NULL,
                auth_locked_by_observer = NULL
          WHERE id = $1
            AND status = 'auth_locked'
          RETURNING id, from_address, status`,
        [id, `operator_unlock: ${reason}`]
      )
      if (!updated.length) return res.status(409).json({ error: 'concurrent update: mailbox no longer auth_locked' })

      // Audit trail
      try {
        await pool.query(
          `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
           VALUES('auth_lock_cleared', 'operator', 'mailbox', $1, $2::jsonb)`,
          [id, JSON.stringify({ reason, from_address: mb.from_address, locked_at: mb.auth_locked_at })]
        )
      } catch {}

      // Best-effort: heal outstanding auth_locked alerts
      try {
        await pool.query(
          `UPDATE mailbox_alerts SET resolved_at=now() WHERE mailbox_id=$1 AND type='auth_locked' AND resolved_at IS NULL`,
          [id]
        )
      } catch {}

      res.json({ ok: true, mailbox: updated[0] })
    } catch (e) {
      return capture500(res, e, safeError)
    }
  })

  // ── AH3 + AJ10d: operator manual lifecycle phase override ──────────────
  // PATCH /api/mailboxes/:id/lifecycle-phase
  //
  // Operator wants to manually advance / skip warmup ramp on a specific
  // mailbox. Replaces 4× SQL UPDATE workflow (mb 1180-1183 warmup_d0 →
  // production on 2026-05-14). AJ10d (2026-05-16) adds "auto" mode
  // (lifecycle_phase: null) which lets advance_lifecycle_phase() compute
  // the canonical phase from created_at — used after operator un-pin.
  //
  // HARD RULES enforced:
  //   - feedback_audit_log_on_mutations (T0): mutation + audit row in
  //     the same transaction so we never silently flip phase without trail.
  //   - feedback_no_magic_thresholds (T0): valid phase enum imported
  //     from lifecyclePhaseCaps.PHASE_ORDER — never inline 'warmup_d0'
  //     etc. literals in handler validation.
  //   - feedback_schema_verify_before_sql (T0): columns verified —
  //     outreach_mailboxes.{id, lifecycle_phase, created_at, updated_at,
  //     from_address}. `compute_phase_cap(text)` + `advance_lifecycle_phase()`
  //     functions verified via `\df` 2026-05-16.
  //   - Operator intent gate: requires X-Confirm-Send: yes header + body
  //     `{confirm: true}` (two-factor consent for destructive op).
  //
  // Request body:
  //   { lifecycle_phase: 'production', reason: '...', confirm: true }  (pin)
  //   { lifecycle_phase: null,         reason: '...', confirm: true }  (auto)
  //
  // AJ10d back-compat: also accepts legacy `phase` field for callers that
  // haven't migrated. New callers should use `lifecycle_phase`.
  //
  // Response: 200 { ok: true, mailbox: { id, from_address, lifecycle_phase },
  //                old_phase, new_phase, effective_cap }
  //
  // Validation:
  //   - lifecycle_phase must be one of PHASE_ORDER values OR null (auto)
  //   - reason required (non-empty string, ≤200 chars)
  //   - confirm:true required (operator must opt in explicitly)
  //   - X-Confirm-Send: yes header required
  app.patch('/api/mailboxes/:id/lifecycle-phase', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' })
    }

    // Operator intent gate (header)
    if (req.headers['x-confirm-send'] !== 'yes') {
      return res.status(403).json({ error: 'missing X-Confirm-Send: yes header' })
    }

    const body = req.body || {}

    // AJ10d: prefer lifecycle_phase (matches DB column name + Czech-readable);
    // fall back to legacy `phase` for callers that haven't migrated.
    // `null` means "remove operator pin, let cron decide" (auto mode).
    const hasLifecyclePhaseKey = Object.prototype.hasOwnProperty.call(body, 'lifecycle_phase')
    const hasPhaseKey = Object.prototype.hasOwnProperty.call(body, 'phase')
    let phaseInput
    if (hasLifecyclePhaseKey) {
      phaseInput = body.lifecycle_phase
    } else if (hasPhaseKey) {
      phaseInput = body.phase
    } else {
      phaseInput = undefined
    }

    const rawReason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const confirm = body.confirm === true

    // Validation — phase must be one of allowed values OR null (auto).
    // Distinguish "field missing" (400) from "field=null" (auto mode OK).
    const isAuto = phaseInput === null
    const isExplicit = typeof phaseInput === 'string' && PHASE_ORDER.includes(phaseInput)
    if (!isAuto && !isExplicit) {
      return res.status(400).json({
        error: 'invalid_phase',
        allowed: PHASE_ORDER,
        auto_mode_value: null,
      })
    }
    if (!rawReason) {
      return res.status(400).json({ error: 'reason_required' })
    }
    if (rawReason.length > 200) {
      return res.status(400).json({ error: 'reason_too_long', max: 200 })
    }
    if (!confirm) {
      return res.status(400).json({ error: 'confirm_required' })
    }
    const reason = rawReason.slice(0, 200)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // SELECT current state — needed for audit "from" + auto-mode resolution.
      const { rows: cur } = await client.query(
        `SELECT id, from_address, lifecycle_phase, daily_cap_override, created_at
           FROM outreach_mailboxes
          WHERE id=$1
            FOR UPDATE`,
        [id],
      )
      if (!cur.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'not_found' })
      }
      const oldPhase = cur[0].lifecycle_phase
      const fromAddress = cur[0].from_address
      const dailyCapOverride = cur[0].daily_cap_override
      const createdAt = cur[0].created_at

      // Resolve target phase. In auto mode we ask the DB to compute the
      // canonical phase (mirrors advance_lifecycle_phase() logic) so the
      // single source of truth stays SQL-side.
      let targetPhase
      if (isAuto) {
        // CASE matches advance_lifecycle_phase() exactly — keep in sync.
        const { rows: autoRows } = await client.query(
          `SELECT CASE
                    WHEN NOW() - $1::timestamptz >= INTERVAL '30 days' THEN 'production'
                    WHEN NOW() - $1::timestamptz >= INTERVAL '14 days' THEN 'warmup_d14'
                    WHEN NOW() - $1::timestamptz >= INTERVAL '7 days'  THEN 'warmup_d7'
                    WHEN NOW() - $1::timestamptz >= INTERVAL '3 days'  THEN 'warmup_d3'
                    ELSE 'warmup_d0'
                  END AS phase`,
          [createdAt],
        )
        targetPhase = autoRows[0]?.phase || 'warmup_d0'
      } else {
        targetPhase = phaseInput
      }

      // UPDATE phase + read effective cap in the same statement so the
      // response carries authoritative numbers (no client recompute).
      const { rows: updated } = await client.query(
        `UPDATE outreach_mailboxes
            SET lifecycle_phase = $2,
                updated_at      = NOW()
          WHERE id = $1
        RETURNING id, from_address, lifecycle_phase,
                  compute_daily_cap(lifecycle_phase, daily_cap_override) AS effective_cap`,
        [id, targetPhase],
      )

      // Audit row in same tx (HARD: feedback_audit_log_on_mutations).
      // `auto` flag preserves operator intent (auto vs explicit pin) so we
      // can later distinguish "operator wanted cron schedule" from
      // "operator pinned warmup_d0 explicitly".
      await client.query(
        `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
         VALUES('mailbox.lifecycle_phase_change', 'operator', 'mailbox', $1, $2::jsonb)`,
        [id, JSON.stringify({
          from: oldPhase,
          to: targetPhase,
          auto: isAuto,
          reason,
          from_address: fromAddress,
          effective_cap_before: cur[0].daily_cap_override == null
            ? null
            : Number(dailyCapOverride),
          effective_cap_after: updated[0]?.effective_cap,
        })],
      )

      await client.query('COMMIT')
      return res.json({
        ok: true,
        mailbox: {
          id: updated[0].id,
          from_address: updated[0].from_address,
          lifecycle_phase: updated[0].lifecycle_phase,
        },
        old_phase: oldPhase,
        new_phase: targetPhase,
        effective_cap: updated[0].effective_cap,
        auto: isAuto,
      })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      return capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // ── AH3: operator manual status flip (active ↔ paused) ──────────────────
  // PATCH /api/mailboxes/:id/status
  //
  // Operator wants to manually pause or activate a mailbox (e.g. post-bounce
  // unpause for mb 1180 + 1183 on 2026-05-14). Whitelisted to ['active',
  // 'paused'] only — destructive states ('retired', 'auth_locked') are NOT
  // reachable from this endpoint. Use dedicated endpoints for those.
  //
  // HARD RULES enforced:
  //   - feedback_audit_log_on_mutations (T0): UPDATE + audit row in same tx
  //   - feedback_no_magic_thresholds (T0): status enum is a named const here
  //   - feedback_schema_verify_before_sql (T0): columns verified —
  //     outreach_mailboxes.{id, status, status_reason, updated_at, from_address}
  //   - Operator intent gate: X-Confirm-Send: yes header + confirm:true body
  //
  // Request body: { status: 'active' | 'paused', reason: '...', confirm: true }
  //
  // - reason REQUIRED for 'active' (=unpause — operator must justify)
  // - reason OPTIONAL for 'paused' (defaults to 'operator_manual_pause')
  const STATUS_ENUM_ALLOWED = ['active', 'paused']

  app.patch('/api/mailboxes/:id/status', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' })
    }

    // Operator intent gate
    if (req.headers['x-confirm-send'] !== 'yes') {
      return res.status(403).json({ error: 'missing X-Confirm-Send: yes header' })
    }

    const body = req.body || {}
    const status = typeof body.status === 'string' ? body.status : null
    const rawReason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const confirm = body.confirm === true

    if (!status || !STATUS_ENUM_ALLOWED.includes(status)) {
      return res.status(400).json({
        error: 'invalid_status',
        allowed: STATUS_ENUM_ALLOWED,
      })
    }
    if (!confirm) {
      return res.status(400).json({ error: 'confirm_required' })
    }
    // 'active' requires explicit reason (operator must justify unpause)
    if (status === 'active' && !rawReason) {
      return res.status(400).json({ error: 'reason_required_for_activate' })
    }
    if (rawReason.length > 200) {
      return res.status(400).json({ error: 'reason_too_long', max: 200 })
    }
    const reason = rawReason
      ? rawReason.slice(0, 200)
      : (status === 'paused' ? 'operator_manual_pause' : '')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // SELECT current state for audit "from"
      const { rows: cur } = await client.query(
        `SELECT id, from_address, status, status_reason
           FROM outreach_mailboxes WHERE id=$1 FOR UPDATE`,
        [id],
      )
      if (!cur.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'not_found' })
      }
      const oldStatus = cur[0].status
      const oldReason = cur[0].status_reason
      const fromAddress = cur[0].from_address

      // Defense-in-depth: refuse to overwrite destructive states via this
      // endpoint. Operator must use dedicated unlock route for auth_locked
      // or a separate admin action for retired.
      if (oldStatus === 'auth_locked' || oldStatus === 'retired') {
        await client.query('ROLLBACK')
        return res.status(409).json({
          error: 'destructive_status_requires_dedicated_endpoint',
          current_status: oldStatus,
        })
      }

      const { rows: updated } = await client.query(
        `UPDATE outreach_mailboxes
            SET status        = $2,
                status_reason = $3,
                updated_at    = NOW()
          WHERE id = $1
        RETURNING id, from_address, status, status_reason`,
        [id, status, reason],
      )

      // Audit row in same tx
      await client.query(
        `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
         VALUES('mailbox.status_change', 'operator', 'mailbox', $1, $2::jsonb)`,
        [id, JSON.stringify({
          from: oldStatus,
          to: status,
          from_reason: oldReason,
          to_reason: reason,
          from_address: fromAddress,
        })],
      )

      await client.query('COMMIT')
      return res.json({ ok: true, mailbox: updated[0] })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      return capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // ── F3: Per-mailbox live diagnose ────────────────────────────────────────
  //
  // POST /api/mailboxes/:id/diagnose
  //
  // HARD RULES:
  //   - feedback_no_pii_in_commands: mailbox password fetched inline, NEVER
  //     logged, NEVER included in audit details or HTTP response.
  //   - feedback_no_direct_smtp: all SMTP/IMAP probing goes via relay
  //     /v1/probe, BFF never dials SMTP/IMAP directly.
  //   - Rate limit: 1 call / 2 min per mailbox (diagnose op in
  //     mailbox_op_rate_log, cap defined in mailboxOpRateLimit.js).
  //   - Audit log: operator_audit_log action='mailbox_diagnose'.
  //   - 30s hard cap overall (relay already caps per individual check at 28s).
  app.post('/api/mailboxes/:id/diagnose', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' })
    }

    // Fetch mailbox row — password included for relay forwarding, never echoed.
    let mb
    try {
      const { rows } = await pool.query(
        `SELECT id, from_address, smtp_host, smtp_port, smtp_username, password,
                imap_host, imap_port, imap_username, environment
           FROM outreach_mailboxes WHERE id=$1 LIMIT 1`,
        [id]
      )
      if (!rows.length) return res.status(404).json({ error: 'not_found' })
      mb = rows[0]
    } catch (e) {
      return capture500(res, e, safeError)
    }

    // Rate limit: max 1 diagnose per 2 min per mailbox.
    let rateCheck
    try {
      rateCheck = await checkAndRecord(pool, id, 'diagnose', {})
    } catch (e) {
      return capture500(res, e, safeError)
    }
    if (!rateCheck.allowed) {
      res.set('Retry-After', String(rateCheck.retryAfterSec || 120))
      return res.status(429).json({
        error: 'rate_limit',
        op: 'diagnose',
        used: rateCheck.used,
        max: rateCheck.max,
        retryAfterSec: rateCheck.retryAfterSec,
      })
    }

    // Audit log — best-effort, non-blocking, no password in details.
    pool.query(
      `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
       VALUES ('mailbox_diagnose', 'dashboard', 'mailbox', $1, $2::jsonb)`,
      [String(id), JSON.stringify({ mailbox_id: id, environment: mb.environment })]
    ).catch(e => console.warn('[diagnose] audit log failed:', e?.message))

    const ran_at = new Date().toISOString()
    const overallStart = Date.now()

    // ── Relay probe (SMTP + IMAP via wgpool) ─────────────────────────────────
    async function runRelayProbe() {
      const relayBase = await getRelayBase(pool)
      if (!relayBase) {
        const noRelay = { ok: false, latency_ms: null, tls_version: null, error: 'relay_not_configured' }
        return {
          smtp: { ...noRelay, auth_ok: false, banner: null },
          imap: { ...noRelay, login_ok: false, capabilities: [] },
        }
      }
      const imapUsername = mb.imap_username || mb.smtp_username
      const probeBody = {
        smtp_host:     mb.smtp_host,
        smtp_port:     Number(mb.smtp_port),
        smtp_username: mb.smtp_username,
        password:      mb.password,
        imap_host:     mb.imap_host || '',
        imap_port:     Number(mb.imap_port) || 993,
        imap_username: imapUsername,
        mailbox_id:    String(id),
      }
      const probeStart = Date.now()
      const { ok, body, error } = await relayFetch(pool, '/v1/probe', {
        method: 'POST',
        body: probeBody,
        timeoutMs: 28_000,
      })
      if (!ok) {
        const errMsg = error || 'relay probe failed'
        return {
          smtp: { ok: false, latency_ms: Date.now() - probeStart, tls_version: null, auth_ok: false, banner: null, error: errMsg },
          imap: { ok: false, latency_ms: null, tls_version: null, login_ok: false, capabilities: [], error: errMsg },
        }
      }

      // Parse SMTP section.
      const smtpRaw = body?.checks?.smtp ?? body
      const smtpOk  = smtpRaw?.ok === true
      const smtpSteps = Array.isArray(smtpRaw?.steps) ? smtpRaw.steps : []
      const smtpTlsStep    = smtpSteps.find(s => s?.name === 'tls' || s?.name === 'starttls')
      const smtpBannerStep = smtpSteps.find(s => s?.name === 'banner' || s?.name === 'greeting')
      const smtpAuthStep   = smtpSteps.find(s => s?.name === 'auth')
      const smtpResult = {
        ok:         smtpOk,
        latency_ms: smtpRaw?.ms ?? null,
        tls_version: smtpTlsStep?.detail ?? smtpTlsStep?.msg ?? null,
        auth_ok:    smtpAuthStep?.ok === true,
        banner:     smtpBannerStep?.msg ?? null,
        error:      smtpOk ? null : (smtpSteps.find(s => !s?.ok)?.msg ?? 'smtp probe failed'),
        steps:      smtpSteps,
      }

      // Parse IMAP section.
      const imapRaw = body?.checks?.imap
      let imapResult
      if (!imapRaw) {
        imapResult = {
          ok: false, latency_ms: null, tls_version: null, login_ok: false,
          capabilities: [],
          error: mb.imap_host ? 'imap check not returned by relay' : 'imap_host not configured',
        }
      } else {
        const imapOk = imapRaw?.ok === true
        const imapSteps = Array.isArray(imapRaw?.steps) ? imapRaw.steps : []
        const imapTlsStep  = imapSteps.find(s => s?.name === 'tls')
        const imapAuthStep = imapSteps.find(s => s?.name === 'auth')
        const imapCapStep  = imapSteps.find(s => s?.name === 'capability')
        const caps = imapCapStep?.msg ? imapCapStep.msg.split(/\s+/).filter(Boolean) : []
        imapResult = {
          ok:           imapOk,
          latency_ms:   imapRaw?.ms ?? null,
          tls_version:  imapTlsStep?.detail ?? imapTlsStep?.msg ?? null,
          login_ok:     imapAuthStep?.ok === true,
          capabilities: caps,
          error:        imapOk ? null : (imapSteps.find(s => !s?.ok)?.msg ?? 'imap probe failed'),
          steps:        imapSteps,
        }
      }
      return { smtp: smtpResult, imap: imapResult }
    }

    // ── DNS: MX + SPF + DKIM + DMARC ────────────────────────────────────────
    async function runDnsProbe() {
      const domain = mb.smtp_host?.split('.').slice(-2).join('.') || ''
      if (!domain) {
        return { ok: false, domain: '', error: 'no_smtp_host', mx_records: [], spf_record: null, dkim_record: null, dmarc_record: null, mx_ok: false, spf_ok: false, dkim_ok: false, dmarc_ok: false }
      }
      try {
        const dnsResult = await runDNSCheck(mb.smtp_host || '', 'default')
        // DMARC: look up _dmarc.<domain>.
        let dmarcRecord = null
        try {
          const { promises: dnsP } = await import('node:dns')
          const dmarcTxts = (await dnsP.resolveTxt(`_dmarc.${dnsResult.domain}`)).flat()
          dmarcRecord = dmarcTxts.find(t => t.startsWith('v=DMARC1')) || null
        } catch { /* not found = null */ }
        return {
          ok:           dnsResult.ok,
          domain:       dnsResult.domain,
          mx_records:   dnsResult.mx?.records ?? [],
          spf_record:   dnsResult.spf?.record ?? null,
          dkim_record:  dnsResult.dkim?.record ?? null,
          dmarc_record: dmarcRecord,
          mx_ok:        dnsResult.mx?.ok === true,
          spf_ok:       dnsResult.spf?.ok === true,
          dkim_ok:      dnsResult.dkim?.ok === true,
          dmarc_ok:     dmarcRecord != null,
        }
      } catch (e) {
        return { ok: false, domain, error: safeError(e), mx_records: [], spf_record: null, dkim_record: null, dmarc_record: null, mx_ok: false, spf_ok: false, dkim_ok: false, dmarc_ok: false }
      }
    }

    // Run both probes concurrently, 30s hard cap.
    let relayResult, dnsResult
    try {
      const timeout30s = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('diagnose_timeout')), 30_000)
      )
      ;[relayResult, dnsResult] = await Promise.race([
        Promise.all([runRelayProbe(), runDnsProbe()]),
        timeout30s.then(() => { throw new Error('diagnose_timeout') }),
      ])
    } catch (e) {
      if (safeError(e).includes('timeout')) {
        return res.status(504).json({
          error: 'diagnose_timeout',
          ran_at,
          duration_ms: Date.now() - overallStart,
        })
      }
      return capture500(res, e, safeError)
    }

    const overallOk = relayResult.smtp?.ok === true && relayResult.imap?.ok === true && dnsResult?.ok === true
    return res.json({
      ok:          overallOk,
      smtp:        relayResult.smtp,
      imap:        relayResult.imap,
      dns:         dnsResult,
      ran_at,
      duration_ms: Date.now() - overallStart,
    })
  })
}
