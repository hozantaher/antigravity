// Campaign Segment Expansion — AJ10b (closes #1398)
// ─────────────────────────────────────────────────────────────────────────────
// Surface the psql round-trip that operator forced on 2026-05-15 to add 5
// category paths + 8,794 fresh enrollments to campaign 457. Replaces the
// raw `UPDATE campaigns SET category_paths = ... || ...; INSERT INTO
// campaign_contacts ...; INSERT INTO operator_audit_log ...` flow with a
// single audited endpoint.
//
// Routes:
//   POST /api/campaigns/:id/expand-segments
//     Body: {
//       added_paths:   string[],          // new category_path prefixes to ADD
//       removed_paths: string[],          // existing prefixes to REMOVE
//       reason:        string,            // operator-supplied note (audit)
//       dry_run?:      boolean            // when true, return preview only
//     }
//     Headers (mutation path only):
//       X-Confirm-Send: yes               // matches existing campaign-send gates
//     Returns:
//       { campaign_id, added, removed, new_enrollments, dry_run, ... }
//
// Semantics:
//   - Dry-run: counts contacts that *would* be newly enrolled (added paths,
//     minus those already enrolled, minus suppressed). Does not touch DB.
//   - Commit: single transaction —
//       1. UPDATE campaigns.category_paths = (current - removed) + added
//       2. INSERT INTO campaign_contacts for new matches (ON CONFLICT NOTHING)
//       3. INSERT INTO operator_audit_log (action='campaign_segment_expansion')
//
// HARD RULES enforced:
//   feedback_audit_log_on_mutations — audit row INSIDE the same tx as UPDATE.
//   feedback_campaign_send          — X-Confirm-Send: yes required for mutation.
//   feedback_schema_verify_before_sql — schema verified 2026-05-16 via psql:
//                                       campaigns.category_paths TEXT (JSON string),
//                                       campaign_contacts (campaign_id, contact_id,
//                                         status, current_step, next_send_at, …),
//                                       outreach_suppressions (email, domain),
//                                       contacts (id, status, category_path, email),
//                                       operator_audit_log (action, actor,
//                                         entity_type, entity_id::bigint, details::jsonb).
//   feedback_no_speculation         — uses existing precedent from
//                                       /api/campaigns/:id/segment/apply
//                                       (category-tree route surface) and from
//                                       2026-05-15 audit row #63456.

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse campaigns.category_paths (stored as TEXT containing a JSON-encoded
 * array). Returns [] for null / empty / malformed.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseCategoryPaths(raw) {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.filter(p => typeof p === 'string')
  if (typeof raw !== 'string') return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  // JSON array form (the canonical storage shape).
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : []
    } catch { return [] }
  }
  // Postgres text[] literal fallback ({a,b,c}) — defensive only.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
  }
  return []
}

/**
 * Validate + normalize string-array input. Returns null on type error,
 * otherwise the deduped trimmed list (empty list OK).
 *
 * @param {unknown} v
 * @returns {string[] | null}
 */
