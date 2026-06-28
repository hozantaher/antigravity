import * as campaignPreflightModule from '../../campaignPreflight.js'
import { isWithinSendWindow } from '../lib/automation.js'
import { SUPPRESSION_LOOKUP_SQL } from '../lib/suppressionFilter.js'
import { aggregatePlacementStats } from '../lib/inboxSpamDetector.js'
import { runPreflight } from './runPreflight.js'
import { sendCampaignBatch } from '../lib/campaign-send-batch.js'

// ── Sprint T4: per-campaign send-batch rate limit ────────────────────────────
//
// In-process Map tracker. For multi-instance Railway scale, migrate to a
// Redis-backed distributed bucket.
//
// Default: max 1 send-batch request per campaign_id per 30s.
// Override: SEND_BATCH_RATE_LIMIT_MS env var (milliseconds).
//
// Exported for unit tests as _sendBatchRateLimitState.

const _sendBatchLastCall = new Map() // campaignId (number) → timestamp (ms)
const SEND_BATCH_RATE_LIMIT_MS = parseInt(process.env.SEND_BATCH_RATE_LIMIT_MS || '30000', 10)

/** @returns {{ allowed: boolean, retryAfterMs?: number, retryAfterSec?: number }} */
function checkSendBatchRateLimit (campaignId) {
  const now = Date.now()
  const last = _sendBatchLastCall.get(campaignId)
  if (last !== undefined && (now - last) < SEND_BATCH_RATE_LIMIT_MS) {
    const remainingMs = SEND_BATCH_RATE_LIMIT_MS - (now - last)
    return { allowed: false, retryAfterMs: remainingMs, retryAfterSec: Math.ceil(remainingMs / 1000) }
  }
  _sendBatchLastCall.set(campaignId, now)
  return { allowed: true }
}

// Memory hygiene — purge stale entries every 5 min.
setInterval(() => {
  const cutoff = Date.now() - SEND_BATCH_RATE_LIMIT_MS * 2
  for (const [k, v] of _sendBatchLastCall) {
    if (v < cutoff) _sendBatchLastCall.delete(k)
  }
}, 300_000).unref()

export { _sendBatchLastCall, SEND_BATCH_RATE_LIMIT_MS, checkSendBatchRateLimit }

// ── Sprint AH2: skip-by-domain bulk action thresholds ──────────────────────
//
// HARD RULE feedback_no_magic_thresholds (T0): every threshold lives as a
// named, exported constant so tests + operator docs can reference it.

/** Max number of domains accepted in one bulk skip-by-domain request. */
export const SKIP_BY_DOMAIN_MAX_DOMAINS = 50
/** Top-N domain breakdown returned in the response for the UI toast. */
export const SKIP_BY_DOMAIN_TOP_LIMIT = 10
/**
 * Statuses operator is allowed to bulk-skip. Deliberately excludes
 * 'in_sequence' / 'sent' / 'replied' so a single mis-click cannot lose
 * send history. Add new statuses here only with a follow-up audit pass.
 */
export const SKIP_BY_DOMAIN_ALLOWED_STATUSES = new Set(['pending', 'in_flight'])
/**
 * Domain validation regex — lowercase ASCII alphanumeric + dots + dashes,
 * minimum 2-char TLD. Mirrors the `HighRiskDomainsCard` validator (PR #1380)
 * so frontend + backend reject the same shapes.
 */
export const DOMAIN_VALIDATE_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/

// campaigns.category_paths is a JSON-encoded array stored in a TEXT column
// (see campaignSegmentExpansion.js parseCategoryPaths + the Go runner that
// json.Unmarshals it) — NOT a pg array. So `Array.isArray(raw)` is always
// false on the raw column value, and any handler that branched on it silently
// fell through to "no category filter" (i.e. counted the WHOLE companies
// table). Parse the TEXT form here so every analytics endpoint shares one
// decoder. Mirrors the parser the /estimate handler used inline.
function parsePaths (raw) {
  if (Array.isArray(raw)) return raw.filter(p => typeof p === 'string')
  if (typeof raw !== 'string') return []
  const t = raw.trim()
  if (!t) return []
  if (t.startsWith('[')) { try { const a = JSON.parse(t); return Array.isArray(a) ? a.filter(p => typeof p === 'string') : [] } catch { return [] } }
  if (t.startsWith('{') && t.endsWith('}')) return t.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
  return [t]
}

// BFF campaign routes — list/detail/create/update/delete + lifecycle (run /
// pause), plus operator-facing analytics (preflight, send-test, estimate,
// best-time, inbox-placement, email-quality, capacity).
// ─────────────────────────────────────────────────────────────────────────────
// Two of these handlers proxy to the Go service for state-changing flows:
//
//   POST /api/campaigns          — Go's runner.CreateCampaign owns enrollment.
//                                  Falls back to direct-DB INSERT (no
//                                  enrollment) when GO_SERVER_URL is unset
//                                  or Go is unreachable. Operator sees a
//                                  `_warning` on the legacy fallback so a
//                                  silent zero-send bug can't recur.
//   POST /api/campaigns/:id/run  — Go's HandleCampaignDetail runs SetStatus
//                                  + RunCampaign tick. Falls back to status
//                                  flip on Go-unreachable.
//   POST /api/campaigns/:id/pause— mirror of /run, status flip fallback.
//
// All other handlers query Postgres directly. The send-test handler routes
// outbound mail through the anti-trace-relay (HARD RULE: never direct SMTP).
//
// T3.4 (2026-05-01): extracted verbatim from server.js per ADR-008 D2 module
// sequence (after #459 mountHealthRoutes). Behavior is byte-equivalent to
// the inline declarations: same SQL, same response shape, same Sentry
// capture, same suppression UNION + send-window guards. Existing campaigns
// contract tests (bff-campaigns*.contract.test.ts) verify the contract from
// this file.
//
// Contiguous block extracted (server.js 1951-2453 pre-extract):
//   GET    /api/campaigns
//   POST   /api/campaigns
//   GET    /api/campaigns/:id
//   GET    /api/campaigns/:id/sends
//   GET    /api/campaigns/:id/preflight
//   POST   /api/campaigns/:id/send-test
//   GET    /api/campaigns/:id/estimate
//   GET    /api/campaigns/:id/best-time
//   GET    /api/campaigns/:id/inbox-placement
//   GET    /api/campaigns/:id/email-quality
//   GET    /api/campaigns/:id/capacity
//   POST   /api/campaigns/:id/run
//   POST   /api/campaigns/:id/pause
//   PATCH  /api/campaigns/:id
//   DELETE /api/campaigns/:id

/**
 * Mount the BFF campaign routes on an Express app.
 *
 * Note: `computeCampaignPreflight`, `isWithinSendWindow`,
 * `SUPPRESSION_LOOKUP_SQL`, and `aggregatePlacementStats` are imported
 * directly above (not injected via `deps`). Tests rely on `vi.spyOn` against
 * those modules — destructuring them into local variables would capture the
 * value at boot time and break the live binding the spies depend on.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   setRouteTags: (tags: Record<string, unknown>) => void,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 *   Sentry: { captureException: (err: unknown, ctx?: Record<string, unknown>) => void },
 * }} deps
 */
