// Sprint AS4 — Pool capacity monitoring.
//
// runPoolCapacityCron (1×/h, AR6 scheduleCron jitter):
//   1. Read pool size from WIREPROXY_POOL_CONFIG env (JSON array of endpoints)
//   2. Count production mailboxes that have a non-NULL pinned_endpoint_label
//   3. Compute ratio = pinned / pool_size
//   4. If ratio >= 1.0 → Sentry error (pool_exhausted)
//      If ratio >= 0.8 → Sentry warning (pool_high_utilization)
//
// preFlightPoolCapacity: shared helper for both cron and the operator
// GET /api/relay/pool-capacity endpoint.
//
// Only Sentry for alerting (feedback_no_extra_monitoring HARD RULE).

/**
 * Compute pool capacity metrics without side-effects.
 * Exported so the operator endpoint can call it independently.
 *
 * P0.1 fix: accepts optional `env` parameter (default 'production') for
 * parity with the old relayPoolCapacity.js handler which supported ?env=test.
 *
 * @param {import('pg').Pool} pool
 * @param {string} [env]
 * @returns {Promise<{pool_size: number, pinned_count: number, ratio: number}>}
 */
export async function preFlightPoolCapacity(pool, env = 'production') {
  const poolConfig = JSON.parse(process.env.WIREPROXY_POOL_CONFIG || '[]')
  const poolSize = poolConfig.length

  if (poolSize === 0) {
    return { pool_size: 0, pinned_count: 0, ratio: 0 }
  }

  const { rows: [{ pinned }] } = await pool.query(
    `SELECT count(*)::int AS pinned
       FROM outreach_mailboxes
      WHERE pinned_endpoint_label IS NOT NULL
        AND environment = $1`,
    [env],
  )

  const pinnedCount = Number(pinned)
  const ratio = pinnedCount / poolSize

  return { pool_size: poolSize, pinned_count: pinnedCount, ratio }
}

// Q4.1 hysteresis: track previous alert state to avoid alert spam at boundaries
let lastAlertState = null  // 'ok' | 'warning' | 'error'

/**
 * Run pool capacity cron for one tick.
 *
 * @param {import('pg').Pool} pool
 * @param {{ Sentry?: object }} [deps]
 * @returns {Promise<{skipped?: boolean, reason?: string, pool_size?: number, pinned_count?: number, ratio?: number, alerted?: string|null}>}
 */
export async function runPoolCapacityCron(pool, { Sentry } = {}) {
  const poolConfig = JSON.parse(process.env.WIREPROXY_POOL_CONFIG || '[]')
  const poolSize = poolConfig.length

  if (poolSize === 0) {
    console.warn('[cron] runPoolCapacityCron — no pool configured (WIREPROXY_POOL_CONFIG empty), skipping')
    return { skipped: true, reason: 'no_pool_config' }
  }

  const { pool_size, pinned_count, ratio } = await preFlightPoolCapacity(pool)
  const result = { pool_size, pinned_count, ratio, alerted: null }

  // Q4.1: Compute new state
  const newState = ratio >= 1.0 ? 'error' : ratio >= 0.8 ? 'warning' : 'ok'

  // Q4.1: Only fire Sentry if state changes (hysteresis)
  if (newState !== lastAlertState) {
    if (newState === 'error') {
      const msg = `pool_exhausted ratio=${ratio.toFixed(2)} pinned=${pinned_count} pool_size=${pool_size}`
      console.error(`[AS4] ${msg}`)
      try {
        Sentry?.captureMessage(msg, 'error')
        result.alerted = 'error'
      } catch (_) { /* Sentry best-effort */ }
    } else if (newState === 'warning') {
      const msg = `pool_high_utilization ratio=${ratio.toFixed(2)} pinned=${pinned_count} pool_size=${pool_size}`
      console.warn(`[AS4] ${msg}`)
      try {
        Sentry?.captureMessage(msg, 'warning')
        result.alerted = 'warning'
      } catch (_) { /* Sentry best-effort */ }
    } else {
      console.log(`[AS4] runPoolCapacityCron ratio=${ratio.toFixed(2)} pinned=${pinned_count}/${pool_size} — alert cleared`)
    }
    lastAlertState = newState
  } else {
    console.log(`[AS4] runPoolCapacityCron ratio=${ratio.toFixed(2)} pinned=${pinned_count}/${pool_size} (state unchanged: ${newState})`)
  }

  return result
}

/**
 * Mount the operator pool-capacity endpoint onto an Express router.
 * Exposes GET /api/relay/pool-capacity for operator visibility.
 *
 * P0.1 fix: this is the canonical handler (replaces the shadow
 * mountRelayPoolCapacityRoute from relayPoolCapacity.js). It returns a richer
 * response with per-endpoint pinned_to detail, plus free_count + can_add for
 * backward compat with AS3 consumers.
 *
 * @param {import('express').Router} router
 * @param {import('pg').Pool} pool
 */
export function mountPoolCapacityRoutes(router, pool) {
  router.get('/api/relay/pool-capacity', async (req, res) => {
    try {
      // P0.1 fix: accept ?env= for parity with the old relayPoolCapacity.js.
      const env = req.query?.env === 'test' ? 'test' : 'production'
      const metrics = await preFlightPoolCapacity(pool, env)

      const poolConfig = JSON.parse(process.env.WIREPROXY_POOL_CONFIG || '[]')
      const endpoints = poolConfig.map(e => ({
        label: e.label,
        country: e.country,
        pinned_to: null,
      }))

      if (endpoints.length > 0) {
        const { rows } = await pool.query(
          `SELECT id, from_address, pinned_endpoint_label
             FROM outreach_mailboxes
            WHERE pinned_endpoint_label IS NOT NULL
              AND environment = $1`,
          [env],
        )
        for (const r of rows) {
          const ep = endpoints.find(e => e.label === r.pinned_endpoint_label)
          if (ep) {
            // Redact: hide local-part per feedback_no_pii_in_commands
            ep.pinned_to = {
              id: r.id,
              from_address_redacted: r.from_address.replace(/^[^@]+@/, '<u>@'),
            }
          }
        }
      }

      // Include free_count + can_add for backward compat with AS3 consumers
      // that previously called the simpler relayPoolCapacity.js handler.
      const freeCount = Math.max(0, metrics.pool_size - metrics.pinned_count)
      res.json({ ...metrics, free_count: freeCount, can_add: freeCount > 0, endpoints })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })
}
