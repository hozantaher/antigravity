// campaignDryRun.js — Sprint K2
//
// POST /api/campaigns/:id/dry-run
//
// SELECT-only enrollment preview — shows operators what would actually land
// in campaign_contacts if they clicked "Spustit" right now. Runs the same
// pipeline as the Go enrollContacts logic but as pure COUNTs, not INSERTs.
//
// Pipeline (4 steps, waterfall):
//   Step 1 — contacts matching the campaign's segment_definition filter
//   Step 2 — minus suppressed emails (outreach_suppressions UNION suppression_list)
//   Step 3 — minus dedup_guard 8 axes (cross-campaign cooldown, per-domain
//             cooldown, lifetime_exhausted, crm_active_client, dnt, etc.)
//   Step 4 — minus contacts already enrolled in this campaign with a non-
//             terminal status (status NOT IN ('terminal_done', 'unsubscribed'))
//
// PII guard: never emit email addresses in the response body.
// No audit log needed: this is SELECT-only, no state changes.
//
// Cooldown constants (feedback_no_magic_thresholds — T0):
//   CROSS_CAMPAIGN_COOLDOWN_DAYS = 90  (same as DefaultDedupGuardConfig.CrossCampaignCooldown)
//   PER_DOMAIN_COOLDOWN_DAYS     = 180 (same as DefaultDedupGuardConfig.PerDomainCooldown)
//   LIFETIME_MAX_TOUCHES         = 3   (same as DefaultDedupGuardConfig.LifetimeMaxTouches)
//   BOUNCE_CLUSTER_THRESHOLD     = 0.30
//   BOUNCE_CLUSTER_WINDOW_DAYS   = 30
//   ENGAGEMENT_DECAY_MIN_SENDS   = 3
//   ENGAGEMENT_DECAY_WINDOW_DAYS = 365
//
// Freemail domains (cross-ref dedup_guard.go knownFreemailDomainsForDedup):
//   per-domain cooldown is SKIPPED for known freemail providers because
//   boss@gmail.com does not block asistentka@gmail.com.

// Named constants — operator-tunable via operator_settings in the future
// but hardcoded here to match DefaultDedupGuardConfig in dedup_guard.go.
// HARD RULE feedback_no_magic_thresholds: no literals inside SQL — use these.
const CROSS_CAMPAIGN_COOLDOWN_DAYS = 90
const PER_DOMAIN_COOLDOWN_DAYS = 180
const LIFETIME_MAX_TOUCHES = 3
const BOUNCE_CLUSTER_THRESHOLD = 0.30
const BOUNCE_CLUSTER_WINDOW_DAYS = 30
const ENGAGEMENT_DECAY_MIN_SENDS = 3
const ENGAGEMENT_DECAY_WINDOW_DAYS = 365

// Freemail domains that bypass per-domain cooldown.
// Source: services/campaigns/sender/dedup_guard.go knownFreemailDomainsForDedup
const FREEMAIL_DOMAINS = [
  'seznam.cz','email.cz','centrum.cz','volny.cz','tiscali.cz','post.cz',
  'atlas.cz','quick.cz','iol.cz','azet.cz','wo.cz','in.cz','mybox.cz','klikni.cz',
  'azet.sk','centrum.sk','pobox.sk','post.sk','zoznam.sk','atlas.sk',
  'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com',
  'outlook.cz','hotmail.cz','yahoo.com','yahoo.co.uk','yahoo.de',
  'icloud.com','me.com','mac.com','protonmail.com','proton.me','pm.me',
  'tutanota.com','tuta.io','zoho.com','yandex.com','mail.ru',
  'aol.com','gmx.com','gmx.de','gmx.net',
]

/**
 * Build segment WHERE clause from segment_definition JSONB.
 * segment_definition is a JSON object with optional keys:
 *   category_paths: string[] — contacts must have category matching one of these
 *   region: string           — contacts.region
 *   min_employees: number    — contacts.employees >= N
 *   custom_sql: string       — raw extra WHERE (trusted operator input — must be
 *                              scrubbed; we only allow it when segment came from
 *                              the segment builder, not from raw user input here)
 *
 * Returns { where: string, params: any[], nextParamIndex: number }
 */
