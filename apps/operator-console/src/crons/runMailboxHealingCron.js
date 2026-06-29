/**
 * runMailboxHealingCron — auto-unpause mailboxes with auto-reason after SMTP recovery.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 */
export async function runMailboxHealingCron(pool) {
  console.log('[cron] runMailboxHealingCron start')
  try {
    // Najdi schránky auto-pauzované kvůli SMTP failům (proxy nebo auth)
    const { rows: paused } = await pool.query(`
      SELECT id FROM outreach_mailboxes
      WHERE status = 'paused'
        AND status_reason LIKE 'auto:%'
        AND updated_at < now() - interval '10 minutes'
    `)
    let healed = 0
    const base = `http://localhost:${process.env.PORT || 18001}`
    for (const { id } of paused) {
      try {
        // Targeted full-check (force=1 přeskočí cache)
        const r = await fetch(`${base}/api/mailboxes/${id}/full-check?force=1`,
          { headers: { 'x-api-key': process.env.OUTREACH_API_KEY || '' } })
        if (!r.ok) continue
        const check = await r.json()
        // Pouze pokud SMTP projde (ok=true a smtp check ok)
        if (check.ok && check.checks?.smtp?.ok) {
          await pool.query(`
            UPDATE outreach_mailboxes
            SET status = 'active',
                status_reason = NULL,
                auth_fail_count = 0,
                updated_at = now()
            WHERE id = $1 AND status = 'paused'
          `, [id])
          healed++
          console.log(`[healing] mailbox ${id} auto-unpaused — full-check passed`)
        }
      } catch (e) {
        console.error(`[healing] mailbox ${id}:`, e.message)
      }
    }
    console.log(`[cron] runMailboxHealingCron done — checked ${paused.length}, healed ${healed}`)
  } catch (e) {
    console.error('[cron] runMailboxHealingCron error:', e.message)
  }
}