function asStringArray(v) {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return null
  const out = []
  const seen = new Set()
  for (const item of v) {
    if (typeof item !== 'string') return null
    const t = item.trim()
    if (!t) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * Mount the campaign segment-expansion route on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountCampaignSegmentExpansionRoutes(app, { pool, capture500, safeError }) {

  // ── POST /api/campaigns/:id/expand-segments ────────────────────────────────
  app.post('/api/campaigns/:id/expand-segments', async (req, res) => {
    const campaignId = parseInt(req.params.id, 10)
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: 'invalid campaign id' })
    }

    const body = req.body ?? {}
    const dryRun = body.dry_run === true

    // ── Input validation ─────────────────────────────────────────────────────
    const addedPaths   = asStringArray(body.added_paths)
    const removedPaths = asStringArray(body.removed_paths)
    if (addedPaths === null) {
      return res.status(400).json({ error: 'added_paths must be string[]' })
    }
    if (removedPaths === null) {
      return res.status(400).json({ error: 'removed_paths must be string[]' })
    }
    if (addedPaths.length === 0 && removedPaths.length === 0) {
      return res.status(400).json({ error: 'no_changes', message: 'added_paths and removed_paths are both empty' })
    }

    const reasonRaw = body.reason
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : ''
    if (!dryRun && !reason) {
      // reason mandatory on the mutation path so the audit row has context.
      return res.status(400).json({ error: 'reason_required', message: 'reason must be a non-empty string for mutation path' })
    }

    // ── X-Confirm-Send gate (mutation only) ──────────────────────────────────
    if (!dryRun) {
      const confirmHeader = req.headers['x-confirm-send']
      if (confirmHeader !== 'yes') {
        return res.status(412).json({
          error: 'missing_confirm_header',
          message: 'X-Confirm-Send: yes header required for mutation path',
        })
      }
    }

    // ── Load campaign + current category_paths ───────────────────────────────
    const { rows: campRows } = await pool.query(
      `SELECT id, name, category_paths FROM campaigns WHERE id = $1`,
      [campaignId],
    ).catch(e => { throw e })

    if (!campRows.length) {
      return res.status(404).json({ error: 'campaign not found' })
    }
    const currentPaths = parseCategoryPaths(campRows[0].category_paths)

    // Compute desired new paths (current − removed + added, deduped).
    const removedSet = new Set(removedPaths)
    const addedSet   = new Set(addedPaths)
    const nextPaths = []
    const seen = new Set()
    for (const p of currentPaths) {
      if (removedSet.has(p)) continue
      if (!seen.has(p)) { seen.add(p); nextPaths.push(p) }
    }
    for (const p of addedPaths) {
      if (!seen.has(p)) { seen.add(p); nextPaths.push(p) }
    }

    // Genuinely new paths (not already in current set). Removed paths that
    // weren't actually present collapse to no-ops silently.
    const actuallyAdded = addedPaths.filter(p => !currentPaths.includes(p))
    const actuallyRemoved = removedPaths.filter(p => currentPaths.includes(p))

    // ── Dry-run path: count would-be enrollments without mutating ────────────
    if (dryRun) {
      let newEnrollments = 0
      if (actuallyAdded.length > 0) {
        // Use prefix-match (LIKE 'path%') — same semantics as runner
        // enrollContacts() and existing category-tree apply endpoint.
        // Suppression filter mirrors runner: exclude any contact whose email
        // exists in EITHER suppression table (outreach_suppressions UNION
        // suppression_list — see lib/suppressionFilter.js for why both are
        // required; querying one silently leaks the other half).
        const params = [campaignId, actuallyAdded]
        const { rows } = await pool.query(
          `
          WITH added AS (
            SELECT unnest($2::text[]) AS p
          ),
          candidates AS (
            SELECT DISTINCT c.id, c.email
              FROM contacts c
              JOIN added a ON c.category_path LIKE a.p || '%'
             WHERE c.status = 'valid'
               AND c.email IS NOT NULL
               AND c.email <> ''
               AND NOT EXISTS (
                 SELECT 1 FROM campaign_contacts cc
                  WHERE cc.campaign_id = $1
                    AND cc.contact_id  = c.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM (
                   SELECT LOWER(TRIM(email)) AS email FROM outreach_suppressions WHERE email IS NOT NULL
                   UNION
                   SELECT LOWER(TRIM(email)) AS email FROM suppression_list      WHERE email IS NOT NULL
                 ) sup
                  WHERE sup.email = LOWER(TRIM(c.email))
               )
          )
          SELECT COUNT(*)::int AS cnt FROM candidates
          `,
          params,
        ).catch(e => { throw e })
        newEnrollments = rows[0]?.cnt ?? 0
      }
      return res.json({
        ok: true,
        dry_run: true,
        campaign_id: campaignId,
        current_paths: currentPaths,
        next_paths: nextPaths,
        added: actuallyAdded.length,
        removed: actuallyRemoved.length,
        new_enrollments: newEnrollments,
        added_paths: actuallyAdded,
        removed_paths: actuallyRemoved,
      })
    }

    // ── Mutation path ────────────────────────────────────────────────────────
    const operator =
      (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
      (req.user && req.user.email) ||
      'operator_segment_expansion_ui'

    let client
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      // 1. Persist new category_paths (JSON-encoded string per existing schema).
      await client.query(
        `UPDATE campaigns SET category_paths = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(nextPaths), campaignId],
      )

      // 2. INSERT campaign_contacts for added paths.
      //    Mirrors runner.enrollContacts() semantics + segment/apply behavior:
      //      - contacts.status = 'valid'
      //      - prefix-match category_path
      //      - DISTINCT contact_id (a contact whose leaf path matches >1 nested
      //        added prefix fans out one JOIN row per prefix — without DISTINCT
      //        it would be enrolled multiple times; campaign_contacts has no
      //        unique index so ON CONFLICT can't dedupe it either)
      //      - skip already-enrolled (NOT EXISTS — no unique index)
      //      - skip suppressed contacts in EITHER table (outreach_suppressions
      //        UNION suppression_list)
      //    Insert with status='pending', current_step=0, next_send_at=NOW().
      let newEnrollments = 0
      if (actuallyAdded.length > 0) {
        const { rows: enrolled } = await client.query(
          `
          WITH added AS (
            SELECT unnest($2::text[]) AS p
          ),
          candidates AS (
            SELECT DISTINCT c.id AS contact_id, c.category_path
              FROM contacts c
              JOIN added a ON c.category_path LIKE a.p || '%'
             WHERE c.status = 'valid'
               AND c.email IS NOT NULL
               AND c.email <> ''
               AND NOT EXISTS (
                 SELECT 1 FROM campaign_contacts cc
                  WHERE cc.campaign_id = $1
                    AND cc.contact_id  = c.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM (
                   SELECT LOWER(TRIM(email)) AS email FROM outreach_suppressions WHERE email IS NOT NULL
                   UNION
                   SELECT LOWER(TRIM(email)) AS email FROM suppression_list      WHERE email IS NOT NULL
                 ) sup
                  WHERE sup.email = LOWER(TRIM(c.email))
               )
          )
          INSERT INTO campaign_contacts (campaign_id, contact_id, status, current_step, next_send_at, priority)
          SELECT $1, cand.contact_id, 'pending', 0, NOW(), compute_machinery_score(cand.category_path)
            FROM candidates cand
          RETURNING id
          `,
          [campaignId, actuallyAdded],
        )
        newEnrollments = enrolled.length
      }

      // 3. Audit row IN SAME TX — feedback_audit_log_on_mutations.
      //    Schema verified: operator_audit_log (action, actor, entity_type,
      //    entity_id BIGINT, details JSONB, created_at).
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('campaign_segment_expansion', $1, 'campaign', $2, $3::jsonb)`,
        [
          operator,
          campaignId,
          JSON.stringify({
            campaign_id:      campaignId,
            campaign_name:    campRows[0].name ?? null,
            added_paths:      actuallyAdded,
            removed_paths:    actuallyRemoved,
            new_enrollments:  newEnrollments,
            previous_count:   currentPaths.length,
            next_count:       nextPaths.length,
            reason,
          }),
        ],
      )

      await client.query('COMMIT')

      return res.json({
        ok: true,
        dry_run: false,
        campaign_id: campaignId,
        current_paths: currentPaths,
        next_paths: nextPaths,
        added: actuallyAdded.length,
        removed: actuallyRemoved.length,
        new_enrollments: newEnrollments,
        added_paths: actuallyAdded,
        removed_paths: actuallyRemoved,
      })
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK') } catch { /* ignore */ } }
      capture500(res, e, safeError)
    } finally {
      if (client) client.release()
    }
  })
}
