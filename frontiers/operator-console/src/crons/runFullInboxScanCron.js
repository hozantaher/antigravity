/**
 * runFullInboxScanCron — AR14: full INBOX scan once/day (human-like "reading through mailbox").
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.dialIMAPViaSOCKS5    — server.js-local async helper
 *   @param {Function} deps.getMailboxSOCKS5Addr — server.js-local async helper
 *   @param {Function} deps.makeReader            — server.js-local helper
 */
export async function runFullInboxScanCron(pool, { dialIMAPViaSOCKS5, getMailboxSOCKS5Addr, makeReader }) {
  if (process.env.NODE_ENV !== 'production' && process.env.DISABLE_IMAP_CRON !== '0') {
    console.log('[cron] runFullInboxScanCron SKIPPED (NODE_ENV != production)')
    return
  }
  const { imapSinceDate } = await import('../lib/humanBehaviorSimulation.js')

  const { rows } = await pool.query(
    `SELECT id, imap_host, imap_port, imap_username, smtp_username, password, preferred_country
     FROM outreach_mailboxes
     WHERE status NOT IN ('retired', 'auth_locked')
       AND environment = 'production'
       AND imap_host IS NOT NULL`
  )

  let scanned = 0
  for (const mb of rows) {
    let comm = null
    let reader = null
    try {
      const socksAddr = await getMailboxSOCKS5Addr(mb)
      const port = Number(mb.imap_port) || 993
      const username = mb.imap_username || mb.smtp_username

      comm = await dialIMAPViaSOCKS5(socksAddr, mb.imap_host, port)
      reader = makeReader(comm)

      await reader.readLine(5000, 'fis-greeting')

      const qUser = `"${username.replace(/"/g, '\\"')}"`
      const qPass = `"${mb.password.replace(/"/g, '\\"')}"`
      comm.write(`F1 LOGIN ${qUser} ${qPass}\r\n`)
      const authLine = await reader.readLine(6000, 'fis-auth')
      if (!authLine.startsWith('F1 OK')) throw new Error('fis auth failed')

      // SELECT INBOX
      comm.write('F2 SELECT INBOX\r\n')
      let existsCount = 0
      for (let i = 0; i < 10; i++) {
        const l = await reader.readLine(3000, 'fis-sel')
        const existsMatch = l.match(/\* (\d+) EXISTS/)
        if (existsMatch) existsCount = parseInt(existsMatch[1], 10)
        if (l.startsWith('F2 ')) break
      }

      // SEARCH SINCE <7-days-ago> — fetch UID list for last 7 days
      const since = imapSinceDate(new Date(), 7)
      comm.write(`F3 SEARCH SINCE ${since}\r\n`)
      let searchResp = ''
      for (let i = 0; i < 10; i++) {
        const l = await reader.readLine(5000, 'fis-srch')
        searchResp += l + '\n'
        if (l.startsWith('F3 ')) break
      }
      const m = searchResp.match(/\* SEARCH([\d\s]*)\r?\n/)
      const uids = m ? m[1].trim().split(/\s+/).filter(Boolean) : []

      // No FETCH — we only simulate browsing through the list
      console.log(`[fis] mailbox=${mb.id} exists=${existsCount} recent_uids=${uids.length}`)

      // LIST all folders
      comm.write('F4 LIST "" "*"\r\n')
      for (let i = 0; i < 20; i++) {
        const l = await reader.readLine(3000, 'fis-list')
        if (l.startsWith('F4 ')) break
      }

      comm.write('F5 LOGOUT\r\n')
      await reader.readLine(3000, 'fis-logout').catch(() => {})
      scanned++
    } catch (e) {
      console.warn(`[fis] mailbox=${mb.id} error: ${e.message}`)
    } finally {
      try { reader?.detach() } catch {}
      try { comm?.destroy() } catch {}
    }
  }
  console.log(`[cron] runFullInboxScanCron done — scanned=${scanned}/${rows.length} mailboxes`)
}
