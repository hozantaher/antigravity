// Category Tree — hierarchical segment selection for campaigns.
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 2026-05-12: new route surface for the operator-facing CategoryTreePicker
// UI that lets operators include/exclude branches of the firmy.cz category tree
// and re-enroll campaign_contacts accordingly.
//
// Routes:
//   GET  /api/category-tree              — L1 nodes (empty/null parent)
//   GET  /api/category-tree?parent=<p>   — children of <parent_path>
//   POST /api/category-tree/select       — bulk include/exclude with cascade
//   POST /api/campaigns/:id/segment/apply — re-enroll contacts from tree selection
//
// DB tables touched:
//   category_tree        — PRIMARY KEY = path; columns: parent_path, label,
//                          level (1-8), contacts_direct, contacts_subtree, included BOOLEAN
//   campaign_contacts    — id, campaign_id, contact_id, current_step, next_send_at, status
//   contacts             — id, category_path, company_ico (or contacts→companies JOIN)
//   companies            — ico, category_path
//   campaigns            — id, category_paths (text[])
//
// HARD RULE — feedback_anti_trace_full_stack: this handler does not dial
// SMTP/IMAP. It only reads/writes PG. No relay/proxy concerns.

/**
 * Mount the CategoryTree route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountCategoryTreeRoutes(app, { pool, capture500, safeError }) {

  // ── GET /api/category-tree ──────────────────────────────────────────────────
  // Returns children of ?parent=<path> (or L1 roots when parent is absent).
  // Each row includes has_children so the UI can show/hide expand carets.
  app.get('/api/category-tree', async (req, res) => {
    try {
      const { parent } = req.query
      const useParent = typeof parent === 'string' && parent.trim() !== ''

      const { rows } = await pool.query(
        `
        SELECT
          ct.path,
          ct.label,
          ct.level,
          ct.contacts_direct,
          ct.contacts_subtree,
          ct.included,
          EXISTS (
            SELECT 1 FROM category_tree child
             WHERE child.parent_path = ct.path
          ) AS has_children
        FROM category_tree ct
        WHERE ${useParent ? 'ct.parent_path = $1' : 'ct.parent_path IS NULL'}
        ORDER BY ct.label ASC
        `,
        useParent ? [parent.trim()] : []
      )

      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── POST /api/category-tree/select ─────────────────────────────────────────
  // Body: { paths: string[], action: 'include' | 'exclude' }
  // Sets included = true/false for each listed path and cascades to all
  // descendants via a recursive CTE over parent_path.
  app.post('/api/category-tree/select', async (req, res) => {
    const { paths, action } = req.body ?? {}

    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths must be a non-empty array' })
    }
    if (action !== 'include' && action !== 'exclude') {
      return res.status(400).json({ error: 'action must be "include" or "exclude"' })
    }

    const included = action === 'include'
    let client
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      // 1. Update the explicitly selected paths.
      await client.query(
        `UPDATE category_tree SET included = $1 WHERE path = ANY($2::text[])`,
        [included, paths]
      )

      // 2. Cascade to all descendants (recursive CTE on parent_path lineage).
      await client.query(
        `
        WITH RECURSIVE descendants AS (
          SELECT path FROM category_tree WHERE path = ANY($2::text[])
          UNION ALL
          SELECT ct.path
            FROM category_tree ct
            JOIN descendants d ON ct.parent_path = d.path
        )
        UPDATE category_tree
           SET included = $1
         WHERE path IN (SELECT path FROM descendants)
           AND path != ANY($2::text[])
        `,
        [included, paths]
      )

      await client.query('COMMIT')

      // Return updated counts so the UI can optimistically re-render.
      const { rows: updated } = await pool.query(
        `SELECT path, included FROM category_tree WHERE path = ANY($1::text[])`,
        [paths]
      )
      res.json({ ok: true, updated })
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK') } catch { /* ignore */ } }
      capture500(res, e, safeError)
    } finally {
      if (client) client.release()
    }
  })

  // ── POST /api/campaigns/:id/segment/apply ──────────────────────────────────
  // Body: { source: 'category_tree' }
  // Re-enrolls campaign_contacts from contacts that match any included category.
  // Contacts are matched via companies.category_path (prefix semantics: the
  // company path starts with an included node's path).
  //
  // This is a DIFF, not a wipe-and-rebuild. It must NEVER delete or reset a
  // contact that already has send progress in this campaign:
  //   - INSERT only newly-matched contacts that are not already enrolled.
  //   - DELETE only pristine enrollments (status='pending' AND current_step=0)
  //     that no longer match any included path. Rows that are in_flight / sent /
  //     replied / bounced / completed / in_sequence / unsubscribed / … or that
  //     have current_step > 0 are left exactly as they are.
  // The previous implementation did `DELETE FROM campaign_contacts WHERE
  // campaign_id=$1` then re-inserted everyone as ('pending',0,NOW()) — that
  // wiped in-flight send progress (resetting sent contacts back to step 0),
  // and the old comment falsely claimed "status unchanged".
  //
  // HARD RULE — does NOT start campaign send (campaigns.status is untouched).
  // HARD RULE feedback_audit_log_on_mutations — operator_audit_log INSERT in
  // the SAME transaction as the prune/enroll.
  app.post('/api/campaigns/:id/segment/apply', async (req, res) => {
    const campaignId = parseInt(req.params.id, 10)
    if (isNaN(campaignId)) {
      return res.status(400).json({ error: 'invalid campaign id' })
    }

    const { source } = req.body ?? {}
    if (source !== 'category_tree') {
      return res.status(400).json({ error: 'source must be "category_tree"' })
    }

    const operator =
      (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
      (req.user && req.user.email) ||
      'operator_category_tree_apply'

    let client
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      // 1. Verify campaign exists.
      const { rows: campaignRows } = await client.query(
        `SELECT id, name, status FROM campaigns WHERE id = $1`,
        [campaignId]
      )
      if (campaignRows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'campaign not found' })
      }

      // 2. Collect all included paths from category_tree.
      const { rows: includedRows } = await client.query(
        `SELECT path FROM category_tree WHERE included = true ORDER BY path`
      )
      const includedPaths = includedRows.map(r => r.path)

      // 3. Prune — delete ONLY pristine, never-sent enrollments
      //    (status='pending' AND current_step=0) whose company no longer
      //    matches any included path. The status + current_step guard protects
      //    every in-flight / sent / replied / terminal row from being dropped.
      //    With an empty selection this prunes all pristine-pending rows (the
      //    operator cleared the segment) while still protecting progress.
      const { rows: prunedRows } = await client.query(
        `
        DELETE FROM campaign_contacts cc
         WHERE cc.campaign_id = $1
           AND cc.status = 'pending'
           AND cc.current_step = 0
           AND NOT EXISTS (
             SELECT 1
               FROM contacts c
               JOIN companies co ON co.ico = c.company_ico
               JOIN unnest($2::text[]) AS ip(ipath)
                 ON co.category_path LIKE ip.ipath || '%'
              WHERE c.id = cc.contact_id
           )
        RETURNING cc.id
        `,
        [campaignId, includedPaths]
      )
      const removedCount = prunedRows.length

      let enrolledCount = 0

      if (includedPaths.length > 0) {
        // 4. Enroll newly-matched contacts: company's category_path starts with
        //    one of the included paths (prefix match — same semantics as the
        //    Go runner + segment-expansion endpoint). DISTINCT so a contact
        //    matching >1 nested prefix is enrolled once; NOT EXISTS skips
        //    contacts already enrolled (campaign_contacts has no unique index,
        //    so ON CONFLICT can't dedupe — migration 171); suppression UNION
        //    excludes contacts on EITHER suppression table.
        const { rows: enrollRows } = await client.query(
          `
          WITH included_paths AS (
            SELECT unnest($2::text[]) AS ipath
          ),
          matched_contacts AS (
            SELECT DISTINCT c.id AS contact_id
              FROM contacts c
              JOIN companies co ON co.ico = c.company_ico
              JOIN included_paths ip ON co.category_path LIKE ip.ipath || '%'
             WHERE c.email IS NOT NULL
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
          INSERT INTO campaign_contacts (campaign_id, contact_id, status, current_step, next_send_at)
          SELECT $1, mc.contact_id, 'pending', 0, NOW()
            FROM matched_contacts mc
          ON CONFLICT DO NOTHING
          RETURNING id
          `,
          [campaignId, includedPaths]
        )
        enrolledCount = enrollRows.length
      }

      // 5. Update campaigns.category_paths to reflect current tree selection.
      //    Store as a JSON-encoded string (the canonical TEXT-column shape the
      //    Go runner json.Unmarshals, and what CreateCampaign + PATCH + segment
      //    expansion all write). Binding the raw JS array makes node-postgres
      //    emit a Postgres array literal `{a,b}` that the Go reader can't parse,
      //    silently dropping the campaign's category filter.
      await client.query(
        `UPDATE campaigns SET category_paths = $1 WHERE id = $2`,
        [JSON.stringify(includedPaths), campaignId]
      )

      // 6. Audit row IN SAME TX — feedback_audit_log_on_mutations.
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('campaign_segment_apply', $1, 'campaign', $2, $3::jsonb)`,
        [
          operator,
          campaignId,
          JSON.stringify({
            source: 'category_tree',
            included_paths: includedPaths.length,
            enrolled: enrolledCount,
            removed: removedCount,
          }),
        ]
      )

      await client.query('COMMIT')

      const generatedAt = new Date().toISOString()
      res.json({
        ok: true,
        enrolled: enrolledCount,
        removed: removedCount,
        generated_at: generatedAt,
      })
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK') } catch { /* ignore */ } }
      capture500(res, e, safeError)
    } finally {
      if (client) client.release()
    }
  })
}
