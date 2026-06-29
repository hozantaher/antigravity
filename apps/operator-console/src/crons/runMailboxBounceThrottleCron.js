import { runMailboxBounceThrottle } from '../../mailboxBounceThrottle.js'

/**
 * runMailboxBounceThrottleCron — S11: throttle/pause mailboxes based on bounce rate.
 * Logic lives in mailboxBounceThrottle.js (importable, testable).
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 */
export async function runMailboxBounceThrottleCron(pool) {
  console.log('[cron] runMailboxBounceThrottleCron start')
  try {
    const { paused, throttled } = await runMailboxBounceThrottle(pool)
    console.log(`[cron] runMailboxBounceThrottleCron done — paused ${paused}, throttled ${throttled}`)
  } catch (e) {
    console.error('[cron] runMailboxBounceThrottleCron error:', e.message)
  }
}
