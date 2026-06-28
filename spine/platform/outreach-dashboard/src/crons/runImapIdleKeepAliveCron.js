/**
 * runImapIdleKeepAliveCron — AR14: open IMAP IDLE for mailboxes in their 2h nightly window.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.dialIMAPViaSOCKS5    — server.js-local async helper
 *   @param {Function} deps.getMailboxSOCKS5Addr — server.js-local async helper
 *   @param {Function} deps.makeReader            — server.js-local helper
 */
export async function runImapIdleKeepAliveCron(pool, { dialIMAPViaSOCKS5, getMailboxSOCKS5Addr, makeReader }) {
  if (process.env.NODE_ENV !== 'production' && process.env.DISABLE_IMAP_CRON !== '0') {
    console.log('[cron] runImapIdleKeepAliveCron SKIPPED (NODE_ENV != production)')
    return
  }
  const { isInIdleWindow } = await import('../lib/humanBehaviorSimulation.js')
  const nowHour = new Date().getUTCHours()

  const { rows } = await pool.query(
    `SELECT id, imap_host, imap_port, imap_username, smtp_username, password, preferred_country
     FROM outreach_mailboxes
     WHERE status NOT IN ('retired', 'auth_locked')
       AND environment = 'production'
       AND imap_host IS NOT NULL`
  )

  for (const mb of rows) {
    const offset = (mb.id % 6) / 6   // stable per-mailbox offset in [0,1)
    if (!isInIdleWindow(nowHour, offset)) continue

    // Fire-and-forget: IDLE for up to 2h. We intentionally do NOT await so
    // this cron completes quickly — IDLE connections run independently.
    // Each connection is self-contained with its own error handling.
    ;(async () => {
      let comm = null
      let reader = null
      const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000  // 2h hard cap
      const IDLE_GRACE_MS   = 10_000               // post-IDLE drain
      try {
        const socksAddr = await getMailboxSOCKS5Addr(mb)
        const port = Number(mb.imap_port) || 993
        const username = mb.imap_username || mb.smtp_username

        comm = await dialIMAPViaSOCKS5(socksAddr, mb.imap_host, port)
        reader = makeReader(comm)

        await reader.readLine(5000, 'idle-greeting')

        const qUser = `"${username.replace(/"/g, '\\"')}"`
        const qPass = `"${mb.password.replace(/"/g, '\\"')}"`
        comm.write(`I1 LOGIN ${qUser} ${qPass}\r\n`)
        const authLine = await reader.readLine(6000, 'idle-auth')
        if (!authLine.startsWith('I1 OK')) throw new Error('idle auth failed')

        comm.write('I2 SELECT INBOX\r\n')
        for (let i = 0; i < 10; i++) {
          const l = await reader.readLine(3000, 'idle-sel')
          if (l.startsWith('I2 ')) break
        }

        comm.write('I3 IDLE\r\n')
        // Wait for continuation + response
        await reader.readLine(5000, 'idle-start')

        // Stay IDLE for up to IDLE_TIMEOUT_MS, then send DONE
        await new Promise((resolve) => setTimeout(resolve, IDLE_TIMEOUT_MS))

        comm.write('DONE\r\n')
        // Drain for grace period
        await new Promise((resolve) => setTimeout(resolve, IDLE_GRACE_MS))

        comm.write('I4 LOGOUT\r\n')
        await reader.readLine(3000, 'idle-logout').catch(() => {})
        console.log(`[idle] mailbox=${mb.id} IDLE completed (2h window)`)
      } catch (e) {
        console.warn(`[idle] mailbox=${mb.id} error: ${e.message}`)
      } finally {
        try { reader?.detach() } catch {}
        try { comm?.destroy() } catch {}
      }
    })().catch(() => {})
  }
  console.log(`[cron] runImapIdleKeepAliveCron done — nowHour=${nowHour}`)
}
