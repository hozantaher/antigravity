// AR15 — Mullvad endpoint reputation monitoring cron + operator endpoint.
//
// AP4 detects multi-country simultaneous logins; AR15 is complementary:
// if a single Mullvad endpoint (e.g. cz-prg-2) accumulates a higher bounce
// rate than the fleet average over 7 days, we flag it before it causes
// campaign damage.
//
// Cron: runMullvadEndpointReputationCron — fires every 6h via scheduleCron.
// Operator endpoint: GET /api/relay/endpoint-health
//
// Query logic:
//   - Join mailbox_egress_observation ON send_events via mailbox_id/mailbox_used
//   - Group by egress_endpoint_label, 7-day rolling window, min 50 sends
//   - Flag where per-endpoint bounce_rate >= 2× fleet mean
//   - On each hit: UPSERT mailbox_egress_endpoint_health + log + Sentry warning

/**
 * Run one tick of the Mullvad endpoint reputation cron.
 * @param {import('pg').Pool} pool
 * @param {{ Sentry?: object }} [deps]
 * @returns {Promise<{flagged: number, checked: number, endpoints: Array}>}
 */
export async function runMullvadEndpointReputationCron(pool, deps = {}) {
  const { Sentry } = deps

  // Compute per-endpoint bounce stats and fleet average.
  //
  // The send stats are computed ONCE PER MAILBOX (mailbox_sends), then summed
  // per endpoint over the distinct mailboxes that egressed through it in the
  // 7-day window. The previous shape joined send_events directly onto each
  // observation row (no send-level key), which cross-joined every observation
  // with every send → an observation-weighted, lifetime-diluted rate. It also
  // had no sent_at filter, so sends/bounces aggregated all-time rather than 7d.
  const { rows } = await pool.query(`
    WITH endpoint_mailboxes AS (
      -- distinct (endpoint, mailbox) pairs observed egressing in the last 7d
      SELECT DISTINCT o.egress_endpoint_label, o.mailbox_id
      FROM mailbox_egress_observation o
      WHERE o.observed_at > NOW() - INTERVAL '7 days'
        AND o.op_type = 'send'
        AND o.egress_endpoint_label IS NOT NULL
    ),
    mailbox_sends AS (
      -- per-mailbox 7d send/bounce totals, counted once (no observation fan-out)
      SELECT
        mb.id                                                AS mailbox_id,
        count(se.id)                                         AS sends,
        count(se.id) FILTER (WHERE se.status = 'bounced')   AS bounces
      FROM outreach_mailboxes mb
      JOIN send_events se
        ON se.mailbox_used = mb.from_address
       AND se.sent_at > NOW() - INTERVAL '7 days'
      GROUP BY mb.id
    ),
    endpoint_stats AS (
      SELECT
        em.egress_endpoint_label,
        COALESCE(SUM(ms.sends), 0)   AS sends,
        COALESCE(SUM(ms.bounces), 0) AS bounces
      FROM endpoint_mailboxes em
      LEFT JOIN mailbox_sends ms ON ms.mailbox_id = em.mailbox_id
      GROUP BY em.egress_endpoint_label
      HAVING COALESCE(SUM(ms.sends), 0) >= 50
    ),
    avg_rate AS (
      SELECT avg(bounces::float / sends) AS mean_rate
      FROM endpoint_stats
      WHERE sends > 0
    )
    SELECT
      es.egress_endpoint_label  AS label,
      es.sends,
      es.bounces,
      (es.bounces::float / es.sends)    AS rate,
      ar.mean_rate
    FROM endpoint_stats es, avg_rate ar
    WHERE es.sends > 0
  `)

  let flagged = 0
  const endpoints = []

  for (const r of rows) {
    const isFlagged = r.rate >= 2 * r.mean_rate
    endpoints.push({ label: r.label, sends: Number(r.sends), bounces: Number(r.bounces), rate: r.rate, mean_rate: r.mean_rate, flagged: isFlagged })

    // UPSERT into health table — always update so operators see latest stats.
    await pool.query(
      `INSERT INTO mailbox_egress_endpoint_health
         (endpoint_label, observed_at, sends_7d, bounces_7d, bounce_rate, avg_rate_7d)
       VALUES ($1, NOW(), $2, $3, $4, $5)
       ON CONFLICT (endpoint_label) DO UPDATE SET
         observed_at = EXCLUDED.observed_at,
         sends_7d    = EXCLUDED.sends_7d,
         bounces_7d  = EXCLUDED.bounces_7d,
         bounce_rate = EXCLUDED.bounce_rate,
         avg_rate_7d = EXCLUDED.avg_rate_7d`,
      [r.label, Number(r.sends), Number(r.bounces), r.rate, r.mean_rate],
    )

    if (isFlagged) {
      flagged++
      console.warn(
        `[AR15] endpoint_reputation_elevated label=${r.label} rate=${(r.rate * 100).toFixed(1)}% mean=${(r.mean_rate * 100).toFixed(1)}% ratio=${(r.rate / r.mean_rate).toFixed(2)}×`,
      )
      try {
        Sentry?.captureMessage(
          `endpoint_reputation_elevated: ${r.label} bounce_rate=${(r.rate * 100).toFixed(1)}% (${(r.rate / r.mean_rate).toFixed(2)}× mean)`,
          'warning',
        )
      } catch (_) { /* Sentry best-effort */ }
    }
  }

  console.log(`[AR15] runMullvadEndpointReputationCron checked=${rows.length} flagged=${flagged}`)
  return { flagged, checked: rows.length, endpoints }
}

/**
 * Mount the operator endpoint-health route.
 * GET /api/relay/endpoint-health — lists all tracked endpoints with current stats.
 * @param {import('express').Router} app
 * @param {import('pg').Pool} pool
 */
export function mountEndpointHealthRoute(app, pool) {
  app.get('/api/relay/endpoint-health', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          endpoint_label,
          observed_at,
          sends_7d,
          bounces_7d,
          round((bounce_rate * 100)::numeric, 2)    AS bounce_rate_pct,
          round((avg_rate_7d * 100)::numeric, 2)    AS avg_rate_pct,
          round(ratio::numeric, 2)                   AS ratio,
          flagged
        FROM mailbox_egress_endpoint_health
        ORDER BY flagged DESC, bounce_rate_pct DESC
      `)
      res.json({ ok: true, endpoints: rows })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })
}
