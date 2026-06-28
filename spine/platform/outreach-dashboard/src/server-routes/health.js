// BFF health surface — operator + synthetic-monitor probes for liveness,
// invariants, cron heartbeats, watchdog, drift, and proxy pool state.
// ─────────────────────────────────────────────────────────────────────────────
// All endpoints in this module return JSON (no HTML). Most are read-only;
// /api/health/auto-recover-trigger (POST) is intentionally not extracted here
// because it depends on cron functions defined later in server.js — keeping
// it inline avoids a circular import.
//
// T3.3 (2026-05-01): extracted verbatim from server.js per ADR-008 D2 module
// sequence (after #448 mountDsrRoutes). Behavior is byte-equivalent to the
// inline declarations: same SQL, same response shape, same Sentry capture.
// Audit + contract tests verify the contract from this file.
//
// Contiguous block extracted (server.js 3107-3536 pre-extract):
//   GET /api/health/invariants
//   GET /api/health/cron-heartbeats
//   GET /api/health/test-quality
//   GET /api/health/system
//   GET /api/health/watchdog          (1st of 2 — Express keeps the first;
//                                     the dead duplicate at line 5394 stays
//                                     in server.js for separate cleanup)
//   GET /api/health/auth-fail-alerts
//   GET /api/health/proxy-exhaust
//   GET /api/health/guards
//   GET /api/health/drift
//
// Mutable state (lastStaleGuardRun, lastConfigDrift) lives in server.js and
// is exposed via getter/setter dependencies so cron loops + handlers share
// the same closure-captured values.

// MVP-4 — Cron heartbeat status. Reports per-cron last_run_at + duration +
// status, plus a `stale` flag computed from EXPECTED_INTERVAL_MS lookup.
// Rule of thumb: a cron is "stale" when last_run_at > 2× expected interval.
const CRON_EXPECTED_INTERVAL_MS = {
  // runFullCheckCron removed — CAD-S8 / issue #539; Go orchestrator owns scoring now.
  runImapPollCron:         15 * 60 * 1000,
  runWarmupAdvanceCron:    24 * 60 * 60 * 1000,
  runDailyReportCron:      24 * 60 * 60 * 1000,
  runMailboxHealthCycleCron: 30 * 60 * 1000,
  runCampaignWatchdogCron: 60 * 60 * 1000,
  runBounceFlipCron:       30 * 60 * 1000,
  runMailboxBounceThrottleCron: 15 * 60 * 1000,
  runMailboxHealingCron:   15 * 60 * 1000,
  runSyntheticSmokeCron:   60 * 1000,
  runGreylistRetryCron:    10 * 60 * 1000,
}

/**
 * Mount the BFF health surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 *   getProxyPool: () => Promise<unknown>,
 *   getProxyCache: () => unknown,
 *   aggregateProxyExhaust: (rows: unknown[]) => unknown,
 *   runConfigDrift: (deps: { pool: unknown, getProxyCache: () => unknown }) => Promise<unknown>,
 *   getLastStaleGuardRun: () => unknown,
 *   getLastConfigDrift: () => unknown,
 *   setLastConfigDrift: (v: unknown) => void,
 * }} deps
 */
