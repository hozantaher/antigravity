/**
 * runFolderOperationsCron — AR14: monthly folder management (LIST + CREATE missing standard folders).
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.dialIMAPViaSOCKS5    — server.js-local async helper
 *   @param {Function} deps.getMailboxSOCKS5Addr — server.js-local async helper
 *   @param {Function} deps.makeReader            — server.js-local helper
 */
export async function runFolderOperationsCron(pool, { dialIMAPViaSOCKS5, getMailboxSOCKS5Addr, makeReader }) {
  if (process.env.NODE_ENV !== 'production' && process.env.DISABLE_IMAP_CRON !== '0') {
    console.log('[cron] runFolderOperationsCron SKIPPED (NODE_ENV != production)')
    return
  }
  const { missingFolders } = await import('../lib/humanBehaviorSimulation.js')

  const { rows } = await pool.query(
    `SELECT id, imap_host, imap_port, imap_username, smtp_username, password, preferred_country
     FROM outreach_mailboxes
     WHERE status NOT IN ('retired', 'auth_locked')
       AND environment = 'production'
       AND imap_host IS NOT NULL`
  )

  let operated = 0
  for (const mb of rows) {
    let comm = null
    let reader = null
    try {
      const socksAddr = await getMailboxSOCKS5Addr(mb)
      const port = Number(mb.imap_port) || 993
      const username = mb.imap_username || mb.smtp_username

      comm = await dialIMAPViaSOCKS5(socksAddr, mb.imap_host, port)
      reader = makeReader(comm)

      await reader.readLine(5000, 'fo-greeting')

      const qUser = `"${username.replace(/"/g, '\\"')}"`
      const qPass = `"${mb.password.replace(/"/g, '\\"')}"`
      comm.write(`G1 LOGIN ${qUser} ${qPass}\r\n`)
      const authLine = await reader.readLine(6000, 'fo-auth')
      if (!authLine.startsWith('G1 OK')) throw new Error('fo auth failed')

      // LIST all existing folders
      comm.write('G2 LIST "" "*"\r\n')
      let listResp = ''
      for (let i = 0; i < 30; i++) {
        const l = await reader.readLine(3000, 'fo-list')
        listResp += l + '\n'
        if (l.startsWith('G2 ')) break
      }
      const folderMatches = [...listResp.matchAll(/\* LIST[^"]*"([^"]+)"/g)]
      const existingFolders = folderMatches.map(fm => fm[1])

      // Optional SELECT on a random existing folder (human-like navigation)
      if (existingFolders.length > 0) {
        const pick = existingFolders[Math.floor(Math.random() * existingFolders.length)]
        comm.write(`G3 SELECT "${pick.replace(/"/g, '\\"')}"\r\n`)
        for (let i = 0; i < 10; i++) {
          const l = await reader.readLine(3000, 'fo-nav')
          if (l.startsWith('G3 ')) break
        }
      }

      // CREATE missing standard folders (idempotent — returns OK if already exists)
      const toCreate = missingFolders(existingFolders)
      let tag = 4
      for (const folder of toCreate) {
        comm.write(`G${tag} CREATE "${folder}"\r\n`)
        await reader.readLine(3000, `fo-create-${folder}`).catch(() => {})
        console.log(`[fo] mailbox=${mb.id} CREATE "${folder}"`)
        tag++
      }

      comm.write(`G${tag} LOGOUT\r\n`)
      await reader.readLine(3000, 'fo-logout').catch(() => {})
      operated++
    } catch (e) {
      console.warn(`[fo] mailbox=${mb.id} error: ${e.message}`)
    } finally {
      try { reader?.detach() } catch {}
      try { comm?.destroy() } catch {}
    }
  }
  console.log(`[cron] runFolderOperationsCron done — operated=${operated}/${rows.length} mailboxes`)
}