function buildSegmentWhere(segDef, startIdx = 1) {
  const clauses = ['c.status IS DISTINCT FROM \'suppressed\'']
  const params = []
  let idx = startIdx

  if (!segDef || typeof segDef !== 'object') {
    return { where: clauses.join(' AND '), params, nextParamIndex: idx }
  }

  if (Array.isArray(segDef.category_paths) && segDef.category_paths.length > 0) {
    // Campaign category_paths are PREFIXES; contacts.category_path is a leaf
    // node. Enrollment (campaignSegmentExpansion.js INSERT + runner
    // enrollContacts) matches `c.category_path LIKE p || '%'`, so an exact
    // `IN (...)` matched (almost) nothing here and the dry-run under-counted
    // to ~0. Mirror the prefix match so the preview matches real enrollment.
    const likes = segDef.category_paths.map(() => `c.category_path LIKE $${idx++} || '%'`).join(' OR ')
    clauses.push(`(${likes})`)
    params.push(...segDef.category_paths)
  }

  if (typeof segDef.region === 'string' && segDef.region.trim()) {
    clauses.push(`c.region = $${idx++}`)
    params.push(segDef.region.trim())
  }

  if (typeof segDef.min_employees === 'number' && segDef.min_employees > 0) {
    clauses.push(`c.employees >= $${idx++}`)
    params.push(segDef.min_employees)
  }

  return { where: clauses.join(' AND '), params, nextParamIndex: idx }
}