export function mountCampaignsRoutes(app, deps) {
  const {
    pool,
    setRouteTags,
    capture500,
    safeError,
    Sentry,
  } = deps

  // ── Campaigns ──────────────────────────────────────────────────────
  app.get('/api/campaigns', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.id, c.name, c.description, c.status, c.category_paths,
               c.sequence_config, c.category_match, c.created_at,
               COALESCE(jsonb_object_agg(se.status, se.cnt) FILTER (WHERE se.status IS NOT NULL), '{}') AS stats
        FROM campaigns c
        LEFT JOIN (
          SELECT campaign_id, status, COUNT(*)::int AS cnt
          FROM send_events GROUP BY campaign_id, status
        ) se ON se.campaign_id = c.id
        GROUP BY c.id ORDER BY c.created_at DESC
      `)
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })
  // S4 Cesta B: BFF proxies POST /api/campaigns to Go service. The Go-side
  // runner.CreateCampaign + enrollContacts is the canonical flow with proper
  // enrollment based on category_paths. Previous BFF direct-DB INSERT path
  // created campaigns with empty campaign_contacts (silent zero-send bug
  // — see docs/initiatives/2026-04-25-garaaage-launch-plan.md).
  //
  // Falls back to the legacy direct-DB path only when GO_SERVER_URL is unset
  // (dev / unit test environments). Production must point GO_SERVER_URL at
  // the Railway Go service.
  app.post('/api/campaigns', async (req, res) => {
    setRouteTags({ 'campaign.action': 'create' })
    try {
      const { name, description, steps, category_paths, category_match, min_score, region } = req.body
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' })

      // Pre-flight at create time: refuse a campaign whose steps reference
      // templates that don't exist in email_templates. Validates against the DB
      // — the authoritative template source since Sprint AH (both the Go runner
      // and the Node sender render from email_templates; the legacy .tmpl disk
      // files are tests-only). Fails early so the operator gets immediate
      // feedback in the wizard. Skip when steps is empty/undefined — the BFF
      // default below uses 'initial'.
      if (Array.isArray(steps) && steps.length > 0) {
        const refs = [...new Set(steps.map(s => s?.template).filter(Boolean))]
        if (refs.length > 0) {
          const { rows: present } = await pool.query(
            `SELECT name FROM email_templates WHERE name = ANY($1::text[])`,
            [refs]
          )
          const have = new Set(present.map(r => r.name))
          const missing = refs.filter(t => !have.has(t))
          if (missing.length > 0) {
            return res.status(412).json({
              error: 'preflight_failed',
              blockers: [{
                code: 'T2_missing_template',
                label: 'Šablona',
                detail: `Šablony neexistují: ${missing.join(', ')}. Vytvoř je v Šablonách nebo vyber jinou.`,
                missing_templates: missing,
                action_url: '/sablony',
              }],
              hint: 'Vyber šablonu, která existuje v email_templates.',
            })
          }
        }
      }

      const goURL = process.env.GO_SERVER_URL
      if (goURL) {
        // Forward to Go service which owns the enrollment logic.
        const goPayload = {
          name,
          description: description || '',
          category_paths: Array.isArray(category_paths) ? category_paths : [],
          category_match: category_match || 'prefix',
          min_score: typeof min_score === 'number' ? min_score : 0,
          region: region || '',
          steps: steps && steps.length ? steps : [
            { step: 0, delay_days: 0,  template: 'initial' },
          ],
        }
        try {
          // F2-4: 8s AbortSignal so a slow / hung Go upstream doesn't
          // hang the operator's create-campaign click. The catch below
          // already handles fetch failure (falls through to direct-DB).
          const r = await fetch(`${goURL.replace(/\/$/, '')}/api/campaigns`, {
            method: 'POST',
            headers: {
              'x-api-key': process.env.OUTREACH_API_KEY || '',
              'content-type': 'application/json',
            },
            body: JSON.stringify(goPayload),
            signal: AbortSignal.timeout(8_000),
          })
          const text = await r.text()
          let body
          try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 500) } }
          if (!r.ok) {
            return res.status(r.status).json({ error: 'go service rejected', http_status: r.status, response: body })
          }
          // Go returns {id, estimate}. Fetch full row from DB so caller gets
          // the same shape as the legacy direct-INSERT path.
          const { rows: [full] } = await pool.query(
            `SELECT id, name, description, status, category_paths, sequence_config,
                    category_match, created_at
             FROM campaigns WHERE id=$1`, [body.id]
          )
          return res.json({ ...full, estimate: body.estimate })
        } catch (e) {
          // Sprint C1 (#1254): no more silent direct-DB fallback. The Go
          // service is the only source of truth for campaign creation
          // because it owns contact enrollment. The old fallback wrote
          // a draft row but never enrolled anyone, leading to zero-send
          // campaigns the operator thought were live.
          console.warn('[campaigns] go service unreachable on POST /api/campaigns:', e.message)
          Sentry?.captureException?.(e, {
            tags: { route: 'POST /api/campaigns', go_unreachable: 'true' },
          })
          return res.status(503).json({
            ok: false,
            error: 'go orchestrator unreachable',
            hint: 'Campaign creation requires the Go orchestrator (it owns contact enrollment). Retry once /health on machinery-outreach is green.',
          })
        }
      }
      return res.status(503).json({
        ok: false,
        error: 'go orchestrator not configured',
        hint: 'GO_SERVER_URL must be set on the BFF for campaign creation.',
      })
    } catch (e) { capture500(res, e, safeError) }
  })
  app.get('/api/campaigns/:id', async (req, res, next) => {
    try {
      // Yield to sibling routes when :id is non-numeric — paths like
      // /api/campaigns/last-24h-summary register later in this mounter and
      // would be shadowed by this list-item route otherwise.
      if (!/^\d+$/.test(req.params.id)) return next()
      const { rows: [c] } = await pool.query(
        `SELECT id,name,description,status,category_paths,sequence_config,category_match,
                staircase_max_per_step,send_window_start,send_window_end,
                created_at,updated_at,
                mailbox_min_spacing_seconds,mailbox_daily_cap_override
         FROM campaigns WHERE id=$1`,
        [req.params.id]
      )
      if (!c) return res.status(404).json({ error: 'not found' })
      const { rows: statRows } = await pool.query(
        `SELECT status, COUNT(*)::int AS cnt FROM send_events WHERE campaign_id=$1 GROUP BY status`,
        [req.params.id]
      ).catch(() => ({ rows: [] }))
      const stats = Object.fromEntries(statRows.map(r => [r.status, r.cnt]))
      // C2 — pacing audit: last 20 pacing changes for the inline history panel.
      const { rows: pacing_audit } = await pool.query(
        `SELECT id, action, actor, details, created_at
         FROM operator_audit_log
         WHERE entity_type='campaign' AND entity_id=$1
           AND action='campaign_pacing_changed'
         ORDER BY created_at DESC
         LIMIT 20`,
        [req.params.id]
      ).catch(() => ({ rows: [] }))
      res.json({ campaign: c, stats, pacing_audit })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── C2: PUT /api/campaigns/:id/pacing ────────────────────────────────────
  // Updates per-campaign throttling overrides and records an audit log entry.
  // Validation:
  //   mailbox_min_spacing_seconds: integer [30, 3600] or null (remove override)
  //   mailbox_daily_cap_override:  integer [0, 5000]  or null (remove override)
  // Precedence documented in migration 104.
  app.put('/api/campaigns/:id/pacing', async (req, res) => {
    const client = await pool.connect()
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid id' })
      const { mailbox_min_spacing_seconds, mailbox_daily_cap_override } = req.body ?? {}

      // Validate spacing if provided
      if (mailbox_min_spacing_seconds !== null && mailbox_min_spacing_seconds !== undefined) {
        const s = Number(mailbox_min_spacing_seconds)
        if (!Number.isInteger(s) || s < 30 || s > 3600) {
          return res.status(400).json({
            error: 'validation_failed',
            field: 'mailbox_min_spacing_seconds',
            message: 'Musí být celé číslo v rozsahu [30, 3600] nebo null.',
          })
        }
      }

      // Validate daily cap if provided
      if (mailbox_daily_cap_override !== null && mailbox_daily_cap_override !== undefined) {
        const c = Number(mailbox_daily_cap_override)
        if (!Number.isInteger(c) || c < 0 || c > 5000) {
          return res.status(400).json({
            error: 'validation_failed',
            field: 'mailbox_daily_cap_override',
            message: 'Musí být celé číslo v rozsahu [0, 5000] nebo null.',
          })
        }
      }

      // The UPDATE + audit INSERT must be ONE transaction — they were two
      // separate pool.query() calls, so a crash between them could change
      // operator-visible pacing with no audit row (or write an audit row for
      // an UPDATE that never committed). Mirror the sibling /send-window route.
      await client.query('BEGIN')

      // Fetch current row to diff for audit
      const { rows: [before] } = await client.query(
        `SELECT id, mailbox_min_spacing_seconds, mailbox_daily_cap_override FROM campaigns WHERE id=$1`,
        [req.params.id]
      )
      if (!before) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'not found' })
      }

      const newSpacing = mailbox_min_spacing_seconds !== undefined
        ? (mailbox_min_spacing_seconds === null ? null : Number(mailbox_min_spacing_seconds))
        : before.mailbox_min_spacing_seconds
      const newCap = mailbox_daily_cap_override !== undefined
        ? (mailbox_daily_cap_override === null ? null : Number(mailbox_daily_cap_override))
        : before.mailbox_daily_cap_override

      await client.query(
        `UPDATE campaigns
         SET mailbox_min_spacing_seconds = $1,
             mailbox_daily_cap_override  = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [newSpacing, newCap, req.params.id]
      )

      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('campaign_pacing_changed', 'dashboard_user', 'campaign', $1, $2::jsonb)`,
        [String(req.params.id), JSON.stringify({
          prev: {
            mailbox_min_spacing_seconds: before.mailbox_min_spacing_seconds,
            mailbox_daily_cap_override:  before.mailbox_daily_cap_override,
          },
          next: {
            mailbox_min_spacing_seconds: newSpacing,
            mailbox_daily_cap_override:  newCap,
          },
        })]
      )

      await client.query('COMMIT')
      res.json({ ok: true, mailbox_min_spacing_seconds: newSpacing, mailbox_daily_cap_override: newCap })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })
  app.get('/api/campaigns/:id/sends', async (req, res) => {
    try {
      const limit  = Math.min(Number(req.query.limit  || 50), 200)
      const offset = Number(req.query.offset || 0)
      // Includes cc.priority (migration 111) so the CampaignDetail "recent
      // sends" list can render a lead-score badge next to each row without
      // a second round-trip.
      const { rows } = await pool.query(`
        SELECT se.id, se.step, se.mailbox_used, se.subject, se.status,
               se.sent_at, se.created_at,
               ct.email AS contact_email, ct.first_name, ct.last_name,
               cc.priority
        FROM send_events se
        LEFT JOIN contacts ct ON ct.id = se.contact_id
        LEFT JOIN campaign_contacts cc
          ON cc.campaign_id = se.campaign_id AND cc.contact_id = se.contact_id
        WHERE se.campaign_id = $1
        ORDER BY se.created_at DESC
        LIMIT $2 OFFSET $3
      `, [req.params.id, limit, offset]).catch(() => ({ rows: [] }))
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })
  app.get('/api/campaigns/:id/preflight', async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid id' })
      const result = await campaignPreflightModule.computeCampaignPreflight(pool, Number(req.params.id))
      if (!result) return res.status(404).json({ error: 'campaign not found' })
      res.json(result)
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/campaigns/:id/launch-stats', async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid id' })
      const id = Number(req.params.id)
      const { rows: [c] } = await pool.query(
        `SELECT id, name, status FROM campaigns WHERE id=$1`, [id]
      )
      if (!c) {
        // Campaign not found → return zero-state 200 so the LaunchStatsRow
        // widget stays hidden silently (no browser 404 console noise).
        return res.json({
          campaign: null,
          sent_1h: 0, bounced_1h: 0, suppressed_1h: 0,
          sent_24h: 0, bounced_24h: 0, last_send_at: null,
          contacts_active: 0, contacts_eligible_now: 0, contacts_completed: 0,
          crm_blocked: 0, crm_blocked_pct: 0,
          generated_at: new Date().toISOString(),
        })
      }
      const { rows: [s = {}] } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='sent'       AND sent_at > now() - interval '1 hour')::int  AS sent_1h,
          COUNT(*) FILTER (WHERE status='bounced'    AND sent_at > now() - interval '1 hour')::int  AS bounced_1h,
          COUNT(*) FILTER (WHERE status='suppressed' AND sent_at > now() - interval '1 hour')::int  AS suppressed_1h,
          COUNT(*) FILTER (WHERE status='sent'       AND sent_at > now() - interval '24 hours')::int AS sent_24h,
          COUNT(*) FILTER (WHERE status='bounced'    AND sent_at > now() - interval '24 hours')::int AS bounced_24h,
          MAX(sent_at) AS last_send_at
        FROM send_events WHERE campaign_id=$1
      `, [id]).catch(() => ({ rows: [{}] }))
      const { rows: [enr = {}] } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('pending','in_sequence'))::int AS active,
          COUNT(*) FILTER (WHERE status IN ('pending','in_sequence')
                            AND (next_send_at IS NULL OR next_send_at <= now()))::int AS eligible_now,
          COUNT(*) FILTER (WHERE status='completed')::int AS completed
        FROM campaign_contacts WHERE campaign_id=$1
      `, [id]).catch(() => ({ rows: [{}] }))
      const { rows: [crm = {}] } = await pool.query(`
        SELECT
          COUNT(DISTINCT cc.contact_id)::int AS crm_blocked
        FROM campaign_contacts cc
        JOIN contacts ct ON ct.id = cc.contact_id
        WHERE cc.campaign_id=$1
          AND cc.status IN ('pending','in_sequence')
          AND ct.crm_client_id IS NOT NULL
      `, [id]).catch(() => ({ rows: [{}] }))
      const segmentTotal = (enr.active ?? 0) + (enr.completed ?? 0)
      const crmBlockedCount = crm.crm_blocked ?? 0
      const crmBlockedPct = segmentTotal > 0 ? Math.round((crmBlockedCount / segmentTotal) * 100) : 0
      res.json({
        campaign: c,
        sent_1h:        s.sent_1h        ?? 0,
        bounced_1h:     s.bounced_1h     ?? 0,
        suppressed_1h:  s.suppressed_1h  ?? 0,
        sent_24h:       s.sent_24h       ?? 0,
        bounced_24h:    s.bounced_24h    ?? 0,
        last_send_at:   s.last_send_at   ?? null,
        contacts_active:        enr.active        ?? 0,
        contacts_eligible_now:  enr.eligible_now  ?? 0,
        contacts_completed:     enr.completed     ?? 0,
        crm_blocked:    crmBlockedCount,
        crm_blocked_pct: crmBlockedPct,
        generated_at: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  // KT-A5 — POST /api/campaigns/:id/send-test
  //
  // Operator-driven single-recipient send-test routed through the same
  // anti-trace-relay path as the campaign runner. Used during the
  // staircase step 1 (single contact) gate documented in
  // docs/playbooks/first-campaign-launch.md.
  //
  // Body: { to: string, mailbox_id: number }
  //
  // Boundaries enforced (HARD RULE memory feedback_campaign_send — never
  // send without explicit operator consent):
  //   - 400 missing/invalid `to`
  //   - 400 missing/invalid `mailbox_id`
  //   - 400 `to` is on suppression UNION (defense in depth)
  //   - 404 mailbox not found
  //   - 425 outside Po–Pá 8–17 send window (override with ?force=1)
  //   - 502 anti-trace-relay unreachable / non-2xx
  //   - 200 envelope_id from relay on success
  //
  // The endpoint is deliberately limited to a single recipient — for
  // bulk operator dry-runs use the Go-side dry_run mode (campaigns.status
  // = 'dry_run') reachable via the campaign run/pause routes, not this
  // handler.
  app.post('/api/campaigns/:id/send-test', async (req, res) => {
    setRouteTags({ 'campaign.action': 'send-test' })
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid campaign id' })
      }
      const { to, mailbox_id, subject, text, body_html, template_name } = req.body || {}
      if (!to || typeof to !== 'string') {
        return res.status(400).json({ error: 'missing to' })
      }
      const mid = Number(mailbox_id)
      if (!Number.isFinite(mid) || mid <= 0) {
        return res.status(400).json({ error: 'missing mailbox_id' })
      }

      // Send-window guard (override with ?force=1 — operator manual test).
      const force = req.query.force === '1'
      if (!force && !isWithinSendWindow(new Date(), 'Europe/Prague')) {
        return res.status(425).json({
          ok: false,
          error: 'Mimo send window (Po–Pá 8–17). Použij ?force=1 pro manuální test.',
        })
      }

      // Suppression UNION — defense in depth so a campaign send-test
      // cannot bypass an automated suppression entry.
      const { rows: suppRows } = await pool.query(SUPPRESSION_LOOKUP_SQL, [to])
      if (suppRows.length) {
        return res.status(400).json({
          ok: false,
          error: `${to} je na suppression listu — nelze poslat.`,
        })
      }

      // Campaign existence — operator should know the id was valid.
      const { rows: campRows } = await pool.query(
        `SELECT id, name, status FROM campaigns WHERE id=$1`,
        [req.params.id],
      )
      if (!campRows.length) return res.status(404).json({ error: 'campaign not found' })

      // Mailbox lookup — include IMAP coords so relay can do post-send Sent
      // APPEND (gate `HasIMAP() = IMAPHost && IMAPPort && SMTPUsername && SMTPPassword`
      // in services/relay/internal/model/model.go). Without IMAP coords the
      // relay silently skips the APPEND and Sent folder stays empty.
      const { rows: mbRows } = await pool.query(
        `SELECT id, from_address AS email, smtp_host AS host, smtp_port AS port,
                smtp_username, password, imap_host, imap_port
         FROM outreach_mailboxes WHERE id=$1`,
        [mid],
      )
      if (!mbRows.length) return res.status(404).json({ error: 'mailbox not found' })
      const mb = mbRows[0]
      if (!mb.password || mb.password.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'Schránka nemá nastavené heslo (HARD RULE: hesla se ukládají přímo do DB).',
        })
      }

      // Optional template lookup — caller can pass template_name to pull
      // body+body_html from email_templates. Caller-supplied `text`/`body_html`
      // always win over template (operator override).
      let tplSubject = ''
      let tplBody = ''
      let tplBodyHtml = ''
      if (template_name && typeof template_name === 'string') {
        const { rows: tplRows } = await pool.query(
          `SELECT subject, body, COALESCE(body_html, '') AS body_html
             FROM email_templates WHERE name=$1`,
          [template_name],
        )
        if (tplRows.length) {
          tplSubject = tplRows[0].subject || ''
          tplBody = tplRows[0].body || ''
          tplBodyHtml = tplRows[0].body_html || ''
        }
      }

      // Anti-trace relay routing — same path the campaign runner uses.
      const relayURL =
        process.env.ANTI_TRACE_URL ||
        process.env.ANTI_TRACE_RELAY_URL ||
        (await pool.query(`SELECT value FROM outreach_config WHERE key='anti_trace_url'`).catch(() => ({ rows: [] }))).rows[0]?.value
      const relayToken = process.env.ANTI_TRACE_TOKEN || process.env.ANTI_TRACE_RELAY_TOKEN

      if (!relayURL || !relayToken) {
        return res.status(503).json({
          ok: false,
          error: 'Anti-trace-relay není nakonfigurován — odmítám poslat test (HARD RULE).',
        })
      }

      try {
        const r = await fetch(`${relayURL.replace(/\/$/, '')}/v1/submit`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${relayToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: to,
            subject: subject || tplSubject || `Test kampaně #${req.params.id}`,
            body: text || tplBody || `Toto je testovací e-mail z kampaně ${campRows[0].name}.`,
            body_html: body_html || tplBodyHtml || '',
            from_address: mb.email,
            smtp_host: mb.host,
            smtp_port: mb.port,
            smtp_username: mb.smtp_username || mb.email,
            smtp_password: mb.password,
            imap_host: mb.imap_host || '',
            imap_port: mb.imap_port || 0,
          }),
        })
        const respText = await r.text()
        let parsed
        try { parsed = JSON.parse(respText) } catch { parsed = { raw: respText.slice(0, 500) } }
        if (!r.ok) {
          return res.status(502).json({
            ok: false,
            error: 'relay rejected',
            http_status: r.status,
            response: parsed,
          })
        }
        // Audit row — operator-visible record that a send-test happened.
        try {
          await pool.query(
            `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
             VALUES ('campaign_send_test', 'dashboard_user', 'campaign', $1, $2::jsonb)`,
            [String(req.params.id), JSON.stringify({
              to, mailbox_id: mid, envelope_id: parsed.envelope_id || null,
            })],
          )
        } catch { /* audit best-effort */ }
        return res.json({
          ok: true,
          from: mb.email,
          to,
          campaign_id: Number(req.params.id),
          mailbox_id: mid,
          via: 'anti-trace-relay',
          envelope_id: parsed.envelope_id || null,
          status: parsed.status || null,
        })
      } catch (e) {
        return res.status(502).json({
          ok: false,
          error: `relay unreachable: ${e.message}`,
          via: 'anti-trace-relay',
        })
      }
    } catch (e) { capture500(res, e, safeError) }
  })

  // Audience size estimate. Two modes:
  //  - saved (no query): reads the campaign's stored category_paths/match.
  //  - preview (?category_paths=a,b&category_match=prefix): estimates a
  //    candidate selection BEFORE it is saved — drives the audience editor's
  //    live count as the operator toggles categories.
  // NB: campaigns.category_paths is a JSON-encoded string in a TEXT column
  // (see campaignSegmentExpansion.js parseCategoryPaths) — not a pg array — so
  // it must be parsed, not read via Array.isArray (which silently fell through
  // to "count everything" before this fix).
  app.get('/api/campaigns/:id/estimate', async (req, res) => {
    try {
      let paths, match
      if (req.query.category_paths !== undefined) {
        // JSON-array form (sent by the editors) is comma-safe — a category
        // path that itself contains a comma is no longer split into bogus paths.
        // Fall back to the legacy comma-joined form for any older caller.
        const raw = String(req.query.category_paths).trim()
        paths = raw.startsWith('[') ? parsePaths(raw) : raw.split(',').map(s => s.trim()).filter(Boolean)
        match = req.query.category_match === 'exact' ? 'exact' : 'prefix'
      } else {
        const { rows: [c] } = await pool.query(`SELECT category_paths,category_match FROM campaigns WHERE id=$1`, [req.params.id])
        if (!c) return res.status(404).json({ error: 'not found' })
        paths = parsePaths(c.category_paths)
        match = c.category_match === 'exact' ? 'exact' : 'prefix'
      }
      if (!paths.length) {
        const { rows: [{ total }] } = await pool.query(`SELECT COUNT(*)::int AS total FROM companies WHERE datum_zaniku IS NULL AND v_insolvenci=false`)
        return res.json({ count: total, paths: 0, match })
      }
      let clause, params
      if (match === 'exact') {
        clause = paths.map((_, i) => `category_path = $${i + 1}`).join(' OR ')
        params = paths
      } else {
        clause = paths.map((_, i) => `category_path LIKE $${i + 1}`).join(' OR ')
        params = paths.map(p => p.endsWith('%') ? p : p + '%')
      }
      const { rows: [{ total }] } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM companies WHERE datum_zaniku IS NULL AND v_insolvenci=false AND (${clause})`,
        params
      )
      res.json({ count: total, paths: paths.length, match })
    } catch (e) { capture500(res, e, safeError) }
  })
  app.get('/api/campaigns/:id/best-time', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT EXTRACT(DOW FROM te.created_at)::int AS day,
                EXTRACT(HOUR FROM te.created_at)::int AS hour,
                COUNT(*)::int AS opens
         FROM tracking_events te
         JOIN send_events se ON se.id = te.send_event_id
         WHERE se.campaign_id = $1 AND te.event_type = 'open'
         GROUP BY 1, 2
         ORDER BY 1, 2`,
        [req.params.id]
      )
      if (!rows.length) return res.json({ heatmap: [], recommended: null })
      const totalOpens = rows.reduce((s, r) => s + r.opens, 0)
      const heatmap = rows.map(r => ({ day: r.day, hour: r.hour, open_rate: r.opens / totalOpens }))
      const best = rows.reduce((b, r) => r.opens > b.opens ? r : b)
      const dayLabels = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So']
      res.json({
        heatmap,
        recommended: { day: best.day, hour: best.hour, label: `${dayLabels[best.day]} ${best.hour}:00` },
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/campaigns/:id/inbox-placement', async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not found' })
      const { rows } = await pool.query(`
        SELECT se.id, se.status, se.sent_at, se.mailbox_used,
               te_open.created_at  AS opened_at,
               te_click.created_at AS clicked_at,
               CASE WHEN se.status = 'bounced' THEN 'hard' ELSE NULL END AS bounce_type
        FROM send_events se
        LEFT JOIN LATERAL (
          SELECT created_at FROM tracking_events
          WHERE send_event_id = se.id AND event_type = 'open'
          ORDER BY created_at ASC LIMIT 1
        ) te_open ON true
        LEFT JOIN LATERAL (
          SELECT created_at FROM tracking_events
          WHERE send_event_id = se.id AND event_type = 'click'
          ORDER BY created_at ASC LIMIT 1
        ) te_click ON true
        WHERE se.campaign_id = $1
      `, [req.params.id])
      const stats = aggregatePlacementStats(rows)
      res.json({ campaign_id: req.params.id, ...stats })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/campaigns/:id/email-quality', async (req, res) => {
    try {
      const { rows: [c] } = await pool.query(`SELECT category_paths FROM campaigns WHERE id=$1`, [req.params.id])
      if (!c) return res.status(404).json({ error: 'not found' })
      // category_paths is JSON-in-TEXT — parse it (Array.isArray was always
      // false, which skipped the filter and scanned the whole companies table).
      const paths = parsePaths(c.category_paths)
      const conds = ['datum_zaniku IS NULL','v_insolvenci=false']
      const params = []
      if (paths.length) {
        const likes = paths.map((_, i) => `category_path LIKE $${i+1}`).join(' OR ')
        conds.push(`(${likes})`)
        paths.forEach(p => params.push(p.endsWith('%') ? p : p + '%'))
      }
      const where = conds.join(' AND ')
      const [{ rows: statusRows }, { rows: [{ total }] }, { rows: [{ with_email }] }, { rows: [{ stale }] }] = await Promise.all([
        pool.query(
          `SELECT COALESCE(email_status,'unverified') AS status, COUNT(*)::int AS cnt
           FROM companies WHERE ${where} AND email IS NOT NULL
           GROUP BY 1`, params
        ),
        pool.query(`SELECT COUNT(*)::int AS total FROM companies WHERE ${where}`, params),
        pool.query(`SELECT COUNT(*)::int AS with_email FROM companies WHERE ${where} AND email IS NOT NULL`, params),
        pool.query(
          `SELECT COUNT(*)::int AS stale FROM companies
           WHERE ${where} AND email IS NOT NULL
             AND (email_verified_at IS NULL OR email_verified_at < now() - INTERVAL '90 days')`,
          params
        ),
      ])
      const byStatus = {}
      for (const r of statusRows) byStatus[r.status] = r.cnt
      res.json({
        total,
        with_email,
        without_email: total - with_email,
        stale,
        by_status: byStatus,
        // Computed risk summary
        valid:      byStatus.valid      ?? 0,
        risky:      byStatus.risky      ?? 0,
        catch_all:  byStatus.catch_all  ?? 0,
        role_only:  byStatus.role_only  ?? 0,
        invalid:    byStatus.invalid    ?? 0,
        spamtrap:   byStatus.spamtrap   ?? 0,
        unverified: byStatus.unverified ?? 0,
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/campaigns/:id/capacity', async (req, res) => {
    try {
      const { rows: [camp] } = await pool.query(`SELECT category_paths, category_match FROM campaigns WHERE id=$1`, [req.params.id])
      if (!camp) return res.status(404).json({ error: 'not found' })
      const { rows: [{ daily_capacity, active_mailboxes }] } = await pool.query(
        // outreach_mailboxes (not 'mailboxes', which doesn't exist) has no
        // daily_limit column — the effective per-mailbox cap is the warmup-phase
        // default (migration 071: d0=5, d3=10, d7=25, d14=50, production=100)
        // optionally LOWERED by daily_cap_override. COALESCE(override, phase_cap)
        // works because the override may only lower the cap.
        `SELECT COALESCE(SUM(COALESCE(daily_cap_override,
                  CASE lifecycle_phase
                    WHEN 'warmup_d0' THEN 5  WHEN 'warmup_d3' THEN 10
                    WHEN 'warmup_d7' THEN 25 WHEN 'warmup_d14' THEN 50
                    WHEN 'production' THEN 100 ELSE 5 END)), 0)::int AS daily_capacity,
                COUNT(*)::int AS active_mailboxes
           FROM outreach_mailboxes WHERE status='active'`
      )
      // category_paths is JSON-in-TEXT — parse it (Array.isArray was always
      // false, which skipped the filter and scanned the whole companies table).
      const paths = parsePaths(camp.category_paths)
      const params = []
      const conds = ['datum_zaniku IS NULL', 'v_insolvenci=false']
      if (paths.length) {
        const likes = paths.map((_, i) => `category_path LIKE $${i + 1}`).join(' OR ')
        conds.push(`(${likes})`)
        paths.forEach(p => params.push(p.endsWith('%') ? p : p + '%'))
      }
      const { rows: [{ estimate }] } = await pool.query(
        `SELECT COUNT(*)::int AS estimate FROM companies WHERE ${conds.join(' AND ')}`, params
      )
      const days_to_complete = daily_capacity > 0 ? Math.ceil(estimate / daily_capacity) : null
      res.json({ daily_capacity, active_mailboxes, estimate, days_to_complete })
    } catch (e) { capture500(res, e, safeError) }
  })

  // S4.2: Run/pause proxies to Go service. Go's HandleCampaignDetail run
  // action does SetStatus + RunCampaign tick (one immediate iteration, not
  // just status flip), which is what the operator usually expects from
  // "Activate" — campaign starts sending in current scheduler tick rather
  // than waiting up to 60s for the next tick. Falls back to direct DB
  // status flip if Go service unreachable.
  app.post('/api/campaigns/:id/run', async (req, res) => {
    setRouteTags({ 'campaign.action': 'run' })
    const client = await pool.connect()
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid id' })

      // x-preflight-only: 1 — read-only preflight probe for verify-launch CLI.
      // Runs preflight checks and returns the result without actually starting
      // the campaign. Used by scripts/verify-launch.mjs step 2.
      if (req.headers['x-preflight-only'] === '1') {
        const pre = await runPreflight(pool, parseInt(req.params.id, 10))
        const blockers = pre.blockers || []
        return res.status(pre.ok ? 200 : 412).json({
          ok: pre.ok,
          preflight_only: true,
          blockers,
          summary: pre.summary,
        })
      }

      // Pre-flight gate — refuse /run if any of M1/T1/S1 blocker triggers.
      // Bypass via `?force=1` (operator's deliberate override; auditable).
      // The 412 response carries structured `blockers` so the UI can render
      // a confirmation dialog with the specific Czech reason text.
      if (req.query.force !== '1') {
        const pre = await runPreflight(pool, parseInt(req.params.id, 10))
        if (!pre.ok) {
          return res.status(412).json({
            error: 'preflight_failed',
            blockers: pre.blockers,
            summary: pre.summary,
            hint: 'Vyřeš výše uvedené body nebo přidej ?force=1 pokud víš, co děláš.',
          })
        }
      }

      await client.query('BEGIN')

      // Fetch current state before attempting activation
      const { rows: [campBefore] } = await client.query(
        'SELECT id, status FROM campaigns WHERE id=$1',
        [req.params.id]
      )
      if (!campBefore) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(404).json({ error: 'campaign not found' })
      }

      const goURL = process.env.GO_SERVER_URL
      if (goURL) {
        try {
          const r = await fetch(`${goURL.replace(/\/$/, '')}/api/campaigns/${req.params.id}/run`, {
            method: 'POST',
            headers: { 'x-api-key': process.env.OUTREACH_API_KEY || '' },
            signal: AbortSignal.timeout(8_000), // F2-4
          })
          const text = await r.text()
          let body
          try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 500) } }
          if (r.ok) {
            // Audit log the activation via Go service
            await client.query(
              `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
               VALUES ('campaign_activate', 'dashboard', 'campaign', $1, $2::jsonb)`,
              [String(req.params.id), JSON.stringify({
                prev_status: campBefore.status,
                activated_via: 'go_service'
              })]
            )
            await client.query('COMMIT')
            client.release()
            return res.json(body)
          }
          // Non-2xx from Go: surface to caller (most likely "campaign is paused
          // / completed, cannot run" or "campaign not found").
          await client.query('ROLLBACK')
          client.release()
          return res.status(r.status).json({ error: 'go service rejected', http_status: r.status, response: body })
        } catch (e) {
          // Sprint C1 (#1254): no more silent DB fallback. The Go service
          // is authoritative — falling through to a bare status flip
          // bypasses RunCampaign tick (zero immediate sends) AND breaks
          // the operator_audit_log invariant (two write paths for the
          // same state change). Operator gets HTTP 503 with a hint so
          // they retry once Go is healthy.
          console.warn('[campaigns] go service unreachable on /run:', e.message)
          Sentry?.captureException?.(e, {
            tags: { route: 'POST /api/campaigns/:id/run', go_unreachable: 'true' },
          })
          await client.query('ROLLBACK')
          client.release()
          return res.status(503).json({
            ok: false,
            error: 'go orchestrator unreachable',
            hint: 'Campaign state changes go through the Go orchestrator. Retry once /health on machinery-outreach is green.',
          })
        }
      }
      // Go service not configured — single source of truth requires it.
      // Refuse to make state changes here without a backing orchestrator.
      await client.query('ROLLBACK')
      client.release()
      return res.status(503).json({
        ok: false,
        error: 'go orchestrator not configured',
        hint: 'GO_SERVER_URL must be set on the BFF for campaign state mutations.',
      })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      client.release()
      capture500(res, e, safeError)
    }
  })

  app.post('/api/campaigns/:id/pause', async (req, res) => {
    setRouteTags({ 'campaign.action': 'pause' })
    const client = await pool.connect()
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid id' })

      await client.query('BEGIN')

      // Fetch current state before attempting pause
      const { rows: [campBefore] } = await client.query(
        'SELECT id, status FROM campaigns WHERE id=$1',
        [req.params.id]
      )
      if (!campBefore) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(404).json({ error: 'campaign not found' })
      }

      // #940 — precondition: only running/sending campaigns can be paused.
      // A draft, paused, completed, or archived campaign must not flip to
      // paused status; that would silently corrupt the state machine.
      if (!['running', 'sending'].includes(campBefore.status)) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(412).json({
          error: 'cannot pause from this status',
          current_status: campBefore.status,
          hint: 'Only campaigns in running or sending state can be paused.',
        })
      }

      const goURL = process.env.GO_SERVER_URL
      if (goURL) {
        try {
          const r = await fetch(`${goURL.replace(/\/$/, '')}/api/campaigns/${req.params.id}/pause`, {
            method: 'POST',
            headers: { 'x-api-key': process.env.OUTREACH_API_KEY || '' },
            signal: AbortSignal.timeout(8_000), // F2-4
          })
          const text = await r.text()
          let body
          try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 500) } }
          if (r.ok) {
            // Audit log the pause via Go service
            await client.query(
              `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
               VALUES ('campaign_pause', 'dashboard', 'campaign', $1, $2::jsonb)`,
              [String(req.params.id), JSON.stringify({
                prev_status: campBefore.status,
                paused_via: 'go_service'
              })]
            )
            await client.query('COMMIT')
            client.release()
            return res.json(body)
          }
          await client.query('ROLLBACK')
          client.release()
          return res.status(r.status).json({ error: 'go service rejected', http_status: r.status, response: body })
        } catch (e) {
          // Sprint C1 (#1254): no silent DB fallback — see /run for rationale.
          console.warn('[campaigns] go service unreachable on /pause:', e.message)
          Sentry?.captureException?.(e, {
            tags: { route: 'POST /api/campaigns/:id/pause', go_unreachable: 'true' },
          })
          await client.query('ROLLBACK')
          client.release()
          return res.status(503).json({
            ok: false,
            error: 'go orchestrator unreachable',
            hint: 'Campaign pause goes through the Go orchestrator. Retry once /health on machinery-outreach is green.',
          })
        }
      }
      // Go service not configured.
      await client.query('ROLLBACK')
      client.release()
      return res.status(503).json({
        ok: false,
        error: 'go orchestrator not configured',
        hint: 'GO_SERVER_URL must be set on the BFF for campaign state mutations.',
      })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      client.release()
      capture500(res, e, safeError)
    }
  })
  // ── Input-validation bounds for PATCH config edits ──────────────────────
  // These are request-shape limits (reject garbage), NOT operator-tunable
  // behavioral thresholds — those live in operator_settings per
  // feedback_no_magic_thresholds. Named here so the values are not magic.
  const CAMPAIGN_NAME_MIN = 2
  const CAMPAIGN_NAME_MAX = 120
  const CAMPAIGN_DESC_MAX = 4000
  const CATEGORY_PATHS_MAX = 200          // max distinct category paths per campaign
  const CATEGORY_PATH_LEN_MAX = 300       // max chars per single path
  const STAIRCASE_MAX_STEPS = 20          // staircase array length cap (sequence ≤10, headroom)
  const STAIRCASE_STEP_CAP_MAX = 1_000_000
  const CAMPAIGN_MATCH_VALUES = ['prefix', 'exact']
  // Statuses in which structural edits (audience / staircase) are refused
  // unless ?force=1 — running-edit policy (operator must pause first).
  const CAMPAIGN_LIVE_STATUSES = ['running', 'active']
  // The full campaign lifecycle status set (state machine). PATCH validates
  // `status` against this so a typo or an explicit {status:null} can't be
  // written verbatim and silently drop the campaign out of every status view.
  const CAMPAIGN_STATUS_VALUES = ['draft', 'running', 'active', 'sending', 'paused', 'completed', 'archived']

  // PATCH /api/campaigns/:id — partial update of campaign config + status.
  //
  // Accepts any subset of: status, name, description, category_paths,
  // category_match, staircase_max_per_step. Only fields present in the body
  // are touched (partial update — fixes the prior status=NULL clobber when
  // PATCH was called without a status). `subject` is intentionally NOT
  // editable here: it is vestigial at send time (runner renders subject from
  // the email_templates row, not campaigns.subject) — edit it via the
  // template editor instead.
  //
  // HARD RULES honored:
  //  - feedback_audit_log_on_mutations: operator_audit_log INSERT in same tx
  //    (campaign_activate on launch + campaign_config_update on field change).
  //  - running-edit policy: structural fields (audience/staircase) → 412 when
  //    status is live, unless ?force=1.
  //  - feedback_no_magic_thresholds: bounds are named constants above.
  //  - schema-verified columns (no `stats` column on campaigns — RETURNING
  //    lists only real columns).
  app.patch('/api/campaigns/:id', async (req, res) => {
    const body = req.body || {}
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
    const { status } = body
    const fail = (field, message) =>
      res.status(400).json({ error: 'validation_failed', field, message })

    // ── Validate field shapes BEFORE opening a tx ──
    let normName, normDesc, normPaths, normMatch, normStaircase
    if (has('name')) {
      if (typeof body.name !== 'string') return fail('name', 'Název musí být text.')
      normName = body.name.trim()
      if (normName.length < CAMPAIGN_NAME_MIN || normName.length > CAMPAIGN_NAME_MAX) {
        return fail('name', `Název musí mít ${CAMPAIGN_NAME_MIN}–${CAMPAIGN_NAME_MAX} znaků.`)
      }
    }
    if (has('description')) {
      if (body.description !== null && typeof body.description !== 'string') {
        return fail('description', 'Popis musí být text nebo null.')
      }
      normDesc = body.description == null ? null : body.description
      if (normDesc && normDesc.length > CAMPAIGN_DESC_MAX) {
        return fail('description', `Popis smí mít max ${CAMPAIGN_DESC_MAX} znaků.`)
      }
    }
    if (has('category_match')) {
      if (!CAMPAIGN_MATCH_VALUES.includes(body.category_match)) {
        return fail('category_match', `Musí být jedna z: ${CAMPAIGN_MATCH_VALUES.join(', ')}.`)
      }
      normMatch = body.category_match
    }
    if (has('category_paths')) {
      if (!Array.isArray(body.category_paths)) return fail('category_paths', 'Musí být pole řetězců.')
      if (body.category_paths.length > CATEGORY_PATHS_MAX) {
        return fail('category_paths', `Max ${CATEGORY_PATHS_MAX} kategorií.`)
      }
      const cleaned = []
      for (const p of body.category_paths) {
        if (typeof p !== 'string') return fail('category_paths', 'Každá kategorie musí být řetězec.')
        const t = p.trim()
        if (!t) continue
        if (t.length > CATEGORY_PATH_LEN_MAX) {
          return fail('category_paths', `Kategorie je příliš dlouhá (max ${CATEGORY_PATH_LEN_MAX} znaků).`)
        }
        cleaned.push(t)
      }
      normPaths = Array.from(new Set(cleaned)) // dedupe, preserve order
    }
    if (has('staircase_max_per_step')) {
      if (!Array.isArray(body.staircase_max_per_step)) {
        return fail('staircase_max_per_step', 'Musí být pole celých čísel.')
      }
      const arr = body.staircase_max_per_step
      if (arr.length < 1 || arr.length > STAIRCASE_MAX_STEPS) {
        return fail('staircase_max_per_step', `Pole musí mít 1–${STAIRCASE_MAX_STEPS} hodnot.`)
      }
      for (const n of arr) {
        if (!Number.isInteger(n) || n < 0 || n > STAIRCASE_STEP_CAP_MAX) {
          return fail('staircase_max_per_step', `Každá hodnota musí být celé číslo v rozsahu [0, ${STAIRCASE_STEP_CAP_MAX}].`)
        }
      }
      normStaircase = arr
    }
    if (has('status')) {
      if (typeof body.status !== 'string' || !CAMPAIGN_STATUS_VALUES.includes(body.status)) {
        return fail('status', `Stav musí být jeden z: ${CAMPAIGN_STATUS_VALUES.join(', ')}.`)
      }
    }

    const structuralTouched = has('category_paths') || has('category_match') || has('staircase_max_per_step')

    const client = await pool.connect()
    try {
      // Pre-flight gate fires when PATCH flips a campaign active/running.
      // Without this, the Campaigns.jsx toggle (PATCH) bypasses the gate
      // that POST /run guards. ?force=1 same bypass.
      const isLaunch = status === 'running' || status === 'active'
      if (isLaunch && req.query.force !== '1') {
        const pre = await runPreflight(pool, parseInt(req.params.id, 10))
        if (!pre.ok) {
          // NB: do not release here — the `finally` block releases once.
          // A second release() throws pg-pool's _releaseOnce error.
          return res.status(412).json({
            error: 'preflight_failed',
            blockers: pre.blockers,
            summary: pre.summary,
            hint: 'Vyřeš výše uvedené body nebo přidej ?force=1 pokud víš, co děláš.',
          })
        }
      }

      await client.query('BEGIN')

      // Fetch current row for audit diff + running-edit guard.
      const { rows: [campBefore] } = await client.query(
        `SELECT id, name, description, status, category_paths, category_match, staircase_max_per_step
         FROM campaigns WHERE id=$1`,
        [req.params.id]
      )
      if (!campBefore) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'campaign not found' })
      }

      // Running-edit policy: structural changes require a paused/draft campaign.
      if (structuralTouched && CAMPAIGN_LIVE_STATUSES.includes(campBefore.status) && req.query.force !== '1') {
        await client.query('ROLLBACK')
        return res.status(412).json({
          error: 'campaign_running',
          message: 'Strukturální změny (publikum, staircase) vyžadují pozastavení kampaně. Pozastav kampaň a zkus to znovu (nebo přidej ?force=1).',
          hint: 'pause_first',
        })
      }

      // Build a partial UPDATE — only touch fields present in the body.
      const sets = []
      const vals = []
      let i = 1
      if (has('status'))                 { sets.push(`status=$${i++}`); vals.push(status) }
      if (has('name'))                   { sets.push(`name=$${i++}`); vals.push(normName) }
      if (has('description'))            { sets.push(`description=$${i++}`); vals.push(normDesc) }
      if (has('category_paths'))         { sets.push(`category_paths=$${i++}`); vals.push(JSON.stringify(normPaths)) }
      if (has('category_match'))         { sets.push(`category_match=$${i++}`); vals.push(normMatch) }
      if (has('staircase_max_per_step')) { sets.push(`staircase_max_per_step=$${i++}::jsonb`); vals.push(JSON.stringify(normStaircase)) }

      if (!sets.length) {
        // Nothing to update — return current row (no-op).
        await client.query('COMMIT')
        return res.json(campBefore)
      }

      sets.push('updated_at=NOW()')
      vals.push(req.params.id)
      const { rows } = await client.query(
        `UPDATE campaigns SET ${sets.join(', ')} WHERE id=$${i}
         RETURNING id, name, description, status, category_paths, category_match,
                   staircase_max_per_step, mailbox_min_spacing_seconds,
                   mailbox_daily_cap_override, send_window_start, send_window_end,
                   created_at, updated_at`,
        vals
      )

      // Audit: activation (#846) when launching via PATCH.
      if (isLaunch) {
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_activate', 'dashboard', 'campaign', $1, $2::jsonb)`,
          [String(req.params.id), JSON.stringify({
            prev_status: campBefore.status,
            new_status: status,
            activated_via: 'patch',
          })]
        )
      }

      // Audit: config change when any non-status field changed (prev/next diff).
      const configTouched = has('name') || has('description') || structuralTouched
      if (configTouched) {
        const prev = {}
        const next = {}
        if (has('name'))                   { prev.name = campBefore.name; next.name = normName }
        if (has('description'))            { prev.description = campBefore.description; next.description = normDesc }
        if (has('category_paths'))         { prev.category_paths = campBefore.category_paths; next.category_paths = normPaths }
        if (has('category_match'))         { prev.category_match = campBefore.category_match; next.category_match = normMatch }
        if (has('staircase_max_per_step')) { prev.staircase_max_per_step = campBefore.staircase_max_per_step; next.staircase_max_per_step = normStaircase }
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_config_update', 'dashboard', 'campaign', $1, $2::jsonb)`,
          [String(req.params.id), JSON.stringify({ prev, next })]
        )
      }

      // Audit: a status-only lifecycle transition (paused / completed / draft /
      // archived) that the activation audit above does not cover. Every mutation
      // changing operator-visible state must leave an audit row in the same tx
      // (T0 feedback_audit_log_on_mutations) — otherwise pausing/completing a
      // campaign via PATCH is untraceable, unlike the dedicated /pause route.
      if (has('status') && !isLaunch && status !== campBefore.status) {
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_status_change', 'dashboard', 'campaign', $1, $2::jsonb)`,
          [String(req.params.id), JSON.stringify({
            prev_status: campBefore.status,
            new_status: status,
            changed_via: 'patch',
          })]
        )
      }

      await client.query('COMMIT')
      res.json(rows[0])
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })
  app.delete('/api/campaigns/:id', async (req, res) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Fetch the campaign for audit details before deletion
      const { rows: [campaign] } = await client.query(
        'SELECT id, name, subject FROM campaigns WHERE id=$1',
        [req.params.id]
      )
      if (!campaign) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Campaign not found' })
      }

      // Delete the campaign
      await client.query('DELETE FROM campaigns WHERE id=$1', [req.params.id])

      // Audit log the deletion
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('campaign_delete', 'dashboard', 'campaign', $1, $2::jsonb)`,
        [String(req.params.id), JSON.stringify({
          id: campaign.id,
          name: campaign.name,
          subject: campaign.subject
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

  // C3 — PUT /api/campaigns/:id/send-window
  //
  // Per-campaign send window override (start/end time, nullable = use operator_settings default).
  // Validates: start < end, both HH:MM format in 00:00–23:59 range.
  // HARD: operator_audit_log INSERT on success (feedback_audit_log_on_mutations).
  // HARD: no magic-number thresholds (feedback_no_magic_thresholds).
  app.put('/api/campaigns/:id/send-window', async (req, res) => {
    const client = await pool.connect()
    try {
      const campaignId = req.params.id
      if (!/^\d+$/.test(campaignId)) {
        return res.status(400).json({ error: 'invalid id' })
      }

      const { start, end } = req.body

      // Validate format: HH:MM (00:00–23:59)
      const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/
      if (start && !timeRegex.test(start)) {
        return res.status(400).json({ error: 'invalid start format, expected HH:MM' })
      }
      if (end && !timeRegex.test(end)) {
        return res.status(400).json({ error: 'invalid end format, expected HH:MM' })
      }

      // Validate start < end
      if (start && end && start >= end) {
        return res.status(400).json({ error: 'start must be before end' })
      }

      await client.query('BEGIN')

      // Fetch campaign for audit
      const { rows: [campBefore] } = await client.query(
        'SELECT id, send_window_start, send_window_end FROM campaigns WHERE id=$1',
        [campaignId]
      )
      if (!campBefore) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'campaign not found' })
      }

      // Update send window (convert HH:MM string to TIME type)
      const startTime = start ? `'${start}'::time` : 'NULL'
      const endTime = end ? `'${end}'::time` : 'NULL'
      const { rows } = await client.query(
        `UPDATE campaigns SET send_window_start=${startTime}, send_window_end=${endTime} WHERE id=$1 RETURNING id, name, send_window_start, send_window_end`,
        [campaignId]
      )

      // Audit log send-window change
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('campaign_send_window_update', 'dashboard', 'campaign', $1, $2::jsonb)`,
        [campaignId, JSON.stringify({
          prev_start: campBefore.send_window_start,
          prev_end: campBefore.send_window_end,
          new_start: start,
          new_end: end
        })]
      )

      await client.query('COMMIT')
      res.json(rows[0])
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // D2.3 — GET /api/campaigns/:id/ramp-progress
  //
  // Returns ramp-staircase metrics: days since launch, daily sent counts,
  // current day target (5/10/20/30), and ramp stage. Used by RampStaircase
  // widget to visualize Day 2+ progress per first-campaign-launch.md.
  //
  // Boundaries enforced:
  //   - 400 invalid id
  //   - 404 campaign not found
  //   - 200 { campaign, started_at, days_since_start, daily_counts, current_day_target, current_day_sent, ramp_stage }
  app.get('/api/campaigns/:id/ramp-progress', async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid id' })
      }

      const campaignId = Number(req.params.id)
      const { rows: campRows } = await pool.query(
        `SELECT id, name, status FROM campaigns WHERE id=$1`,
        [campaignId],
      )
      if (!campRows.length) {
        // Campaign not found → return pre_launch zero-state so the
        // RampStaircase widget hides itself silently (no browser 404 noise).
        return res.json({
          campaign: null,
          started_at: null,
          days_since_start: 0,
          daily_counts: [],
          current_day_target: 5,
          current_day_sent: 0,
          ramp_stage: 'pre_launch',
        })
      }
      const campaign = campRows[0]

      // Get all send_events ordered by sent_at to determine day-by-day counts
      const { rows: sendRows } = await pool.query(
        `SELECT
           DATE(se.sent_at AT TIME ZONE 'Europe/Prague') AS send_date,
           COUNT(*)::int AS sent
         FROM send_events se
         WHERE se.campaign_id = $1 AND se.status='sent'
         GROUP BY DATE(se.sent_at AT TIME ZONE 'Europe/Prague')
         ORDER BY send_date ASC`,
        [campaignId],
      )

      if (!sendRows.length) {
        // No sends yet — pre-launch state
        return res.json({
          campaign,
          started_at: null,
          days_since_start: 0,
          daily_counts: [],
          current_day_target: 5,
          current_day_sent: 0,
          ramp_stage: 'pre_launch',
        })
      }

      // Compute days_since_start from the first sent_at date
      const startDate = new Date(sendRows[0].send_date)
      const now = new Date()
      const daysSinceStart = Math.floor(
        (now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
      )

      // Determine ramp_stage based on days elapsed and cumulative sends
      // Stage progression: day 1 (5), day 2 (10), day 3 (20), day 4+ (30)
      let rampStage = 'pre_launch'
      let currentDayTarget = 5
      if (daysSinceStart >= 0) {
        if (daysSinceStart === 0) rampStage = 'day_1_5'
        else if (daysSinceStart === 1) rampStage = 'day_2_10'
        else if (daysSinceStart === 2) rampStage = 'day_3_20'
        else rampStage = 'steady_30'
      }

      // Map targets per day (cumulative interpretation: day N expects to reach target by day N)
      const targetsByDay = { 0: 5, 1: 10, 2: 20, 3: 30 }
      currentDayTarget = targetsByDay[Math.min(daysSinceStart, 3)] || 30

      // Get today's sent count (Prague timezone)
      const todaySent = sendRows
        .filter(
          r =>
            new Date(r.send_date).toDateString() ===
            new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' })
        )
        .reduce((sum, r) => sum + r.sent, 0)

      res.json({
        campaign,
        started_at: startDate.toISOString().split('T')[0],
        days_since_start: daysSinceStart,
        daily_counts: sendRows.map(r => ({
          day: r.send_date,
          sent: r.sent,
        })),
        current_day_target: currentDayTarget,
        current_day_sent: todaySent,
        ramp_stage: rampStage,
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })

  // ── Pause All (emergency) ────────────────────────────────────────────
  //
  // POST /api/campaigns/pause-all
  //
  // Halt-protocol emergency button: pauses every campaign in status
  // 'running' or 'sending' in a single atomic transaction. Operator may
  // optionally supply a reason which is stored in every audit row.
  //
  // Body (optional): { reason?: string }
  //
  // Response 200:
  //   { paused_campaigns: number[], count: number, paused_at: ISO }
  //
  // Response 200 (idempotent / no running campaigns):
  //   { paused_campaigns: [], count: 0, paused_at: ISO }
  //
  // Boundaries:
  //   - 401 without X-API-Key (global auth middleware)
  //   - 200 always (0 paused when nothing was running — idempotent)
  //   - ROLLBACK when any UPDATE or audit INSERT fails
  //
  // NOTE: This route MUST be declared before `/api/campaigns/:id` routes
  // because Express matches patterns top-to-bottom. "pause-all" would be
  // captured by the :id wildcard if registered later.
  app.post('/api/campaigns/pause-all', async (req, res) => {
    setRouteTags({ 'campaign.action': 'pause-all' })
    const client = await pool.connect()
    try {
      const reason = (typeof req.body?.reason === 'string' && req.body.reason.trim()) || null

      await client.query('BEGIN')

      // Select all running/sending campaigns in one shot for both the UPDATE
      // and the per-campaign audit rows.
      const { rows: targets } = await client.query(
        `SELECT id, status FROM campaigns WHERE status IN ('running', 'sending')`,
      )

      if (targets.length === 0) {
        await client.query('ROLLBACK')
        client.release()
        return res.json({
          paused_campaigns: [],
          count: 0,
          paused_at: new Date().toISOString(),
        })
      }

      // Bulk UPDATE in one query — atomic with the surrounding transaction.
      const ids = targets.map(r => r.id)
      await client.query(
        `UPDATE campaigns SET status='paused' WHERE id = ANY($1::int[])`,
        [ids],
      )

      // One audit row per paused campaign — forensic trail for operators.
      const pausedAt = new Date().toISOString()
      for (const c of targets) {
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_pause_all', 'dashboard_operator', 'campaign', $1, $2::jsonb)`,
          [String(c.id), JSON.stringify({
            prev_status: c.status,
            reason,
            batch_size: targets.length,
            timestamp: pausedAt,
          })],
        )
      }

      await client.query('COMMIT')
      client.release()

      return res.json({
        paused_campaigns: ids,
        count: ids.length,
        paused_at: pausedAt,
      })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      client.release()
      capture500(res, e, safeError)
    }
  })

  // M4.4 — POST /api/campaigns/:id/reset-next-send-at
  //
  // Operator-controlled scheduling reset. Moves pending/queued contacts whose
  // next_send_at is in the future back to NOW() so the campaign can resume
  // sending immediately.
  //
  // Boundaries enforced (HARD RULE feedback_campaign_send):
  //   - 400 confirm !== true
  //   - 400 reason missing / < 10 chars
  //   - 404 campaign not found
  //   - 200 { updated, campaign_id, requested_at, reason }
  //
  // Only forward-shifts are reset (SQL WHERE next_send_at > NOW()).
  app.post('/api/campaigns/:id/reset-next-send-at', async (req, res) => {
    setRouteTags({ 'campaign.action': 'reset-next-send-at' })
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(404).json({ error: 'not found' })
      }
      const { confirm, reason } = req.body || {}
      if (confirm !== true) {
        return res.status(400).json({ error: 'confirm must be true' })
      }
      if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
        return res.status(400).json({ error: 'reason must be at least 10 characters' })
      }

      const { rows: campRows } = await pool.query(
        `SELECT id, name FROM campaigns WHERE id=$1`,
        [req.params.id],
      )
      if (!campRows.length) return res.status(404).json({ error: 'campaign not found' })

      const { rowCount } = await pool.query(
        `UPDATE campaign_contacts
            SET next_send_at = NOW()
          WHERE campaign_id = $1
            AND status IN ('pending', 'queued')
            AND next_send_at > NOW()`,
        [req.params.id],
      )
      const count = rowCount ?? 0

      try {
        await pool.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_next_send_reset', 'operator', 'campaign', $1, $2::jsonb)`,
          [String(req.params.id), JSON.stringify({ count, reason: reason.trim() })],
        )
      } catch { /* audit best-effort */ }

      return res.json({
        updated: count,
        campaign_id: Number(req.params.id),
        requested_at: new Date().toISOString(),
        reason: reason.trim(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  // PATCH /api/campaigns/:id/contacts/:contact_id/reset-next-send (#1403)
  // Per-contact reschedule — sets one contact's next_send_at = NOW() so the
  // next sender tick picks it up. Replaces the raw-SQL workaround the operator
  // had to use for a single stuck/skip-recovered contact (UX-UI-first). Gated
  // by X-Confirm-Send: yes (send-adjacent) + audit-logged.
  app.patch('/api/campaigns/:id/contacts/:contact_id/reset-next-send', async (req, res) => {
    try {
      const campaignId = Number.parseInt(req.params.id, 10)
      const contactId = Number.parseInt(req.params.contact_id, 10)
      if (!Number.isFinite(campaignId) || !Number.isFinite(contactId)) {
        return res.status(400).json({ error: 'invalid id' })
      }
      if (req.get('X-Confirm-Send') !== 'yes') {
        return res.status(400).json({ error: 'missing_confirmation', detail: 'X-Confirm-Send: yes header required' })
      }
      const { rows } = await pool.query(
        `UPDATE campaign_contacts
            SET next_send_at = NOW()
          WHERE campaign_id = $1 AND contact_id = $2
          RETURNING contact_id, status, next_send_at`,
        [campaignId, contactId],
      )
      if (!rows.length) return res.status(404).json({ error: 'campaign_contact not found' })
      try {
        await pool.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_contact_next_send_reset', 'operator', 'campaign', $1, $2::jsonb)`,
          [String(campaignId), JSON.stringify({ contact_id: contactId, status: rows[0].status })],
        )
      } catch { /* audit best-effort */ }
      return res.json({ ok: true, campaign_id: campaignId, contact_id: contactId, status: rows[0].status, next_send_at: rows[0].next_send_at })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── PUT /api/campaigns/:id/sequence ──────────────────────────────────────
  //
  // Sprint L1 (deliverability initiative #1272) — operator-driven
  // sequence_config editor. Replaces the campaigns.sequence_config JSONB
  // column with a validated new array. Each step must reference an
  // existing template in email_templates so the runner doesn't render
  // an empty body.
  //
  // Body shape:
  //   { steps: [{ step: int, template: string, delay_days: int }, ...] }
  //
  // Validation (all must pass or 400):
  //   - 1 ≤ steps.length ≤ 10 (operator sanity)
  //   - step indexes are 0..N-1 sequential (no gaps, no dupes)
  //   - delay_days monotonically non-decreasing (sequence ordering)
  //   - each step.template exists in email_templates table
  //   - 0 ≤ delay_days ≤ 90 (operator policy)
  //
  // Per HARD rules:
  //   - feedback_audit_log_on_mutations: operator_audit_log INSERT in
  //     same transaction with prev/next diff
  //   - feedback_no_pii_in_commands: response carries new sequence
  //     verbatim; no contact emails
  app.put('/api/campaigns/:id/sequence', async (req, res) => {
    setRouteTags({ 'campaign.action': 'sequence' })
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid campaign id' })
      }
      const { steps } = req.body || {}
      if (!Array.isArray(steps)) {
        return res.status(400).json({ error: 'steps must be an array' })
      }
      if (steps.length < 1 || steps.length > 10) {
        return res.status(400).json({ error: 'steps must have 1..10 entries' })
      }

      // Validate shape + monotonicity + bounds in one pass.
      let prevDelay = -1
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]
        if (typeof s !== 'object' || s === null) {
          return res.status(400).json({ error: `step ${i} not an object` })
        }
        if (s.step !== i) {
          return res.status(400).json({ error: `step ${i} has wrong index (expected ${i}, got ${s.step})` })
        }
        if (typeof s.template !== 'string' || s.template.trim().length === 0) {
          return res.status(400).json({ error: `step ${i} missing template name` })
        }
        if (!Number.isInteger(s.delay_days) || s.delay_days < 0 || s.delay_days > 90) {
          return res.status(400).json({ error: `step ${i} delay_days must be integer 0..90` })
        }
        if (s.delay_days < prevDelay) {
          return res.status(400).json({ error: `step ${i} delay_days (${s.delay_days}) less than previous (${prevDelay})` })
        }
        prevDelay = s.delay_days
      }

      // Check all referenced templates exist.
      const tplNames = [...new Set(steps.map(s => s.template.trim()))]
      const { rows: tplRows } = await pool.query(
        `SELECT name FROM email_templates WHERE name = ANY($1::text[])`,
        [tplNames],
      )
      const tplFound = new Set(tplRows.map(r => r.name))
      const missingTpls = tplNames.filter(n => !tplFound.has(n))
      if (missingTpls.length > 0) {
        return res.status(400).json({
          error: 'unknown template(s)',
          missing: missingTpls,
        })
      }

      // Campaign existence + snapshot prev sequence for audit diff.
      const { rows: campRows } = await pool.query(
        `SELECT id, name, sequence_config FROM campaigns WHERE id=$1`,
        [req.params.id],
      )
      if (!campRows.length) return res.status(404).json({ error: 'campaign not found' })
      const prevSequence = campRows[0].sequence_config ?? []

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const normalized = steps.map(s => ({
          step: s.step,
          template: s.template.trim(),
          delay_days: s.delay_days,
        }))

        await client.query(
          `UPDATE campaigns SET sequence_config=$1::jsonb, updated_at=now() WHERE id=$2`,
          [JSON.stringify(normalized), req.params.id],
        )

        const operator =
          (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
          (req.user && req.user.email) ||
          'unknown'
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_sequence_update', $1, 'campaign', $2, $3::jsonb)`,
          [operator, String(req.params.id), JSON.stringify({
            prev_sequence: prevSequence,
            next_sequence: normalized,
            step_count_diff: normalized.length - (Array.isArray(prevSequence) ? prevSequence.length : 0),
          })],
        )

        await client.query('COMMIT')
        client.release()
        return res.json({
          ok: true,
          campaign_id: Number(req.params.id),
          sequence: normalized,
          updated_at: new Date().toISOString(),
        })
      } catch (e) {
        try { await client.query('ROLLBACK') } catch { /* ignored */ }
        client.release()
        throw e
      }
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── POST /api/campaigns/:id/unskip ───────────────────────────────────────
  //
  // Sprint O1 (operational follow-up to #1270): the dedup_guard freemail
  // fix prevented future skips but left ~21,725 contacts with terminal
  // status='skipped' + details.skip_reason='per_domain_cooldown'. Those
  // contacts never re-enter the eligibility query (which filters status
  // IN pending/in_sequence).
  //
  // This endpoint flips status back to 'pending' for contacts whose
  // skip_reason matches the filter. Defaults to per_domain_cooldown (the
  // freemail-bug cohort) but accepts any reason string so future fixes
  // can use the same surface.
  //
  // HARD RULES enforced:
  //   - feedback_campaign_send: confirm=true required + reason 10+ chars
  //   - feedback_audit_log_on_mutations: operator_audit_log INSERT in the
  //     same transaction
  //   - feedback_no_pii_in_commands: response carries counts only,
  //     no contact emails
  app.post('/api/campaigns/:id/unskip', async (req, res) => {
    setRouteTags({ 'campaign.action': 'unskip' })
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid campaign id' })
      }
      const { confirm, reason, skip_reason_filter } = req.body || {}
      if (confirm !== true) {
        return res.status(400).json({ error: 'confirm must be true' })
      }
      if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
        return res.status(400).json({ error: 'reason must be at least 10 characters' })
      }
      // Filter is optional but recommended. Empty/missing = unskip ALL
      // skipped contacts (operator may intend that for total-reset, but
      // we still require the reason narrative to discourage casual use).
      const filter = (typeof skip_reason_filter === 'string' && skip_reason_filter.trim().length > 0)
        ? skip_reason_filter.trim()
        : null

      // Campaign existence check.
      const { rows: campRows } = await pool.query(
        `SELECT id, name FROM campaigns WHERE id=$1`,
        [req.params.id],
      )
      if (!campRows.length) return res.status(404).json({ error: 'campaign not found' })

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Build WHERE clause. Always restricted to status='skipped' to
        // prevent accidental clobber of in_flight / completed contacts.
        const whereParts = [
          'campaign_id = $1',
          `status = 'skipped'`,
        ]
        const params = [Number(req.params.id)]
        if (filter) {
          whereParts.push(`details->>'skip_reason' = $2`)
          params.push(filter)
        }
        const whereClause = whereParts.join(' AND ')

        // Count before flip so the response + audit have an accurate
        // number even if a parallel job re-skips some rows.
        const { rows: [countRow] } = await client.query(
          `SELECT COUNT(*)::bigint AS n FROM campaign_contacts WHERE ${whereClause}`,
          params,
        )
        const eligible = Number(countRow?.n || 0)

        // Flip status, clear skip-reason marker, reset send time so the
        // runner picks them up on the next tick.
        const { rowCount } = await client.query(
          `UPDATE campaign_contacts
              SET status        = 'pending',
                  next_send_at  = NOW(),
                  details       = COALESCE(details, '{}'::jsonb)
                                  - 'skip_reason'
                                  - 'skipped_by'
                                  - 'skipped_at'
                                  - 'rules_evaluated'
                                  || jsonb_build_object('unskipped_at', to_jsonb(NOW()),
                                                        'unskipped_reason', $${params.length + 1}::text,
                                                        'unskipped_from_reason', $${params.length + 2}::text)
            WHERE ${whereClause}`,
          [...params, reason.trim(), filter || '(all)'],
        )
        const updated = rowCount ?? 0

        // Audit row in same transaction — HARD per feedback_audit_log_on_mutations.
        const operator =
          (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
          (req.user && req.user.email) ||
          'unknown'
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_unskip', $1, 'campaign', $2, $3::jsonb)`,
          [operator, String(req.params.id), JSON.stringify({
            eligible_count: eligible,
            updated_count: updated,
            skip_reason_filter: filter,
            reason: reason.trim(),
          })],
        )

        await client.query('COMMIT')
        client.release()
        return res.json({
          ok: true,
          campaign_id: Number(req.params.id),
          updated,
          skip_reason_filter: filter,
          requested_at: new Date().toISOString(),
        })
      } catch (e) {
        try { await client.query('ROLLBACK') } catch { /* ignored */ }
        client.release()
        throw e
      }
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── POST /api/campaigns/:id/skip-by-domains ─────────────────────────────
  //
  // Sprint AH2 (2026-05-15) — Bulk-skip operator action. Flips
  // campaign_contacts.status from pending|in_flight → 'skipped' for every
  // contact whose email domain matches any of the supplied domains.
  //
  // Motivates today's manual SQL where the operator skipped 104 contacts
  // across 11 holding domains (renofarmy.cz + parent ICO overlap). The AF
  // gate (corporate_domain_lifetime_cap) is a per-send runtime check; it
  // does not retire already-queued in_flight rows, so the UX gap was P0.
  //
  // HARD RULES enforced:
  //   - feedback_audit_log_on_mutations (T0): per-row INSERT into
  //     operator_audit_log inside the same tx as the UPDATE.
  //   - feedback_no_pii_in_commands (T0): response carries counts +
  //     per-domain breakdown only, never the affected emails.
  //   - feedback_campaign_send (T0): confirm=true required + non-empty reason.
  //   - feedback_schema_verify_before_sql (T0): campaign_contacts.status +
  //     details columns verified via migrations 034 + 049; operator_audit_log
  //     columns verified via migration 044; contacts.email via 030.
  //
  // Request body (JSON):
  //   {
  //     "domains": ["renofarmy.cz", "iex.cz"],
  //     "reason": "operator_detected_holding_overlap",
  //     "status_filter": ["pending", "in_flight"],
  //     "confirm": true
  //   }
  //
  // Query param:
  //   ?dry_run=true  — return matched count + top domains without UPDATE.
  //
  // Response shape (200 OK):
  //   { ok, campaign_id, dry_run, updated, top_domains: [{domain, count}],
  //     status_filter, reason, requested_at }
  //
  // Error responses:
  //   400 — invalid id, bad domains, missing confirm/reason, bad filter
  //   404 — campaign not found
  //   500 — unexpected error
  app.post('/api/campaigns/:id/skip-by-domains', async (req, res) => {
    setRouteTags({ 'campaign.action': 'skip-by-domains' })
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid campaign id' })
      }
      const campaignId = Number(req.params.id)
      const dryRun = req.query.dry_run === 'true' || req.query.dry_run === '1'

      const body = req.body || {}

      // ── Validation: domains ────────────────────────────────────────────
      const rawDomains = Array.isArray(body.domains) ? body.domains : null
      if (!rawDomains || rawDomains.length === 0) {
        return res.status(400).json({ error: 'domains must be a non-empty array' })
      }
      if (rawDomains.length > SKIP_BY_DOMAIN_MAX_DOMAINS) {
        return res.status(400).json({
          error: 'too_many_domains',
          message: `max ${SKIP_BY_DOMAIN_MAX_DOMAINS} domains per request, got ${rawDomains.length}`,
        })
      }
      // Lowercase + dedup. Reject anything that is not a plausible domain.
      const seen = new Set()
      const domains = []
      for (const raw of rawDomains) {
        if (typeof raw !== 'string') {
          return res.status(400).json({ error: 'invalid_domain', message: `domain must be a string: ${JSON.stringify(raw)}` })
        }
        const d = raw.trim().toLowerCase()
        if (!DOMAIN_VALIDATE_RE.test(d)) {
          return res.status(400).json({ error: 'invalid_domain', message: `invalid domain syntax: ${raw}` })
        }
        if (!seen.has(d)) {
          seen.add(d)
          domains.push(d)
        }
      }

      // ── Validation: status_filter ──────────────────────────────────────
      const rawStatusFilter = Array.isArray(body.status_filter) ? body.status_filter : ['pending', 'in_flight']
      const statusFilter = []
      for (const s of rawStatusFilter) {
        if (typeof s !== 'string' || !SKIP_BY_DOMAIN_ALLOWED_STATUSES.has(s)) {
          return res.status(400).json({
            error: 'invalid_status_filter',
            message: `status must be one of ${[...SKIP_BY_DOMAIN_ALLOWED_STATUSES].join('|')}, got ${JSON.stringify(s)}`,
          })
        }
        if (!statusFilter.includes(s)) statusFilter.push(s)
      }
      if (statusFilter.length === 0) {
        return res.status(400).json({ error: 'invalid_status_filter', message: 'status_filter must contain at least one of pending|in_flight' })
      }

      // ── Validation: reason + confirm (mutation path only) ──────────────
      const reason = (typeof body.reason === 'string' ? body.reason.trim() : '')
      if (!reason) {
        return res.status(400).json({ error: 'reason must be a non-empty string' })
      }
      if (!dryRun) {
        if (body.confirm !== true) {
          return res.status(400).json({ error: 'confirm must be true' })
        }
        const confirmHeader = req.headers['x-confirm-send']
        if (confirmHeader !== 'yes') {
          return res.status(412).json({
            error: 'missing_confirm_header',
            message: 'X-Confirm-Send: yes header required for mutation path',
          })
        }
      }

      // ── Campaign existence check ───────────────────────────────────────
      const { rows: campRows } = await pool.query(
        `SELECT id, name FROM campaigns WHERE id=$1`,
        [campaignId],
      )
      if (!campRows.length) return res.status(404).json({ error: 'campaign not found' })

      // ── Dry-run path: count + top-domain breakdown, no UPDATE ──────────
      if (dryRun) {
        const { rows: breakdown } = await pool.query(
          `SELECT LOWER(SPLIT_PART(c.email, '@', 2)) AS domain,
                  COUNT(*)::int AS count
             FROM campaign_contacts cc
             JOIN contacts c ON c.id = cc.contact_id
            WHERE cc.campaign_id = $1
              AND cc.status = ANY($2::text[])
              AND LOWER(SPLIT_PART(c.email, '@', 2)) = ANY($3::text[])
            GROUP BY 1
            ORDER BY count DESC`,
          [campaignId, statusFilter, domains],
        )
        const total = breakdown.reduce((acc, r) => acc + (r.count ?? 0), 0)
        return res.json({
          ok: true,
          campaign_id: campaignId,
          dry_run: true,
          updated: 0,
          matched: total,
          top_domains: breakdown.slice(0, SKIP_BY_DOMAIN_TOP_LIMIT),
          status_filter: statusFilter,
          domains,
          reason,
          requested_at: new Date().toISOString(),
        })
      }

      // ── Mutation path: UPDATE + per-row audit in same tx ───────────────
      const operator =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'operator_bulk_skip_ui'

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // 1) Flip status + stamp details. RETURNING gives us per-row ids +
        //    the domain (re-derived from email) so we can fan-out audit rows
        //    without surfacing raw email addresses (PII guard).
        const { rows: affected } = await client.query(
          `UPDATE campaign_contacts cc
             SET status='skipped',
                 next_send_at=NULL,
                 details = COALESCE(cc.details, '{}'::jsonb)
                           || jsonb_build_object(
                                'skip_reason',  'bulk_skip_by_domain',
                                'skip_subreason', $4::text,
                                'skip_domains', to_jsonb($3::text[]),
                                'skipped_at',   to_jsonb(NOW()),
                                'skipped_by',   'operator_bulk_skip_ui'
                              ),
                 updated_at = NOW()
            FROM contacts c
            WHERE cc.contact_id = c.id
              AND cc.campaign_id = $1
              AND cc.status = ANY($2::text[])
              AND LOWER(SPLIT_PART(c.email, '@', 2)) = ANY($3::text[])
            RETURNING cc.id, cc.contact_id,
                      LOWER(SPLIT_PART(c.email, '@', 2)) AS domain`,
          [campaignId, statusFilter, domains, reason],
        )
        const updated = affected.length

        // 2) Per-row audit. Single INSERT with VALUES list keeps the audit
        //    in the same tx and avoids N round-trips.
        if (updated > 0) {
          const auditValues = []
          const auditParams = []
          for (let i = 0; i < affected.length; i++) {
            const row = affected[i]
            const base = i * 6
            auditValues.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6})`)
            auditParams.push(
              'campaign_contact.bulk_skip_by_domain',
              operator,
              'campaign_contact',
              String(row.id),
              JSON.stringify({
                reason,
                domain: row.domain,
                contact_id: row.contact_id,
                campaign_id: campaignId,
              }),
              new Date().toISOString(),
            )
          }
          // operator_audit_log columns: action, actor, entity_type,
          // entity_id, details, created_at (migration 044).
          await client.query(
            `INSERT INTO operator_audit_log
               (action, actor, entity_type, entity_id, details, created_at)
             VALUES ${auditValues.join(', ')}`,
            auditParams,
          )
        }

        await client.query('COMMIT')
        client.release()

        // Build a domain breakdown for the UI confirmation toast.
        const counts = new Map()
        for (const r of affected) {
          counts.set(r.domain, (counts.get(r.domain) || 0) + 1)
        }
        const topDomains = [...counts.entries()]
          .map(([domain, count]) => ({ domain, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, SKIP_BY_DOMAIN_TOP_LIMIT)

        return res.json({
          ok: true,
          campaign_id: campaignId,
          dry_run: false,
          updated,
          top_domains: topDomains,
          status_filter: statusFilter,
          domains,
          reason,
          requested_at: new Date().toISOString(),
        })
      } catch (e) {
        try { await client.query('ROLLBACK') } catch { /* ignored */ }
        client.release()
        throw e
      }
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── POST /api/campaigns/:id/send-batch?count=N ──────────────────────────
  //
  // K1 / H2.4 — Operator-facing BFF endpoint that runs the campaign batch
  // send for the next N pending contacts.  Wraps the shared
  // src/lib/campaign-send-batch.js logic (extracted from the CLI script
  // apps/outreach-dashboard/campaign-send-batch.mjs).
  //
  // HARD RULES (all enforced here and in the shared lib):
  //   - X-Confirm-Send: 1 header REQUIRED (feedback_campaign_send).
  //   - Anti-trace relay path mandatory (feedback_anti_trace_full_stack).
  //   - SMTP passwords read from DB only (feedback_mailbox_passwords_via_db).
  //   - PII guard: raw email addresses are NOT returned in the response
  //     (feedback_no_pii_in_commands). Only contact_id + envelope_id.
  //   - H2.1: FOR UPDATE SKIP LOCKED in shared lib.
  //   - H2.2: idempotency check via operator_audit_log in shared lib.
  //
  // Response shape (200 OK):
  //   { ok, campaign_id, requested, picked, sent, skipped_idempotent, failed,
  //     envelopes: [{contact_id, cc_id, envelope_id, skipped?, error?}] }
  //
  // Error responses:
  //   423 — outside Mo–Fr 08:00–16:59 Prague send window (AR7; override with X-Force-Send: yes)
  //   429 — rate limit exceeded (Sprint T4: max 1 req/30s per campaign)
  //   412 — missing X-Confirm-Send: 1 header
  //   400 — invalid campaign_id or count (1–100)
  //   404 — campaign not found
  //   503 — relay not configured
  //   500 — unexpected error
  app.post('/api/campaigns/:id/send-batch', async (req, res) => {
    setRouteTags({ 'campaign.action': 'send-batch' })
    try {
      // ── Param validation ────────────────────────────────────────────────
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid campaign_id' })
      }
      const campaignId = parseInt(req.params.id, 10)
      const count = parseInt(req.query.count || '1', 10)
      if (!Number.isFinite(count) || count < 1 || count > 100) {
        return res.status(400).json({ error: 'count must be between 1 and 100' })
      }

      // ── Sprint T4: rate limit ────────────────────────────────────────────
      const rl = checkSendBatchRateLimit(campaignId)
      if (!rl.allowed) {
        return res.status(429).json({
          error: 'rate_limit_exceeded',
          message: `send-batch allows max 1 request per ${SEND_BATCH_RATE_LIMIT_MS / 1000}s per campaign. Retry in ${rl.retryAfterSec}s.`,
          retry_after_seconds: rl.retryAfterSec,
        })
      }

      // ── AR7: Send window gate ────────────────────────────────────────────
      // Hard-blocks batch sends outside Mo–Fr 08:00–16:59 Prague time.
      // Override with X-Force-Send: yes header (operator emergency only).
      // Force overrides are audit-logged + Sentry-alerted.
      const force = req.headers['x-force-send'] === 'yes'
      if (!isWithinSendWindow(new Date(), 'Europe/Prague')) {
        if (!force) {
          const retryAfterSec = secondsToMidnightPragueUTC()
          return res.status(423).json({
            error: 'send_window_closed',
            hint: 'Batch sends allowed Mo–Fr 08:00–16:59 Prague time. Override with X-Force-Send: yes.',
            retry_after_seconds: retryAfterSec,
          })
        }
        // Force override — audit log + Sentry alert
        // P1.10 fix: capture actor identity from request instead of
        // hardcoding 'dashboard_user'. Fall back through a priority chain.
        const actor = req.headers['x-operator-id'] || req.user?.email || req.user?.id || 'unknown_actor'
        try {
          await pool.query(
            `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
             VALUES ('send_window_force_override', $1, 'campaign', $2, $3::jsonb)`,
            [String(actor), String(campaignId), JSON.stringify({ campaignId, count, actor, at: new Date().toISOString() })],
          )
        } catch { /* audit best-effort */ }
        try {
          safeError?.captureMessage?.(`send_window_force_override actor=${actor} mailbox_id_hint=batch`, { level: 'warning', extra: { campaignId, actor } })
        } catch { /* Sentry best-effort */ }
        console.warn(`[AR7] send_window_force_override campaign=${campaignId} count=${count} actor=${actor}`)
      }

      // ── HARD RULE: explicit consent header ──────────────────────────────
      if (req.headers['x-confirm-send'] !== '1') {
        return res.status(412).json({
          error: 'X-Confirm-Send: 1 header required',
          hint: 'This endpoint sends real emails. Acknowledge by adding the header X-Confirm-Send: 1.',
        })
      }

      // ── Relay config ────────────────────────────────────────────────────
      const relayURL =
        process.env.ANTI_TRACE_URL ||
        process.env.ANTI_TRACE_RELAY_URL ||
        (await pool.query(`SELECT value FROM outreach_config WHERE key='anti_trace_url'`).catch(() => ({ rows: [] }))).rows[0]?.value
      const relayToken =
        process.env.ANTI_TRACE_TOKEN ||
        process.env.ANTI_TRACE_RELAY_TOKEN

      if (!relayURL || !relayToken) {
        return res.status(503).json({
          ok: false,
          error: 'Anti-trace-relay não configurado — recusando envio (HARD RULE: feedback_anti_trace_full_stack).',
          hint: 'Set ANTI_TRACE_RELAY_URL + ANTI_TRACE_RELAY_TOKEN env vars (or outreach_config.anti_trace_url in DB).',
        })
      }

      // ── Execute batch ───────────────────────────────────────────────────
      const result = await sendCampaignBatch({
        pool,
        campaignId,
        count,
        relayURL,
        relayToken,
      })

      return res.json(result)
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message })
      if (e.code === 'CONFIG_ERROR' || e.code === 'TEMPLATE_NOT_FOUND') {
        return res.status(422).json({ error: e.message })
      }
      if (e.code === 'NO_MAILBOXES' || e.code === 'NO_PASSWORDS') {
        return res.status(503).json({ error: e.message })
      }
      // AP1 — DB trigger warmup_cap_exceeded: translate to 429 + Retry-After.
      // Trigger uses ERRCODE 23514 (check_violation) with message containing
      // "warmup_cap_exceeded: mailbox=... phase=... sent_today=... cap=...".
      if (isWarmupCapError(e)) {
        const detail = parseWarmupCapDetail(e.message || '')
        const retryAfter = secondsToMidnightPragueUTC()
        return res.status(429).set('Retry-After', String(retryAfter)).json({
          ok: false,
          error: 'warmup_cap_exceeded',
          detail,
          retry_after_s: retryAfter,
        })
      }
      capture500(res, e, safeError)
    }
  })

  // AW8-2 — GET /api/campaigns/:id/in-flight-count
  //
  // Returns the number of campaign_contacts currently reserved by the runner
  // (status='in_flight'). Surfaced on CampaignDetail Odeslání tab so the
  // operator can see if any contact is stuck mid-reservation. After Sprint
  // AW7 (PR #1186, runner-engine atomicity), `in_flight` is the canonical
  // intermediate state between reservation and final disposition (sent /
  // bounced / pending). A non-zero value persisting > a few seconds suggests
  // the runner crashed mid-step.
  //
  // Response shape: { count: number, generated_at: string }
  // GET /api/campaigns/:id/priority-distribution
  //
  // Returns the count of pending campaign_contacts grouped by lead-score
  // tier (migration 111 — campaign_contacts.priority is REAL, default 0).
  // Drives the tier preview panel on CampaignDetail so the operator can
  // see how many A/B/C/D/E-tier contacts remain before clicking a batch
  // button. Pure SELECT COUNT — cache-friendly, no mutation.
  //
  // Tier thresholds mirror tierFromPriority() in
  // src/lib/campaign-send-batch.js so UI labels stay consistent.
  //
  // Response shape:
  //   {
  //     campaign_id, total_pending,
  //     tiers: { 'A_top_0.90+': n, 'B_high_0.78-0.89': n, ... },
  //     mean_priority: number|null,
  //     generated_at,
  //   }
  app.get('/api/campaigns/:id/priority-distribution', async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid campaign id' })
      }
      const id = Number(req.params.id)

      // 404 guard — keep parity with other campaign endpoints.
      const { rows: campRows } = await pool.query(
        `SELECT id FROM campaigns WHERE id=$1`, [id],
      )
      if (!campRows.length) {
        return res.status(404).json({ error: 'campaign not found' })
      }

      const { rows: tierRows } = await pool.query(`
        SELECT
          CASE WHEN priority >= 0.90 THEN 'A_top_0.90+'
               WHEN priority >= 0.78 THEN 'B_high_0.78-0.89'
               WHEN priority >= 0.65 THEN 'C_mid_0.65-0.77'
               WHEN priority >= 0.50 THEN 'D_low_0.50-0.64'
               ELSE                       'E_dead_below_0.50' END AS tier,
          COUNT(*)::int AS n
        FROM campaign_contacts
        WHERE campaign_id = $1 AND status = 'pending'
        GROUP BY 1
      `, [id])

      const tiers = {
        'A_top_0.90+':       0,
        'B_high_0.78-0.89':  0,
        'C_mid_0.65-0.77':   0,
        'D_low_0.50-0.64':   0,
        'E_dead_below_0.50': 0,
      }
      let total = 0
      for (const r of tierRows) {
        tiers[r.tier] = r.n
        total += r.n
      }

      const { rows: meanRows } = await pool.query(`
        SELECT AVG(priority)::float AS mean
        FROM campaign_contacts
        WHERE campaign_id = $1 AND status = 'pending'
      `, [id]).catch(() => ({ rows: [{ mean: null }] }))

      res.json({
        campaign_id: id,
        total_pending: total,
        tiers,
        mean_priority: meanRows[0]?.mean ?? null,
        generated_at: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── POST /api/campaigns/:id/filter-tier ─────────────────────────────────
  //
  // UX-1 (2026-05-14) — Operator-driven pre-launch tier filter. Flips
  // campaign_contacts.status from 'pending'/'in_flight' to 'skipped'
  // for any contact with priority < $max. Default $max = 0.50 (E-tier).
  //
  // Drives the LaunchConfirmModal checkbox: when the operator opts to
  // exclude E-tier before launching, the UI POSTs here with max=0.50
  // and then the resume call proceeds with a smaller cohort.
  //
  // HARD RULES enforced:
  //   - feedback_audit_log_on_mutations (T0): operator_audit_log INSERT
  //     is in the same transaction as the UPDATE. ROLLBACK on failure.
  //   - feedback_no_magic_thresholds (T0): max is clamped to the
  //     E-tier band (0..D_TIER_MIN where D_TIER_MIN = 0.50). Anything
  //     outside that band is rejected with 400.
  //   - feedback_no_pii_in_commands (T0): response carries counts only,
  //     no contact emails.
  //
  // Request body / query:
  //   ?max=<float, default 0.50> — exclusive upper bound. Contacts with
  //                                priority < $max are flipped to skipped.
  //   ?dry_run=1 — return the would-be-skipped count without UPDATE.
  //
  // Response shape:
  //   { ok, campaign_id, max_priority, rows_skipped, dry_run, requested_at }
  app.post('/api/campaigns/:id/filter-tier', async (req, res) => {
    setRouteTags({ 'campaign.action': 'filter-tier' })
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid campaign_id' })
      }
      const campaignId = parseInt(req.params.id, 10)
      const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true'

      // HARD RULE feedback_no_magic_thresholds — accept only the E-tier
      // band. D_TIER_MIN = 0.50 is the published E-tier ceiling; raising
      // max beyond it would silently kill D-tier viable contacts too.
      const D_TIER_MIN = 0.50
      const rawMax = req.query.max ?? req.body?.max ?? D_TIER_MIN
      const max = Number(rawMax)
      if (!Number.isFinite(max) || max <= 0 || max > D_TIER_MIN) {
        return res.status(400).json({
          error: 'invalid_max',
          message: `max must be > 0 and <= ${D_TIER_MIN} (E-tier band)`,
          received: rawMax,
        })
      }

      // Campaign existence check up front so we don't open a tx for nothing.
      const { rows: campRows } = await pool.query(
        `SELECT id, name FROM campaigns WHERE id=$1`,
        [campaignId],
      )
      if (!campRows.length) return res.status(404).json({ error: 'campaign not found' })

      // Dry-run path: count only, no UPDATE.
      if (dryRun) {
        const { rows: [r = { n: 0 }] } = await pool.query(
          `SELECT COUNT(*)::int AS n
             FROM campaign_contacts
            WHERE campaign_id = $1
              AND priority < $2
              AND status IN ('pending', 'in_flight')`,
          [campaignId, max],
        )
        return res.json({
          ok: true,
          campaign_id: campaignId,
          max_priority: max,
          rows_skipped: r.n ?? 0,
          dry_run: true,
          requested_at: new Date().toISOString(),
        })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // UPDATE — flip pending/in_flight contacts below the threshold to skipped.
        // We deliberately do NOT touch 'completed' / 'sent' rows.
        const { rowCount } = await client.query(
          `UPDATE campaign_contacts
              SET status       = 'skipped',
                  next_send_at = NULL,
                  details      = COALESCE(details, '{}'::jsonb)
                                 || jsonb_build_object(
                                      'skip_reason',         'low_priority_tier_filter',
                                      'skipped_at',          to_jsonb(NOW()),
                                      'skipped_max_priority', to_jsonb($2::float)
                                    )
            WHERE campaign_id = $1
              AND priority    < $2
              AND status      IN ('pending', 'in_flight')`,
          [campaignId, max],
        )
        const updated = rowCount ?? 0

        // Audit row in same transaction — HARD per feedback_audit_log_on_mutations.
        const operator =
          (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
          (req.user && req.user.email) ||
          'dashboard_user'
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_filter_tier', $1, 'campaign', $2, $3::jsonb)`,
          [operator, String(campaignId), JSON.stringify({
            max_priority: max,
            rows_skipped: updated,
          })],
        )

        await client.query('COMMIT')
        client.release()
        return res.json({
          ok: true,
          campaign_id: campaignId,
          max_priority: max,
          rows_skipped: updated,
          dry_run: false,
          requested_at: new Date().toISOString(),
        })
      } catch (e) {
        try { await client.query('ROLLBACK') } catch { /* ignored */ }
        client.release()
        throw e
      }
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── GET /api/campaigns/:id/reply-projection ─────────────────────────────
  //
  // UX-3 (2026-05-14) — Drives the ReplyLatencyWidget on CampaignDetail
  // Přehled tab. Returns the count of sends + replies in the last 24h
  // and a baseline-projection of how many replies the campaign should
  // eventually see. Read-only, pure SELECT.
  //
  // Response shape:
  //   {
  //     campaign_id: number,
  //     sent_today: number,           // last 24h
  //     replied_today: number,        // last 24h
  //     sent_total: number,           // all-time
  //     first_send_at: string | null, // ISO timestamp of MIN(sent_at)
  //     projection_replies: number,   // 0.015 * sent_total (rounded)
  //     generated_at: string,
  //   }
  app.get('/api/campaigns/:id/reply-projection', async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid campaign_id' })
      }
      const id = Number(req.params.id)
      const { rows: campRows } = await pool.query(
        `SELECT id FROM campaigns WHERE id=$1`, [id],
      )
      if (!campRows.length) {
        // Zero-state 200 so the widget stays inert without a console 404.
        return res.json({
          campaign_id: id,
          sent_today: 0,
          replied_today: 0,
          sent_total: 0,
          first_send_at: null,
          projection_replies: 0,
          generated_at: new Date().toISOString(),
        })
      }
      const { rows: [s = {}] } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='sent'    AND sent_at > now() - interval '24 hours')::int AS sent_today,
          COUNT(*) FILTER (WHERE status='replied' AND sent_at > now() - interval '24 hours')::int AS replied_today,
          COUNT(*) FILTER (WHERE status='sent')::int AS sent_total,
          MIN(sent_at) FILTER (WHERE status='sent') AS first_send_at
        FROM send_events
        WHERE campaign_id = $1
      `, [id]).catch(() => ({ rows: [{}] }))

      // EXPECTED_REPLY_RATE mirrors src/lib/leadTierThresholds.js (1.5%).
      // Kept inline here because BFF cannot import JSX-side ES module
      // (Vite-only export); change both together if the baseline shifts.
      const EXPECTED_REPLY_RATE = 0.015
      const sentTotal = s.sent_total ?? 0
      const projection = Math.round(sentTotal * EXPECTED_REPLY_RATE)

      res.json({
        campaign_id: id,
        sent_today:    s.sent_today    ?? 0,
        replied_today: s.replied_today ?? 0,
        sent_total:    sentTotal,
        first_send_at: s.first_send_at ?? null,
        projection_replies: projection,
        generated_at: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/campaigns/:id/in-flight-count', async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid id' })
      const id = Number(req.params.id)
      const { rows: [r = {}] } = await pool.query(`
        SELECT COUNT(*)::int AS count
        FROM campaign_contacts
        WHERE campaign_id = $1 AND status = 'in_flight'
      `, [id]).catch(() => ({ rows: [{ count: 0 }] }))
      res.json({
        count: r.count ?? 0,
        generated_at: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  // AW8-2 — GET /api/campaigns/last-24h-summary
  //
  // Aggregate sent/bounced/replied/suppressed across ALL campaigns in the
  // last 24h. Drives the inline notice on /campaigns so the operator gets
  // a one-line answer to "what happened today?" without drilling into each
  // campaign. Numbers come from `send_events` (canonical source — same table
  // used by /api/campaigns/:id/launch-stats).
  //
  // Response shape:
  //   { sent: number, bounced: number, replied: number, suppressed: number,
  //     active_campaigns: number, generated_at: string }
  app.get('/api/campaigns/last-24h-summary', async (_req, res) => {
    try {
      const { rows: [s = {}] } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='sent'       AND sent_at > now() - interval '24 hours')::int AS sent,
          COUNT(*) FILTER (WHERE status='bounced'    AND sent_at > now() - interval '24 hours')::int AS bounced,
          COUNT(*) FILTER (WHERE status='replied'    AND sent_at > now() - interval '24 hours')::int AS replied,
          COUNT(*) FILTER (WHERE status='suppressed' AND sent_at > now() - interval '24 hours')::int AS suppressed
        FROM send_events
      `).catch(() => ({ rows: [{}] }))
      const { rows: [a = {}] } = await pool.query(`
        SELECT COUNT(*)::int AS active_campaigns
        FROM campaigns
        WHERE status IN ('active', 'running')
      `).catch(() => ({ rows: [{ active_campaigns: 0 }] }))
      res.json({
        sent:             s.sent      ?? 0,
        bounced:          s.bounced   ?? 0,
        replied:          s.replied   ?? 0,
        suppressed:       s.suppressed ?? 0,
        active_campaigns: a.active_campaigns ?? 0,
        generated_at: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}

// ── AP1 warmup-cap error helpers ──────────────────────────────────────────────

/**
 * Returns true when a DB (or relay-propagated) error is a warmup cap trigger
 * violation. Matches ERRCODE 23514 OR the trigger message prefix.
 *
 * @param {Error} e
 * @returns {boolean}
 */
export function isWarmupCapError(e) {
  if (!e) return false
  if (e.code === '23514' && /warmup_cap_exceeded/i.test(e.message || '')) return true
  if (/warmup_cap_exceeded/i.test(e.message || '')) return true
  return false
}

/**
 * Parse detail fields from the trigger RAISE EXCEPTION message:
 * "warmup_cap_exceeded: mailbox=X phase=Y sent_today=N cap=M"
 *
 * @param {string} msg
 * @returns {{ phase: string|null, sent_today: number|null, cap: number|null }}
 */
export function parseWarmupCapDetail(msg) {
  const phase     = msg.match(/phase=(\S+)/)?.[1] ?? null
  const sentToday = msg.match(/sent_today=(\d+)/)?.[1] ?? null
  const cap       = msg.match(/cap=(\d+)/)?.[1] ?? null
  return {
    phase,
    sent_today: sentToday !== null ? Number(sentToday) : null,
    cap:        cap        !== null ? Number(cap)       : null,
  }
}

/**
 * Seconds from now until Prague midnight (for Retry-After header).
 * @returns {number}
 */
function secondsToMidnightPragueUTC() {
  const now = new Date()
  const pragueDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(now)
  // Tomorrow midnight Prague = today 00:00 Prague + 24h, expressed in UTC
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Prague',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now)
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
  const todayMidnightPrague = new Date(`${p.year}-${p.month}-${p.day}T00:00:00`)
  // Find Prague UTC offset
  const offsetParts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Prague', timeZoneName: 'longOffset',
  }).formatToParts(now)
  const tzName = offsetParts.find(x => x.type === 'timeZoneName')?.value ?? '+00:00'
  const m = tzName.match(/([+-])(\d{2}):(\d{2})/)
  const offsetMs = m ? (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0
  const tomorrowMidnightUTC = new Date(todayMidnightPrague.getTime() - offsetMs + 24 * 3600 * 1000)
  return Math.max(1, Math.ceil((tomorrowMidnightUTC.getTime() - now.getTime()) / 1000))
}
