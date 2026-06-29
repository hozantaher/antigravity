/**
 * runHumanBehaviorSimulationCron — AR10: simulate human IMAP actions on 30% of mailboxes.
 *
 * HARD (feedback_no_direct_smtp): all IMAP connections via SOCKS5 wgpool.
 * HARD (feedback_no_external_services): reply text from static pool, no LLM.
 * HARD (feedback_no_pii_in_commands): mailbox emails not logged inline.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.dialIMAPViaSOCKS5    — server.js-local async helper
 *   @param {Function} deps.getMailboxSOCKS5Addr — server.js-local async helper
 *   @param {Function} deps.makeReader            — server.js-local helper
 */
export async function runHumanBehaviorSimulationCron(pool, { dialIMAPViaSOCKS5, getMailboxSOCKS5Addr, makeReader }) {
  if (process.env.NODE_ENV !== 'production' && process.env.DISABLE_IMAP_CRON !== '0') {
    console.log('[cron] runHumanBehaviorSimulationCron SKIPPED (NODE_ENV != production)')
    return
  }
  const { pickGenericReply, generateDraftBody, sampleMessageAction, shouldProcessMailbox } =
    await import('../lib/humanBehaviorSimulation.js')

  const { rows } = await pool.query(
    `SELECT id, imap_host, imap_port, imap_username, smtp_username, password, preferred_country
     FROM outreach_mailboxes
     WHERE status NOT IN ('retired', 'auth_locked')
       AND environment = 'production'
       AND imap_host IS NOT NULL`
  )

  let processed = 0
  for (const mb of rows) {
    if (!shouldProcessMailbox(Math.random())) continue

    let comm = null
    let reader = null
    try {
      const socksAddr = await getMailboxSOCKS5Addr(mb)
      const port = Number(mb.imap_port) || 993
      const username = mb.imap_username || mb.smtp_username

      comm = await dialIMAPViaSOCKS5(socksAddr, mb.imap_host, port)
      reader = makeReader(comm)

      // Greeting
      await reader.readLine(5000, 'hbs-greeting')

      // LOGIN
      const qUser = `"${username.replace(/"/g, '\\"')}"`
      const qPass = `"${mb.password.replace(/"/g, '\\"')}"`
      comm.write(`H1 LOGIN ${qUser} ${qPass}\r\n`)
      const authLine = await reader.readLine(6000, 'hbs-auth')
      if (!authLine.startsWith('H1 OK')) throw new Error('hbs auth failed')

      // SELECT INBOX
      comm.write('H2 SELECT INBOX\r\n')
      for (let i = 0; i < 10; i++) {
        const l = await reader.readLine(3000, 'hbs-sel')
        if (l.startsWith('H2 ')) break
      }

      // UID SEARCH UNSEEN — work in UID space so targets can be compared
      // against the poll watermark (mailbox_imap_state.last_processed_uid is a UID).
      comm.write('H3 UID SEARCH UNSEEN\r\n')
      let searchResp = ''
      for (let i = 0; i < 5; i++) {
        const l = await reader.readLine(5000, 'hbs-srch')
        searchResp += l + '\n'
        if (l.startsWith('H3 ')) break
      }
      const m = searchResp.match(/\* SEARCH([\d\s]*)\r?\n/)
      const rawUnseenUids = m
        ? m[1].trim().split(/\s+/).map(Number).filter(uid => Number.isFinite(uid) && uid > 0)
        : []

      // Restrict sim mutations to ALREADY-INGESTED messages (UID ≤ the poll
      // watermark). Mutating an un-ingested reply (UID above the watermark) can
      // lose it — reply ingestion is UID-watermark based. With watermark 0 / no
      // state row this is empty, so we touch nothing until the poll cron has
      // ingested at least once.
      let unseenUids = []
      if (rawUnseenUids.length > 0) {
        const { rows: stateRows } = await pool.query(
          `SELECT last_processed_uid FROM mailbox_imap_state WHERE mailbox_id=$1`,
          [mb.id]
        )
        const ingestedWatermarkUid = Number(stateRows[0]?.last_processed_uid) || 0
        unseenUids = rawUnseenUids.filter(uid => uid <= ingestedWatermarkUid)
      }

      if (unseenUids.length > 0) {
        const target = unseenUids[Math.floor(Math.random() * unseenUids.length)]
        const action = sampleMessageAction(Math.random())

        if (action === 'mark_read') {
          comm.write(`H4 UID STORE ${target} +FLAGS (\\Seen)\r\n`)
          await reader.readLine(3000, 'hbs-store')
          console.log(`[hbs] mailbox=${mb.id} → mark_read uid=${target}`)
        } else if (action === 'reply') {
          // Generic reply appended to INBOX as Seen — simulates sent-reply without
          // opening an SMTP connection (APPEND puts it in Sent folder-semantics via INBOX).
          // HARD: never routes through SMTP path.
          const replyText = pickGenericReply()
          const msgBody = [
            `From: ${username}`,
            `To: noreply@seznam.cz`,
            `Subject: Re: ...`,
            `Date: ${new Date().toUTCString()}`,
            ``,
            replyText,
          ].join('\r\n')
          const octetLen = Buffer.byteLength(msgBody, 'utf8')
          comm.write(`H4 APPEND "Sent" (\\Seen) {${octetLen}}\r\n`)
          // Wait for continuation prompt '+'
          for (let i = 0; i < 3; i++) {
            const l = await reader.readLine(3000, 'hbs-append-cont')
            if (l.startsWith('+')) break
          }
          comm.write(msgBody + '\r\n')
          await reader.readLine(5000, 'hbs-append-ok')
          console.log(`[hbs] mailbox=${mb.id} → reply_appended`)
        } else if (action === 'archive') {
          // Never EXPUNGE the INBOX: EXPUNGE permanently removes messages and
          // would lose any reply not yet ingested. COPY to Archive + mark \Seen
          // only — a human-plausible "archived + read" action that destroys
          // nothing (target is already ≤ the poll watermark, but the no-EXPUNGE
          // rule is an absolute safety net regardless).
          comm.write(`H4 UID COPY ${target} Archive\r\n`)
          await reader.readLine(3000, 'hbs-copy')
          comm.write(`H5 UID STORE ${target} +FLAGS (\\Seen)\r\n`)
          await reader.readLine(3000, 'hbs-archive-store')
          console.log(`[hbs] mailbox=${mb.id} → archive uid=${target}`)
        } else if (action === 'draft') {
          const draftBody = generateDraftBody()
          const msgBody = [
            `From: ${username}`,
            `Subject: Draft`,
            `Date: ${new Date().toUTCString()}`,
            ``,
            draftBody,
          ].join('\r\n')
          const octetLen = Buffer.byteLength(msgBody, 'utf8')
          comm.write(`H4 APPEND "Drafts" (\\Draft) {${octetLen}}\r\n`)
          for (let i = 0; i < 3; i++) {
            const l = await reader.readLine(3000, 'hbs-draft-cont')
            if (l.startsWith('+')) break
          }
          comm.write(msgBody + '\r\n')
          await reader.readLine(5000, 'hbs-draft-ok')
          console.log(`[hbs] mailbox=${mb.id} → draft_appended`)
        }
        // action === 'noop' → do nothing
      }

      // Random folder navigation (LIST + SELECT a random folder)
      comm.write('H7 LIST "" "*"\r\n')
      let listResp = ''
      for (let i = 0; i < 20; i++) {
        const l = await reader.readLine(3000, 'hbs-list')
        listResp += l + '\n'
        if (l.startsWith('H7 ')) break
      }
      const folderMatches = [...listResp.matchAll(/\* LIST[^"]*"([^"]+)"/g)]
      if (folderMatches.length > 0) {
        const pick = folderMatches[Math.floor(Math.random() * folderMatches.length)][1]
        comm.write(`H8 SELECT "${pick.replace(/"/g, '\\"')}"\r\n`)
        for (let i = 0; i < 10; i++) {
          const l = await reader.readLine(3000, 'hbs-nav-sel')
          if (l.startsWith('H8 ')) break
        }
      }

      comm.write('H9 LOGOUT\r\n')
      await reader.readLine(3000, 'hbs-logout').catch(() => {})

      processed++
    } catch (e) {
      console.warn(`[hbs] mailbox=${mb.id} error: ${e.message}`)
    } finally {
      try { reader?.detach() } catch {}
      try { comm?.destroy() } catch {}
    }
  }
  console.log(`[cron] runHumanBehaviorSimulationCron done — processed=${processed}/${rows.length} mailboxes`)
}
