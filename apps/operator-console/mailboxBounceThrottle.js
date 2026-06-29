// S11 — Mailbox bounce cascade auto-throttle
// Extracts the throttle logic into a pool-injected function so it can be
// unit-tested without a live database connection.
//
// Rules (pure logic in evaluateBounceThrottleAction, src/lib/automation.js):
//   total_sent < 10          → skip (not enough data)
//   bounce_rate >= 10% OR consecutive_bounces >= 5  → pause (critical)
//   bounce_rate >= 5%  OR consecutive_bounces >= 3  → throttle daily cap to 50%
//
// BF-A4 — race + edge-case hardening:
//   - pause UPDATE re-asserts status='active' so we don't fight an
//     operator's manual unpause that landed mid-cron.
//   - 'at_floor' decision separated from 'throttle' so metrics don't
//     conflate genuine cap reductions with no-op rewrites of the floor.

import { evaluateBounceThrottleAction } from './src/lib/automation.js'

/**
 * @param {import('pg').Pool} pool
 * @returns {Promise<{paused: number, throttled: number, atFloor: number}>}
 */
export async function runMailboxBounceThrottle(pool) {
  const { rows } = await pool.query(`
    SELECT m.id, m.from_address, m.daily_cap_override,
           m.consecutive_bounces, m.total_sent,
           CASE WHEN m.total_sent > 0
             THEN m.total_bounced::float / m.total_sent * 100
             ELSE 0 END AS bounce_rate
    FROM outreach_mailboxes m
    WHERE m.status = 'active'
      AND m.environment = 'production'
      AND m.total_sent >= 10
  `)
  let paused = 0
  let throttled = 0
  let atFloor = 0
  for (const mb of rows) {
    const decision = evaluateBounceThrottleAction({
      bounceRate: mb.bounce_rate,
      consecutiveBounces: mb.consecutive_bounces,
      totalSent: mb.total_sent,
      currentCap: mb.daily_cap_override,
    })
    if (decision.action === 'pause') {
      const upd = await pool.query(
        `UPDATE outreach_mailboxes
            SET status='paused', status_reason='auto: bounce rate critical'
          WHERE id=$1 AND status='active'`,
        [mb.id]
      )
      if (upd.rowCount > 0) {
        paused++
        console.log(`[bounce-throttle] mailbox ${mb.id} paused: ${decision.reason}`)
      }
    } else if (decision.action === 'throttle') {
      const upd = await pool.query(
        `UPDATE outreach_mailboxes SET daily_cap_override=$1 WHERE id=$2 AND daily_cap_override > $1`,
        [decision.newCap, mb.id]
      )
      if (upd.rowCount > 0) {
        throttled++
        console.log(`[bounce-throttle] mailbox ${mb.id} throttled: ${decision.reason}`)
      }
    } else if (decision.action === 'at_floor') {
      atFloor++
    }
  }
  return { paused, throttled, atFloor }
}
