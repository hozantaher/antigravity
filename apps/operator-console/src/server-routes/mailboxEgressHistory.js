/**
 * Sprint AO6 — Mailbox egress history endpoint.
 *
 * GET /api/mailboxes/:id/egress-history?hours=24
 *
 * Returns per-mailbox egress observations + aggregates for the UI
 * Egress Audit panel. Reads from mailbox_egress_observation (migration 075,
 * Sprint AP4) — does NOT write; pure read path.
 *
 * Response shape:
 * {
 *   mailbox_id: number,
 *   hours: number,            // window requested (1–168)
 *   observations: [           // raw rows, newest first, capped at 500
 *     { id, egress_country, egress_endpoint_label, op_type, observed_at }
 *   ],
 *   summary: {
 *     distinct_countries: string[],       // sorted ISO codes seen in window
 *     country_counts: { [cc: string]: number },  // cc → total obs count
 *     hour_country_matrix: [             // for heat map — 24 entries (or `hours` if <24)
 *       { hour_offset: number, country: string, count: number }
 *     ],
 *     chaos_detected: boolean,           // true if >1 distinct country in window
 *   },
 *   quarantine_status: {       // current mailbox quarantine state
 *     status: string,          // outreach_mailboxes.status
 *     status_reason: string | null,
 *     auth_locked_at: string | null,
 *   }
 * }
 *
 * Errors:
 *   404 — mailbox not found
 *   400 — invalid id or hours param
 *   500 — DB error
 */

/**
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountMailboxEgressHistoryRoute(app, { pool, capture500, safeError }) {
  app.get('/api/mailboxes/:id/egress-history', async (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid mailbox id' })
    }

    // hours param: 1–168 (1 week max), default 24
    const hoursRaw = parseInt(req.query.hours || '24', 10)
    if (isNaN(hoursRaw) || hoursRaw < 1 || hoursRaw > 168) {
      return res.status(400).json({ error: 'hours must be between 1 and 168' })
    }
    const hours = hoursRaw

    try {
      // 1. Verify mailbox exists + get quarantine state
      const { rows: mbRows } = await pool.query(
        `SELECT id, status, status_reason, auth_locked_at
           FROM outreach_mailboxes
          WHERE id = $1`,
        [id],
      )
      if (!mbRows.length) {
        return res.status(404).json({ error: 'mailbox not found' })
      }
      const mb = mbRows[0]

      // 2. Raw observations (newest first, capped at 500 to avoid OOM)
      const { rows: obsRows } = await pool.query(
        `SELECT id, egress_country, egress_endpoint_label, op_type, observed_at
           FROM mailbox_egress_observation
          WHERE mailbox_id = $1
            AND observed_at > NOW() - make_interval(hours => $2)
          ORDER BY observed_at DESC
          LIMIT 500`,
        [id, hours],
      )

      // 3. Country aggregates
      const { rows: countryRows } = await pool.query(
        `SELECT egress_country, COUNT(*)::int AS cnt
           FROM mailbox_egress_observation
          WHERE mailbox_id = $1
            AND observed_at > NOW() - make_interval(hours => $2)
          GROUP BY egress_country
          ORDER BY cnt DESC`,
        [id, hours],
      )

      const distinctCountries = countryRows.map(r => r.egress_country)
      const countryCounts = Object.fromEntries(countryRows.map(r => [r.egress_country, r.cnt]))

      // 4. Hour × country matrix for heat map
      // We bucket by hour_offset from now (0 = most recent completed hour).
      // We compute up to min(hours, 24) buckets to keep the payload small.
      const heatMapHours = Math.min(hours, 24)
      const { rows: matrixRows } = await pool.query(
        `SELECT
            EXTRACT(EPOCH FROM (NOW() - observed_at))::int / 3600 AS hour_offset,
            egress_country,
            COUNT(*)::int AS count
           FROM mailbox_egress_observation
          WHERE mailbox_id = $1
            AND observed_at > NOW() - make_interval(hours => $2)
          GROUP BY hour_offset, egress_country
          ORDER BY hour_offset ASC, egress_country ASC`,
        [id, heatMapHours],
      )

      const hourCountryMatrix = matrixRows
        .filter(r => r.hour_offset >= 0 && r.hour_offset < heatMapHours)
        .map(r => ({
          hour_offset: r.hour_offset,
          country: r.egress_country,
          count: r.count,
        }))

      return res.json({
        mailbox_id: id,
        hours,
        observations: obsRows,
        summary: {
          distinct_countries: distinctCountries,
          country_counts: countryCounts,
          hour_country_matrix: hourCountryMatrix,
          chaos_detected: distinctCountries.length > 1,
        },
        quarantine_status: {
          status: mb.status,
          status_reason: mb.status_reason,
          auth_locked_at: mb.auth_locked_at,
        },
      })
    } catch (e) {
      // Graceful degradation: if migration 075 hasn't applied yet, return empty
      if (/relation .* does not exist/i.test(e.message)) {
        return res.json({
          mailbox_id: id,
          hours,
          observations: [],
          summary: { distinct_countries: [], country_counts: {}, hour_country_matrix: [], chaos_detected: false },
          quarantine_status: { status: 'unknown', status_reason: null, auth_locked_at: null },
        })
      }
      return capture500(res, e, safeError)
    }
  })
}