export function mountCampaignDryRunRoutes(app, deps) {
  const { pool, capture500, safeError } = deps

  /**
   * POST /api/campaigns/:id/dry-run
   *
   * Returns:
   * {
   *   total_match:        number,  // Step 1 — contacts matching segment
   *   after_suppression:  number,  // Step 2 — minus suppressed
   *   after_dedup:        number,  // Step 3 — minus dedup-blocked
   *   eligible:           number,  // Step 4 — minus already enrolled
   *   steps: [
   *     { label: string, count: number, removed: number },
   *     ...
   *   ]
   * }
   *
   * 404 if campaign not found.
   * No PII (emails) in response.
   */
  app.post('/api/campaigns/:id/dry-run', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id, 10)
      if (!Number.isFinite(campaignId)) {
        return res.status(400).json({ error: 'invalid campaign id' })
      }

      // Load campaign — `category_paths` is TEXT containing a JSON-encoded
      // array (legacy serialization quirk). Parse to JS array first.
      const { rows: campRows } = await pool.query(
        `SELECT id, category_paths FROM campaigns WHERE id = $1`,
        [campaignId],
      )
      if (campRows.length === 0) {
        return res.status(404).json({ error: 'campaign not found' })
      }

      const campaign = campRows[0]
      let categoryPaths = []
      if (typeof campaign.category_paths === 'string' && campaign.category_paths.trim().startsWith('[')) {
        try { categoryPaths = JSON.parse(campaign.category_paths) } catch { categoryPaths = [] }
      } else if (Array.isArray(campaign.category_paths)) {
        categoryPaths = campaign.category_paths
      }
      const segDef = { category_paths: categoryPaths }
      const { where: segWhere, params: segParams, nextParamIndex } = buildSegmentWhere(segDef, 1)

      // ── Step 1: contacts matching segment filter ──────────────────────
      const { rows: s1Rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM contacts c WHERE ${segWhere}`,
        segParams,
      )
      const totalMatch = s1Rows[0].n

      // ── Step 2: minus suppressed ──────────────────────────────────────
      // Both suppression tables (cross-ref project_two_suppression_tables)
      const s2Sql = `
        SELECT COUNT(*)::int AS n
        FROM contacts c
        WHERE ${segWhere}
          AND NOT EXISTS (
            SELECT 1
            FROM (
              SELECT lower(trim(email)) AS email FROM outreach_suppressions WHERE email IS NOT NULL
              UNION
              SELECT lower(trim(email)) AS email FROM suppression_list      WHERE email IS NOT NULL
            ) sup
            WHERE sup.email = lower(trim(c.email))
          )
      `
      const { rows: s2Rows } = await pool.query(s2Sql, segParams)
      const afterSuppression = s2Rows[0].n

      // ── Step 3: minus dedup-blocked ───────────────────────────────────
      // Mirrors dedup_guard.go CheckEligibility axes — applied as aggregate
      // SQL filter. We use named constants for all thresholds.
      //
      // Axes mirrored:
      //   1. dnt = true                             (hard skip)
      //   2. lifetime_touches >= LIFETIME_MAX_TOUCHES
      //   3. cross-campaign cooldown (any campaign touched in last N days)
      //   4. per-domain cooldown (another contact on same corporate domain
      //      touched in last N days — skipped for freemail domains)
      //   5. bounce cluster (IČO bounce rate > threshold in window)
      //   6. crm_active_client (crm_client_id IS NOT NULL AND client active)
      //
      // Axes NOT mirrored (require per-contact evaluation not possible in
      // aggregate SQL without per-row subqueries that are too expensive):
      //   7. region_rate_limit (rolling 1h rate per kraj — irrelevant for
      //      pre-enrollment count; rate is reset between ticks)
      //   8. engagement_decay (complex per-mailbox signal — approximated by
      //      the engagement_decay_blocked column if present)
      //
      // The count is an approximation — actual enrollment may differ by a
      // small margin due to axes 7+8. Label makes this clear.
      // Param ordering: segParams (1..nextParamIndex-1), then FREEMAIL_DOMAINS
      // (nextParamIndex..nextParamIndex+freemail-1), then constants.
      // freemailPlaceholders is built first so its indices match the array
      // position in dedupParamsOrdered.
      const freemailPlaceholders = FREEMAIL_DOMAINS.map((_, i) => `$${nextParamIndex + i}`).join(', ')

      const pidxCampaignId        = nextParamIndex + FREEMAIL_DOMAINS.length
      const pidxLifetimeMax       = pidxCampaignId + 1
      const pidxCrossCooldown     = pidxLifetimeMax + 1
      const pidxDomainCooldown    = pidxCrossCooldown + 1
      const pidxBounceThreshold   = pidxDomainCooldown + 1
      const pidxBounceWindow      = pidxBounceThreshold + 1

      const dedupParamsOrdered = [
        ...segParams,
        ...FREEMAIL_DOMAINS,
        campaignId,
        LIFETIME_MAX_TOUCHES,
        CROSS_CAMPAIGN_COOLDOWN_DAYS,
        PER_DOMAIN_COOLDOWN_DAYS,
        BOUNCE_CLUSTER_THRESHOLD,
        BOUNCE_CLUSTER_WINDOW_DAYS,
      ]

      // PERF FIX (issue #1307): axes 4 (per-domain cooldown) + 5 (IČO
      // bounce cluster) used to run per-row subqueries → O(n²) on 426k
      // contacts (>30s timeout). Materialize both once as CTEs:
      //   busy_corp_domains — distinct non-freemail domains touched in window
      //   ico_bounce_rates  — per-IČO bounce_rate from same window
      // Lookups against these CTEs are hash joins (O(n + m)) instead of
      // nested-loop per row.
      const s3Sql = `
        WITH busy_corp_domains AS (
          SELECT DISTINCT split_part(lower(c2.email), '@', 2) AS domain
          FROM contacts c2
          JOIN send_events se2 ON se2.contact_id = c2.id
          WHERE se2.sent_at > now() - ($${pidxDomainCooldown} || ' days')::interval
            AND c2.email IS NOT NULL
            AND c2.email LIKE '%@%'
            AND split_part(lower(c2.email), '@', 2) NOT IN (${freemailPlaceholders})
        ),
        ico_bounce_rates AS (
          SELECT
            c3.parent_ico,
            COALESCE(
              SUM(CASE WHEN se.status = 'bounced' THEN 1 ELSE 0 END)::float /
              NULLIF(COUNT(*), 0), 0
            ) AS bounce_rate
          FROM send_events se
          JOIN contacts c3 ON c3.id = se.contact_id
          WHERE se.sent_at > now() - ($${pidxBounceWindow} || ' days')::interval
            AND c3.parent_ico IS NOT NULL
          GROUP BY c3.parent_ico
        )
        SELECT COUNT(*)::int AS n
        FROM contacts c
        LEFT JOIN ico_bounce_rates br ON br.parent_ico = c.parent_ico
        WHERE ${segWhere}
          -- Step 2 suppression gate (re-applied so S3 is a subset of S2)
          AND NOT EXISTS (
            SELECT 1
            FROM (
              SELECT lower(trim(email)) AS email FROM outreach_suppressions WHERE email IS NOT NULL
              UNION
              SELECT lower(trim(email)) AS email FROM suppression_list      WHERE email IS NOT NULL
            ) sup
            WHERE sup.email = lower(trim(c.email))
          )
          -- Axis 1: dnt
          AND (c.dnt IS NULL OR c.dnt = false)
          -- Axis 2: lifetime_exhausted
          AND (c.lifetime_touches IS NULL OR c.lifetime_touches < $${pidxLifetimeMax})
          -- Axis 3: cross-campaign cooldown — touched by any campaign in last N days
          AND NOT EXISTS (
            SELECT 1 FROM send_events se
            WHERE se.contact_id = c.id
              AND se.campaign_id != $${pidxCampaignId}
              AND se.sent_at > now() - ($${pidxCrossCooldown} || ' days')::interval
          )
          -- Axis 4: per-domain cooldown — freemail bypass OR domain NOT in busy set
          AND (
            split_part(lower(c.email), '@', 2) IN (${freemailPlaceholders})
            OR split_part(lower(c.email), '@', 2) NOT IN (SELECT domain FROM busy_corp_domains)
          )
          -- Axis 5: bounce cluster (IČO level) — lookup materialized rate
          AND (
            c.parent_ico IS NULL
            OR COALESCE(br.bounce_rate, 0) < $${pidxBounceThreshold}
          )
          -- Axis 6: crm_active_client — skip if contact is an active CRM client
          AND (c.crm_client_id IS NULL)
      `

      const { rows: s3Rows } = await pool.query(s3Sql, dedupParamsOrdered)
      const afterDedup = s3Rows[0].n

      // ── Step 4: minus already enrolled (non-terminal) ────────────────
      // Same dedup CTEs as S3 (per #1307 perf fix) + campaign_contacts NOT EXISTS.
      const s4Sql = `
        WITH busy_corp_domains AS (
          SELECT DISTINCT split_part(lower(c2.email), '@', 2) AS domain
          FROM contacts c2
          JOIN send_events se2 ON se2.contact_id = c2.id
          WHERE se2.sent_at > now() - ($${pidxDomainCooldown} || ' days')::interval
            AND c2.email IS NOT NULL
            AND c2.email LIKE '%@%'
            AND split_part(lower(c2.email), '@', 2) NOT IN (${freemailPlaceholders})
        ),
        ico_bounce_rates AS (
          SELECT
            c3.parent_ico,
            COALESCE(
              SUM(CASE WHEN se.status = 'bounced' THEN 1 ELSE 0 END)::float /
              NULLIF(COUNT(*), 0), 0
            ) AS bounce_rate
          FROM send_events se
          JOIN contacts c3 ON c3.id = se.contact_id
          WHERE se.sent_at > now() - ($${pidxBounceWindow} || ' days')::interval
            AND c3.parent_ico IS NOT NULL
          GROUP BY c3.parent_ico
        )
        SELECT COUNT(*)::int AS n
        FROM contacts c
        LEFT JOIN ico_bounce_rates br ON br.parent_ico = c.parent_ico
        WHERE ${segWhere}
          AND NOT EXISTS (
            SELECT 1
            FROM (
              SELECT lower(trim(email)) AS email FROM outreach_suppressions WHERE email IS NOT NULL
              UNION
              SELECT lower(trim(email)) AS email FROM suppression_list      WHERE email IS NOT NULL
            ) sup
            WHERE sup.email = lower(trim(c.email))
          )
          AND (c.dnt IS NULL OR c.dnt = false)
          AND (c.lifetime_touches IS NULL OR c.lifetime_touches < $${pidxLifetimeMax})
          AND NOT EXISTS (
            SELECT 1 FROM send_events se
            WHERE se.contact_id = c.id
              AND se.campaign_id != $${pidxCampaignId}
              AND se.sent_at > now() - ($${pidxCrossCooldown} || ' days')::interval
          )
          AND (
            split_part(lower(c.email), '@', 2) IN (${freemailPlaceholders})
            OR split_part(lower(c.email), '@', 2) NOT IN (SELECT domain FROM busy_corp_domains)
          )
          AND (
            c.parent_ico IS NULL
            OR COALESCE(br.bounce_rate, 0) < $${pidxBounceThreshold}
          )
          AND (c.crm_client_id IS NULL)
          -- Step 4: exclude already enrolled in this campaign (non-terminal)
          AND NOT EXISTS (
            SELECT 1 FROM campaign_contacts cc
            WHERE cc.contact_id = c.id
              AND cc.campaign_id = $${pidxCampaignId}
              AND cc.status NOT IN ('terminal_done', 'unsubscribed')
          )
      `

      const { rows: s4Rows } = await pool.query(s4Sql, dedupParamsOrdered)
      const eligible = s4Rows[0].n

      res.json({
        total_match: totalMatch,
        after_suppression: afterSuppression,
        after_dedup: afterDedup,
        eligible,
        steps: [
          {
            label: 'Kontakty odpovídající filtru segmentu',
            count: totalMatch,
            removed: 0,
          },
          {
            label: 'Po odfiltrování potlačených adres',
            count: afterSuppression,
            removed: totalMatch - afterSuppression,
          },
          {
            label: 'Po odfiltrování dedup pravidly (přibližně)',
            count: afterDedup,
            removed: afterSuppression - afterDedup,
          },
          {
            label: 'Způsobilé k zařazení (bez již enrolled)',
            count: eligible,
            removed: afterDedup - eligible,
          },
        ],
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}