export function mountHealthRoutes(app, deps) {
  const {
    pool,
    capture500,
    safeError,
    getProxyPool,
    getProxyCache,
    aggregateProxyExhaust,
    runConfigDrift,
    getLastStaleGuardRun,
    getLastConfigDrift,
    setLastConfigDrift,
  } = deps

  // I6 + M3 — /api/health/invariants returns latest invariant suite results +
  // most recent synthetic_runs row. Synthetic monitor watches this; failure
  // burn-rate alerts route here.
  app.get('/api/health/invariants', async (_req, res) => {
    try {
      let latestSynthetic = null
      try {
        const r = await pool.query(`
          SELECT id, ran_at, results, pass_count, fail_count, duration_ms
          FROM synthetic_runs
          WHERE suite = 'prod-smoke'
          ORDER BY ran_at DESC
          LIMIT 1
        `)
        latestSynthetic = r.rows[0] || null
      } catch (e) {
        // synthetic_runs may not exist yet (pre-M2 deploy)
      }

      const ageMin = latestSynthetic
        ? Math.round((Date.now() - new Date(latestSynthetic.ran_at).getTime()) / 60_000)
        : null

      res.json({
        ok: latestSynthetic ? latestSynthetic.fail_count === 0 : null,
        synthetic: latestSynthetic,
        synthetic_age_min: ageMin,
        stale: ageMin !== null && ageMin > 5,  // synthetic should run every 60s
        schema_check: { endpoint: '/api/__schema-check', see: 'separate fetch for hash diff' },
        generated_at: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/health/cron-heartbeats', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT cron_name, last_run_at, last_duration_ms, last_status, last_error
         FROM cron_heartbeats ORDER BY cron_name`,
      ).catch(() => ({ rows: [] }))
      const now = Date.now()
      const heartbeats = rows.map(r => {
        const expected = CRON_EXPECTED_INTERVAL_MS[r.cron_name] || null
        const ageMs = now - new Date(r.last_run_at).getTime()
        const stale = expected != null && ageMs > 2 * expected
        return { ...r, age_ms: ageMs, expected_interval_ms: expected, stale }
      })
      const stale = heartbeats.filter(h => h.stale).map(h => h.cron_name)
      res.json({
        ok: stale.length === 0,
        heartbeats,
        stale_crons: stale,
        generated_at: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  // A6 — Hallucination Score endpoint for /observability page.
  // Returns the latest test-quality score generated by
  // scripts/hallucination-score.mjs (run nightly + on-demand).
  app.get('/api/health/test-quality', async (_req, res) => {
    try {
      const fs = await import('node:fs')
      // HARDEN-1: anchor to module location, not process.cwd() — a malicious
      // working dir (e.g. attacker-writable container volume) could otherwise
      // serve arbitrary JSON disguised as the score.
      const file = new URL('../../hallucination-score.json', import.meta.url).pathname
      if (!fs.existsSync(file)) {
        return res.json({ ok: false, reason: 'no-score-yet', hint: 'run: node scripts/hallucination-score.mjs' })
      }
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      res.json({ ok: true, ...data })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── System health summary for dashboard alert banner ────────────
  // Merges proxy-pool + watchdog state into a single response so the
  // banner can decide between OK / degraded / alert in one fetch.
  app.get('/api/health/system', async (_req, res) => {
    const out = { proxy_pool_size: 0, proxy_pool_low: true, egress_mode: 'unknown', watchdog_stale: true, last_watchdog_at: null, alerts: [] }
    try {
      const pool_data = await getProxyPool().catch(() => null)
      if (pool_data) {
        out.egress_mode = pool_data.mode || 'unknown'
        out.proxy_pool_size = (pool_data.working || []).length
        // Mullvad-only: empty working set is healthy by design (single hop via wireproxy).
        out.proxy_pool_low = out.egress_mode === 'mullvad' ? false : out.proxy_pool_size < 3
      }
      if (out.proxy_pool_low) out.alerts.push({ level: 'warn', code: 'proxy_pool_low', message: `Proxy pool má jen ${out.proxy_pool_size} ověřených proxy.` })
    } catch {}
    try {
      const { rows } = await pool.query(
        `SELECT created_at FROM watchdog_events ORDER BY created_at DESC LIMIT 1`
      )
      if (rows.length) {
        out.last_watchdog_at = rows[0].created_at
        out.watchdog_stale = Date.now() - new Date(rows[0].created_at).getTime() > 15 * 60 * 1000
      }
      if (out.watchdog_stale) out.alerts.push({ level: 'err', code: 'watchdog_stale', message: 'Watchdog daemon > 15 min bez aktivity.' })
    } catch {}
    out.healthy = out.alerts.length === 0
    res.json(out)
  })

  // ── Global watchdog heartbeat: last heartbeat + counts last 24h ─────
  app.get('/api/health/watchdog', async (req, res) => {
    try {
      // Log access to operator_audit_log (per #867 audit finding)
      try {
        await pool.query(
          `INSERT INTO operator_audit_log(action, actor, entity_type, details)
           VALUES('watchdog_api_read', $1, 'watchdog', $2)`,
          [
            req.headers['x-api-key'] ? 'api-key' : 'unknown',
            JSON.stringify({ ip: req.ip, timestamp: new Date().toISOString() })
          ]
        )
      } catch (auditErr) {
        // Best-effort: don't block the endpoint if audit table doesn't exist
        if (!/relation .* does not exist/i.test(auditErr.message)) {
          console.error('[watchdog] audit log insert failed:', safeError(auditErr))
        }
      }

      const { rows: last } = await pool.query(
        `SELECT created_at FROM watchdog_events
         ORDER BY created_at DESC LIMIT 1`
      )
      const { rows: counts } = await pool.query(
        `SELECT event_type, COUNT(*)::int AS n
         FROM watchdog_events
         WHERE created_at > now() - interval '24 hours'
         GROUP BY event_type`
      )
      const byType = Object.fromEntries(counts.map(c => [c.event_type, c.n]))
      const lastAt = last[0]?.created_at || null
      const stale = lastAt ? (Date.now() - new Date(lastAt).getTime()) > 15 * 60 * 1000 : true
      res.json({
        last_event_at: lastAt,
        stale,
        counts_24h: byType,
        healthy: !stale,
      })
    } catch (e) {
      if (/relation .* does not exist/i.test(e.message)) {
        return res.json({ last_event_at: null, stale: true, counts_24h: {}, healthy: false })
      }
      return capture500(res, e, safeError)
    }
  })

  // SEND-S6.3: watchdog emits one auth_fail_alert event per mailbox when it
  // hits 3 SMTP AUTH failures inside a 15-minute window. Dashboard polls this
  // endpoint from <AuthFailAlertBanner/> to surface the condition to operators
  // during office hours (the log + webhook paths cover dev / off-hours).
  //
  // Contract:
  //   - AUTH_EXEMPT so the banner stays visible even if x-api-key rotates
  //   - last 24h window (covers the full work cycle)
  //   - INNER JOIN outreach_mailboxes so orphan rows from deleted mailboxes
  //     don't reach the UI as broken state
  //   - response never includes password / smtp_host / proxy_url (sanitized
  //     projection — only the four fields the banner renders)
  //   - missing watchdog_events table → { alerts: [], count: 0 } (graceful,
  //     keeps the banner dormant on a fresh env rather than flashing red)
  app.get('/api/health/auth-fail-alerts', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT w.mailbox_id,
                m.from_address,
                w.created_at,
                COALESCE((w.metadata->>'fail_count')::int, 0) AS fail_count
           FROM watchdog_events w
           JOIN outreach_mailboxes m ON m.id = w.mailbox_id
          WHERE w.event_type = 'auth_fail_alert'
            AND COALESCE(w.auto_healed, false) = false
            AND w.created_at > now() - interval '24 hours'
          ORDER BY w.created_at DESC
          LIMIT 500`
      )
      const alerts = rows.map((r) => ({
        mailbox_id:   r.mailbox_id,
        from_address: r.from_address,
        created_at:   r.created_at,
        fail_count:   Number(r.fail_count) || 0,
      }))
      res.json({ alerts, count: alerts.length })
    } catch (e) {
      // Fresh env or migration pending → dormant (not 500).
      if (/relation .* does not exist/i.test(e.message)) {
        return res.json({ alerts: [], count: 0 })
      }
      return capture500(res, e, safeError)
    }
  })

  // Triggered when proxyReassignGuard repeatedly exhausts the pool — means no
  // active mailbox can swap to a working proxy, so sends stall. Banner wants a
  // red state when ≥2 events land inside the 10-minute window.
  app.get('/api/health/proxy-exhaust', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT mailbox_id, message, reason, created_at
         FROM watchdog_events
         WHERE check_name = 'proxy_reassign_exhausted'
           AND created_at > now() - interval '10 minutes'
         ORDER BY created_at DESC
         LIMIT 500`
      )
      res.json(aggregateProxyExhaust(rows))
    } catch (e) {
      if (/relation .* does not exist/i.test(e.message)) {
        return res.json(aggregateProxyExhaust([]))
      }
      return capture500(res, e, safeError)
    }
  })

  app.get('/api/health/guards', (_req, res) => {
    res.json({ last_run: getLastStaleGuardRun() || null })
  })

  app.get('/api/health/drift', async (_req, res) => {
    try {
      const cached = getLastConfigDrift()
      if (!cached || Date.now() - new Date(cached.checked_at).getTime() > 5 * 60 * 1000) {
        const fresh = await runConfigDrift({ pool, getProxyCache })
        setLastConfigDrift(fresh)
        return res.json(fresh)
      }
      res.json(cached)
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── Pre-launch sanity checks for operator panel ─────────────────────
  // Returns structured checks (5 server-side + 8 placeholders) that the
  // dashboard PreflightPanel polls to show launch readiness.
  app.get('/api/launch-sanity', async (req, res) => {
    try {
      const campaignId = parseInt(req.query.campaign_id, 10)
      if (!Number.isFinite(campaignId) || campaignId <= 0) {
        return res.status(400).json({ error: 'Invalid campaign_id: must be a positive integer' })
      }

      const checks = []
      const ts = new Date().toISOString()

      // 1.1 Mailboxes Active Count
      try {
        const { rows: [mbRow] } = await pool.query(
          `SELECT COUNT(*)::int AS count FROM outreach_mailboxes WHERE status = 'active'`
        )
        const mbCount = mbRow?.count || 0
        checks.push({
          id: '1.1',
          axis: 'mailboxes',
          label: 'Active mailboxes',
          status: mbCount >= 4 ? 'green' : (mbCount >= 1 ? 'amber' : 'red'),
          value: `${mbCount}`,
          expected: '≥4',
        })
      } catch (e) {
        checks.push({
          id: '1.1',
          axis: 'mailboxes',
          label: 'Active mailboxes',
          status: 'unknown',
          value: 'error',
          expected: '≥4',
        })
      }

      // 1.2 Anti-trace relay ping (if table exists)
      try {
        const { rows } = await pool.query(`
          SELECT created_at FROM anti_trace_pings
          WHERE created_at > now() - interval '5 minutes'
          ORDER BY created_at DESC LIMIT 1
        `).catch(() => ({ rows: [] }))
        checks.push({
          id: '1.2',
          axis: 'relay',
          label: 'Relay healthy (recent ping)',
          status: rows.length > 0 ? 'green' : 'amber',
          value: rows.length > 0 ? 'yes' : 'no',
          expected: 'ping < 5 min',
        })
      } catch (e) {
        checks.push({
          id: '1.2',
          axis: 'relay',
          label: 'Relay healthy (recent ping)',
          status: 'unknown',
          value: 'table missing',
          expected: 'ping < 5 min',
        })
      }

      // 2.1 Campaign contacts eligible
      try {
        const { rows: [ccRow] } = await pool.query(`
          SELECT COUNT(*)::int AS count
          FROM campaign_contacts cc
          WHERE cc.campaign_id = $1
            AND (cc.status IS NULL OR cc.status IN ('pending', 'queued'))
        `, [campaignId])
        const ccCount = ccRow?.count || 0
        checks.push({
          id: '2.1',
          axis: 'contacts',
          label: 'Eligible contacts queued',
          status: ccCount > 0 ? 'green' : 'red',
          value: `${ccCount}`,
          expected: '>0',
        })
      } catch (e) {
        checks.push({
          id: '2.1',
          axis: 'contacts',
          label: 'Eligible contacts queued',
          status: 'unknown',
          value: 'error',
          expected: '>0',
        })
      }

      // 3.1 Template valid
      try {
        const { rows: [camp] } = await pool.query(
          `SELECT sequence_config FROM campaigns WHERE id = $1`,
          [campaignId]
        )
        let templateOk = false
        if (camp?.sequence_config) {
          const seq = Array.isArray(camp.sequence_config)
            ? camp.sequence_config
            : (camp.sequence_config?.steps || [])
          const templateName = seq[0]?.template
          if (templateName) {
            const templates = await pool.query(
              `SELECT id FROM email_templates WHERE name = $1
               LIMIT 1`,
              [templateName]
            )
            templateOk = templates.rows.length > 0
          }
        }
        checks.push({
          id: '3.1',
          axis: 'templates',
          label: 'Template configured + exists',
          status: templateOk ? 'green' : 'red',
          value: templateOk ? 'yes' : 'no',
          expected: 'valid template',
        })
      } catch (e) {
        checks.push({
          id: '3.1',
          axis: 'templates',
          label: 'Template configured + exists',
          status: 'unknown',
          value: 'error',
          expected: 'valid template',
        })
      }

      // 4.1 Last send event recent
      try {
        const { rows } = await pool.query(`
          SELECT created_at FROM send_events
          WHERE campaign_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `, [campaignId])
        const hasRecent = rows.length > 0 && (Date.now() - new Date(rows[0].created_at).getTime()) < 60 * 60 * 1000
        checks.push({
          id: '4.1',
          axis: 'sends',
          label: 'Recent send activity',
          status: hasRecent ? 'green' : 'amber',
          value: rows.length > 0 ? 'yes' : 'never',
          expected: 'recent < 1h',
        })
      } catch (e) {
        checks.push({
          id: '4.1',
          axis: 'sends',
          label: 'Recent send activity',
          status: 'unknown',
          value: 'error',
          expected: 'recent < 1h',
        })
      }

      // Placeholders (5–13) — operator runs by hand
      const placeholders = [
        { id: '1.3', axis: 'relay', label: 'Relay egress geolocation', expected: 'CZ or expected region' },
        { id: '2.2', axis: 'contacts', label: 'Contact email validity', expected: 'none invalid' },
        { id: '3.2', axis: 'templates', label: 'Template GDPR footer present', expected: 'footer + unsubscribe' },
        { id: '3.3', axis: 'templates', label: 'Template variable substitution', expected: 'no unresolved {{vars}}' },
        { id: '4.2', axis: 'sends', label: 'Drip sequence unlocked', expected: 'status != locked' },
        { id: '5.1', axis: 'db', label: 'Campaign write permission', expected: 'UPDATE works' },
        { id: '5.2', axis: 'db', label: 'Full schema validation', expected: 'schema-check clean' },
        { id: '5.3', axis: 'auth', label: 'API auth not expired', expected: 'X-API-Key valid' },
      ]
      for (const p of placeholders) {
        checks.push({
          ...p,
          status: 'unknown',
          value: '?',
        })
      }

      res.json({
        campaign_id: campaignId,
        ts,
        checks,
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })

  // /api/launch-readiness — consolidated pre-launch widget
  // Returns: { verdict, sections: { crm_coverage, dedup_guard, mailboxes, sanity_gates, recent_audit } }
  app.get('/api/launch-readiness', async (req, res) => {
    try {
      const campaignId = parseInt(req.query.campaign_id, 10)
      const segmentId = parseInt(req.query.segment_id, 10)

      if (!Number.isFinite(campaignId) || campaignId <= 0) {
        return res.status(400).json({ error: 'Invalid campaign_id' })
      }
      if (!Number.isFinite(segmentId) || segmentId <= 0) {
        return res.status(400).json({ error: 'Invalid segment_id' })
      }

      const sections = {}
      const actionItems = []

      // 1. CRM Coverage — per segment: total members / CRM-blocked via
      // companies.crm_client_id (8th dedup-guard axis blocks these). Real
      // table is segment_memberships (NOT segment_contacts — agent that
      // wrote PR #805 fabricated the table name; fix 2026-05-05).
      try {
        const { rows: [cov] } = await pool.query(`
          SELECT
            COUNT(*)::int AS total,
            SUM(CASE WHEN co.crm_client_id IS NOT NULL THEN 1 ELSE 0 END)::int AS blocked,
            SUM(CASE WHEN co.crm_client_id IS NULL THEN 1 ELSE 0 END)::int AS available
          FROM segment_memberships sm
          JOIN companies co ON co.id = sm.company_id
          WHERE sm.segment_id = $1
        `, [segmentId])

        const total = cov?.total || 0
        const blocked = cov?.blocked || 0
        const available = cov?.available || 0
        const blockedPct = total > 0 ? (blocked / total) * 100 : 0

        let trafficLight = 'green'
        if (blockedPct > 25) trafficLight = 'red'
        else if (blockedPct > 10) trafficLight = 'amber'

        sections.crm_coverage = {
          total,
          blocked,
          available,
          blocked_pct: Math.round(blockedPct * 10) / 10,
          traffic_light: trafficLight,
        }
        if (trafficLight !== 'green') {
          actionItems.push(`CRM coverage: ${blockedPct.toFixed(1)}% blocked`)
        }
      } catch (e) {
        sections.crm_coverage = { error: safeError(e) }
      }

      // 2. Dedup-guard sanity — verify migration 049 columns exist on
      // contacts (dnt + lifetime_touches + email_domain). Schema check is
      // more reliable than schema_migrations table (which agent that wrote
      // PR #805 referenced with fabricated migration_id format).
      try {
        const { rows: [mig] } = await pool.query(`
          SELECT
            EXISTS(SELECT 1 FROM information_schema.columns
                   WHERE table_name='contacts' AND column_name='dnt') AS dnt_col,
            EXISTS(SELECT 1 FROM information_schema.columns
                   WHERE table_name='contacts' AND column_name='lifetime_touches') AS touches_col
        `).catch(() => ({ rows: [] }))

        const { rows: [aud] } = await pool.query(`
          SELECT COUNT(*)::int AS count FROM operator_audit_log
          WHERE action IN ('migration_apply', 'crm_import', 'campaigns_segments_purge')
            AND created_at > now() - interval '7 days'
        `).catch(() => ({ rows: [] }))

        const migrated = mig?.dnt_col === true && mig?.touches_col === true
        const recentActivity = (aud?.count || 0) > 0

        sections.dedup_guard = {
          migration_applied: migrated,
          recent_activity_7d: recentActivity,
          operational: migrated && recentActivity ? true : false,
        }
        if (!migrated) actionItems.push('Dedup-guard: migration 049 not applied')
        if (!recentActivity && migrated) actionItems.push('Dedup-guard: no recent activity')
      } catch (e) {
        sections.dedup_guard = { error: safeError(e) }
      }

      // 3. Sender mailboxes — active / paused / bouncehold
      try {
        const { rows: [mbs] } = await pool.query(`
          SELECT
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::int AS active,
            SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END)::int AS paused,
            SUM(CASE WHEN status = 'bouncehold' THEN 1 ELSE 0 END)::int AS bouncehold
          FROM outreach_mailboxes
        `)

        sections.mailboxes = {
          active: mbs?.active || 0,
          paused: mbs?.paused || 0,
          bouncehold: mbs?.bouncehold || 0,
        }
        if ((mbs?.active || 0) === 0) {
          actionItems.push('Sender mailboxes: no active mailboxes')
        }
      } catch (e) {
        sections.mailboxes = { error: safeError(e) }
      }

      // 4. Launch sanity gates — reuse existing checks
      try {
        const { rows: [mbRow] } = await pool.query(
          `SELECT COUNT(*)::int AS count FROM outreach_mailboxes WHERE status = 'active'`
        )
        const mbCount = mbRow?.count || 0

        const { rows: [ccRow] } = await pool.query(`
          SELECT COUNT(*)::int AS count
          FROM campaign_contacts cc
          WHERE cc.campaign_id = $1
            AND (cc.status IS NULL OR cc.status IN ('pending', 'queued'))
        `, [campaignId])
        const ccCount = ccRow?.count || 0

        const { rows: [camp] } = await pool.query(
          `SELECT sequence_config FROM campaigns WHERE id = $1`,
          [campaignId]
        )
        let templateOk = false
        if (camp?.sequence_config) {
          const seq = Array.isArray(camp.sequence_config)
            ? camp.sequence_config
            : (camp.sequence_config?.steps || [])
          const templateName = seq[0]?.template
          if (templateName) {
            const { rows: templates } = await pool.query(
              `SELECT id FROM email_templates WHERE name = $1 LIMIT 1`,
              [templateName]
            )
            templateOk = templates.length > 0
          }
        }

        // Gate 4: relay_queue_health — anti-trace relay queue not stuck (>600s = fail)
        let relayQueuePass = false
        let relayQueueDetails = 'ANTI_TRACE_RELAY_URL not configured'
        const relayUrl = process.env.ANTI_TRACE_RELAY_URL || process.env.ANTI_TRACE_URL
        const relayToken = process.env.ANTI_TRACE_RELAY_TOKEN || process.env.ANTI_TRACE_TOKEN
        if (relayUrl && relayToken) {
          try {
            const relayRes = await fetch(`${relayUrl}/v1/status`, {
              headers: { Authorization: `Bearer ${relayToken}` },
              signal: AbortSignal.timeout(5_000),
            })
            if (!relayRes.ok) {
              relayQueueDetails = `relay status ${relayRes.status}`
            } else {
              const relayData = await relayRes.json()
              const queueDepth = relayData.queue_depth ?? relayData.pending_envelopes ?? 0
              const oldestAge = relayData.oldest_pending_age_seconds ?? -1
              const effectiveAge = oldestAge >= 0 ? oldestAge : 0
              relayQueuePass = effectiveAge < 600
              relayQueueDetails = `oldest_pending_age=${effectiveAge}s, depth=${queueDepth}`
            }
          } catch (relayErr) {
            relayQueueDetails = `relay fetch error: ${safeError(relayErr)}`
          }
        }

        // Gate 5: daemon_liveness — campaign daemon alive (audit log activity < 10 min)
        let daemonAlive = false
        let daemonDetails = 'no recent activity'
        try {
          const { rows: [daemonRow] } = await pool.query(`
            SELECT MAX(created_at) AS last_activity
            FROM operator_audit_log
            WHERE (action LIKE 'campaign_%' OR actor = 'campaign-daemon')
          `)
          const lastActivity = daemonRow?.last_activity
          if (lastActivity) {
            const ageSeconds = (Date.now() - new Date(lastActivity).getTime()) / 1000
            daemonAlive = ageSeconds < 600
            daemonDetails = `last_activity=${Math.round(ageSeconds)}s ago`
          }
        } catch (daemonErr) {
          daemonDetails = `db error: ${safeError(daemonErr)}`
        }

        // Gate 6: deploy_sha — local HEAD SHA known
        const deploySha = process.env.GIT_SHA
          || process.env.RAILWAY_GIT_COMMIT_SHA
          || process.env.SOURCE_COMMIT
          || null
        const deployShaDefined = deploySha !== null && deploySha.length > 0
        const deployDetails = deployShaDefined ? `sha=${deploySha.slice(0, 12)}` : 'GIT_SHA not set'

        // Gate 7: template_drift — DB email_templates body matches .tmpl file (DB-only OK)
        let templateDriftPass = true
        let templateDriftDetails = 'no template in sequence'
        if (camp?.sequence_config) {
          const driftSeq = Array.isArray(camp.sequence_config)
            ? camp.sequence_config
            : (camp.sequence_config?.steps || [])
          const driftTemplateName = driftSeq[0]?.template
          if (driftTemplateName) {
            try {
              const { rows: [tmplRow] } = await pool.query(
                `SELECT body FROM email_templates WHERE name = $1 LIMIT 1`,
                [driftTemplateName]
              )
              if (!tmplRow) {
                templateDriftPass = false
                templateDriftDetails = `template '${driftTemplateName}' not in DB`
              } else {
                const fs = await import('node:fs/promises')
                const path = await import('node:path')
                const tmplPath = path.resolve(
                  new URL('../../../../..', import.meta.url).pathname,
                  'modules/outreach/configs/templates',
                  `${driftTemplateName}.tmpl`
                )
                let fileBody = null
                try {
                  fileBody = await fs.readFile(tmplPath, 'utf8')
                } catch {
                  // File not present → DB-only mode, treat as pass
                  templateDriftDetails = 'no .tmpl file (DB-only mode)'
                }
                if (fileBody !== null) {
                  templateDriftPass = fileBody.trim() === tmplRow.body.trim()
                  templateDriftDetails = templateDriftPass
                    ? 'DB body matches file'
                    : 'drift: DB and .tmpl file differ'
                }
              }
            } catch (driftErr) {
              templateDriftDetails = `check error: ${safeError(driftErr)}`
              templateDriftPass = false
            }
          }
        }

        const gates = [
          { id: 'mailboxes', pass: mbCount >= 4, label: `Active mailboxes (${mbCount})` },
          { id: 'contacts', pass: ccCount > 0, label: `Eligible contacts (${ccCount})` },
          { id: 'template', pass: templateOk, label: 'Template valid' },
          { id: 'relay_queue_health', pass: relayQueuePass, label: 'Anti-trace relay queue', details: relayQueueDetails },
          { id: 'daemon_liveness', pass: daemonAlive, label: 'Campaign daemon liveness', details: daemonDetails },
          { id: 'deploy_sha', pass: deployShaDefined, label: 'Deploy SHA fingerprint', details: deployDetails },
          { id: 'template_drift', pass: templateDriftPass, label: 'Template DB↔file drift', details: templateDriftDetails },
        ]

        const passCount = gates.filter(g => g.pass).length
        sections.sanity_gates = {
          total: gates.length,
          pass_count: passCount,
          gates,
        }
        if (passCount < gates.length) {
          gates.filter(g => !g.pass).forEach(g => {
            actionItems.push(`Gate: ${g.label}`)
          })
        }
      } catch (e) {
        sections.sanity_gates = { error: safeError(e) }
      }

      // 5. Recent operator audit — last 24h events
      try {
        const { rows } = await pool.query(`
          SELECT action, created_at, actor
          FROM operator_audit_log
          WHERE action IN ('crm_import', 'campaign_activate', 'campaign_rollback', 'migration_apply', 'campaigns_segments_purge')
            AND created_at > now() - interval '24 hours'
          ORDER BY created_at DESC
          LIMIT 10
        `)
        sections.recent_audit = {
          events: rows.map(r => ({
            action: r.action,
            timestamp: r.created_at,
          })),
          count_24h: rows.length,
        }
      } catch (e) {
        sections.recent_audit = { error: safeError(e) }
      }

      // Compute verdict
      let verdict = 'green'
      if (actionItems.length > 0) {
        const hasRed = sections.crm_coverage?.traffic_light === 'red' ||
                       !sections.mailboxes?.active ||
                       sections.sanity_gates?.pass_count < sections.sanity_gates?.total
        verdict = hasRed ? 'red' : 'amber'
      }

      res.json({
        campaign_id: campaignId,
        segment_id: segmentId,
        verdict,
        sections,
        action_items: actionItems,
        timestamp: new Date().toISOString(),
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}
