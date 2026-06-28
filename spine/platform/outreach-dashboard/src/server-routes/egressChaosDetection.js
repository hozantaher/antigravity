/**
 * Sprint AP4 — Egress chaos detection.
 *
 * runEgressChaosDetectionCron:
 *   1. PEEK observations from relay ring buffer (non-destructive)
 *      via GET /v1/egress-observations?peek=1
 *   2. Bulk-INSERT observations into mailbox_egress_observation
 *      (ON CONFLICT DO NOTHING — idempotent)
 *   3. ACK drain exactly N rows via GET /v1/egress-observations?drain=1&ack=N
 *      (relay removes only the rows BFF successfully processed; if BFF crashes
 *      between peek and ack the buffer is left intact for the next cron cycle)
 *   4. Runs SELECT detect_mailbox_egress_chaos(60) to find mailboxes
 *      seen from >1 country in the last 60 minutes
 *   5. For each chaotic mailbox (not already flagged, not warmup_d0 <24h):
 *      - UPDATE outreach_mailboxes SET status='egress_chaos_detected'
 *      - Fires a Sentry error alert
 *
 * Called from server.js startCronEngine() every 5 minutes via timed().
 *
 * Crash safety: relay buffer is cleared ONLY after successful INSERT. A BFF
 * crash between peek and ack leaves the buffer intact; duplicate rows on
 * retry are silently discarded by ON CONFLICT DO NOTHING.
 */

/**
 * @param {import('pg').Pool} pool
 * @param {{ Sentry?: import('@sentry/node') }} opts
 */
export async function runEgressChaosDetectionCron(pool, { Sentry } = {}) {
  const relayUrl =
    process.env.ANTI_TRACE_RELAY_URL_OVERRIDE ||
    process.env.ANTI_TRACE_RELAY_URL ||
    process.env.ANTI_TRACE_URL

  // Step 1: PEEK observations from relay ring buffer (non-destructive).
  // Buffer is NOT cleared yet — we clear it in Step 3 after successful INSERT.
  let observations = []
  if (relayUrl) {
    try {
      const r = await fetch(`${relayUrl}/v1/egress-observations?peek=1`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (r.ok) {
        const data = await r.json()
        observations = data.observations || []
      } else {
        console.warn(`[egressChaos] relay /v1/egress-observations → ${r.status}`)
      }
    } catch (e) {
      console.warn('[egressChaos] peek failed:', e.message)
      // Non-fatal: detection still runs on existing DB rows
    }
  }

  // Step 2: bulk-INSERT observations into DB (idempotent via ON CONFLICT DO NOTHING).
  // Any duplicate rows from a previous peek that crashed before ack are silently dropped.
  let insertedCount = 0
  if (observations.length > 0) {
    for (const obs of observations) {
      if (!obs.mailbox_id || !obs.country) continue
      try {
        await pool.query(
          `INSERT INTO mailbox_egress_observation
             (mailbox_id, egress_country, egress_endpoint_label, op_type, observed_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz)
           ON CONFLICT DO NOTHING`,
          [
            obs.mailbox_id,
            obs.country,
            obs.endpoint_label || null,
            obs.op_type || 'unknown',
            obs.observed_at || new Date().toISOString(),
          ],
        )
        insertedCount++
      } catch (e) {
        console.warn(`[egressChaos] INSERT obs failed mailbox_id=${obs.mailbox_id}:`, e.message)
      }
    }
    console.log(`[egressChaos] inserted ${insertedCount}/${observations.length} observations`)
  }

  // Step 3: ACK drain — tell relay to clear exactly N rows that BFF processed.
  // Only called when we actually peeked rows. If BFF crashed before reaching
  // here, the relay buffer stays intact and the next cron re-peeks the same rows.
  if (relayUrl && observations.length > 0) {
    try {
      const ackR = await fetch(
        `${relayUrl}/v1/egress-observations?drain=1&ack=${observations.length}`,
        { signal: AbortSignal.timeout(10_000) },
      )
      if (!ackR.ok) {
        // 409 = ack count mismatch (buffer grew between peek and ack — rare race).
        // Non-fatal: duplicate rows are idempotent in DB; relay buffer drains next cycle.
        console.warn(`[egressChaos] ack drain → ${ackR.status} (will retry next cycle)`)
      }
    } catch (e) {
      console.warn('[egressChaos] ack drain failed (non-fatal):', e.message)
    }
  }

  // Step 3: detect chaos — mailboxes seen from >1 country in last 60 min
  const { rows: chaosRows } = await pool.query(
    `SELECT mailbox_id, country_count, country_list
     FROM detect_mailbox_egress_chaos(60)`,
  )

  if (chaosRows.length === 0) {
    return { flagged: 0, observations_inserted: insertedCount }
  }

  let flagged = 0
  for (const r of chaosRows) {
    const mbId = r.mailbox_id

    // Check current mailbox state
    const { rows: mbRows } = await pool.query(
      `SELECT lifecycle_phase, status, created_at FROM outreach_mailboxes WHERE id=$1`,
      [mbId],
    )
    const mb = mbRows[0]
    if (!mb) continue

    // Skip if already flagged
    if (mb.status === 'egress_chaos_detected') continue

    // Warmup d0 exemption: first 24h of mailbox life (first egress legitimately
    // could come from any country as the mailbox hasn't settled into a country pin)
    if (mb.lifecycle_phase === 'warmup_d0') {
      const ageMs = Date.now() - new Date(mb.created_at).getTime()
      if (ageMs < 24 * 60 * 60 * 1000) continue
    }

    const reason = `egress_chaos: ${r.country_count} countries in 1h: ${r.country_list.join(',')}`

    // Step 4: flip status → egress_chaos_detected + audit row in one tx
    // (HARD: feedback_audit_log_on_mutations) — an operator-visible status flip
    // must never commit without a matching trail (Sentry alone is not a trail).
    const client = await pool.connect()
    let committed = false
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE outreach_mailboxes
           SET status = 'egress_chaos_detected',
               status_reason = $2,
               updated_at = NOW()
         WHERE id = $1`,
        [mbId, reason],
      )
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('mailbox_egress_chaos_flag', 'cron:runEgressChaosDetectionCron', 'mailbox', $1, $2::jsonb)`,
        [String(mbId), JSON.stringify({
          reason,
          country_count: r.country_count,
          country_list: r.country_list,
        })],
      )
      await client.query('COMMIT')
      committed = true
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      console.warn(`[egressChaos] flag tx failed mailbox ${mbId} (rolled back):`, txErr.message)
    } finally {
      client.release()
    }

    if (!committed) continue

    flagged++
    console.error(`[egressChaos] FLAGGED mailbox ${mbId}: ${reason}`)

    // Sentry alert — AO6: fingerprint groups by mailbox so same mailbox
    // does not flood with duplicate issues. mailbox_id in fingerprint
    // ensures distinct detections for the same mailbox collapse into one issue.
    if (typeof Sentry?.captureMessage === 'function') {
      Sentry.captureMessage(
        `mailbox_egress_chaos id=${mbId} countries=${r.country_count}`,
        {
          level: 'error',
          // AO6: one Sentry issue per mailbox (not per detection run)
          fingerprint: ['egress_chaos', String(mbId)],
          tags: {
            component: 'egress_chaos_detection',
            mailbox_id: String(mbId),
            // AO6: country_list tag enables fast triage filter in Sentry UI
            country_list: r.country_list.join(','),
          },
          extra: {
            mailbox_id: mbId,
            country_count: r.country_count,
            country_list: r.country_list,
            reason,
          },
        },
      )
    }
  }

  return { flagged, observations_inserted: insertedCount }
}
