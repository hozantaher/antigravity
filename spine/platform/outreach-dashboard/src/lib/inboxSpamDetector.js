/**
 * Inbox vs. spam placement detection.
 *
 * Since direct IMAP inspection from BFF is not available as a library,
 * placement is inferred from observable send_events signals:
 *   - opened_at / clicked_at   → landed in inbox (user saw the mail)
 *   - bounce_type 'complaint'  → spam folder (FBL complaint)
 *   - status 'bounced'         → delivery failure (not inbox, not spam)
 *   - >72h old, no engagement  → likely_spam (heuristic)
 *   - otherwise                → unknown (too early or no signal)
 *
 * For real IMAP checks, delegate to the BFF endpoint
 * /api/mailboxes/:id/imap-check when it becomes available.
 */

/**
 * Checks if a recently sent email landed in inbox vs spam.
 * Currently returns 'unknown' — real IMAP support requires a future
 * BFF /api/mailboxes/:id/imap-check endpoint.
 *
 * @param {object}  imapConfig  IMAP connection config (reserved for future use)
 * @param {string}  messageId   Message-ID header value
 * @param {number}  [timeoutMs] Timeout in ms (default 30000)
 * @returns {Promise<{result: 'inbox'|'spam'|'unknown', folder: string|null, ms: number}>}
 */
export async function checkInboxPlacement(_imapConfig, _messageId, _timeoutMs = 30000) {
  const start = Date.now()
  // IMAP inspection not yet available — use inferPlacementFromSignals instead
  return { result: 'unknown', folder: null, ms: Date.now() - start }
}

/**
 * Infers inbox placement from observable send_event signals.
 *
 * Priority order (first match wins):
 *   1. complaint bounce      → 'spam'
 *   2. any bounce            → 'bounced'
 *   3. has opened_at         → 'inbox'
 *   4. has clicked_at        → 'inbox'
 *   5. age > 72h, no engage  → 'likely_spam'
 *   6. otherwise             → 'unknown'
 *
 * @param {object|null} sendEvent  Row from send_events (may include opened_at, clicked_at, bounce_type, status, sent_at)
 * @returns {'inbox'|'spam'|'bounced'|'likely_spam'|'unknown'}
 */
export function inferPlacementFromSignals(sendEvent) {
  if (!sendEvent) return 'unknown'

  // FBL complaint → spam folder
  if (sendEvent.bounce_type === 'complaint') return 'spam'

  // Hard/soft bounce → neither inbox nor spam
  if (sendEvent.status === 'bounced') return 'bounced'

  // Engagement proves inbox delivery
  if (sendEvent.opened_at) return 'inbox'
  if (sendEvent.clicked_at) return 'inbox'

  // Heuristic: 72h silence on a delivered mail → probable spam
  if (sendEvent.sent_at && sendEvent.status === 'sent') {
    const sentAt = new Date(sendEvent.sent_at)
    if (!isNaN(sentAt.getTime())) {
      const ageH = (Date.now() - sentAt.getTime()) / (1000 * 60 * 60)
      if (ageH > 72) return 'likely_spam'
    }
  }

  return 'unknown'
}

/**
 * Aggregates placement statistics across all send events for a campaign.
 *
 * @param {object[]|null} sendEvents  Array of send_event rows
 * @returns {{
 *   inbox: number,
 *   spam: number,
 *   likely_spam: number,
 *   bounced: number,
 *   unknown: number,
 *   total: number,
 *   inbox_rate: number|null
 * }}
 */
export function aggregatePlacementStats(sendEvents) {
  const counts = { inbox: 0, spam: 0, likely_spam: 0, bounced: 0, unknown: 0 }
  for (const e of (sendEvents || [])) {
    const placement = inferPlacementFromSignals(e)
    counts[placement] = (counts[placement] ?? 0) + 1
  }
  const total = sendEvents?.length ?? 0
  const inbox_rate = total > 0 ? counts.inbox / total : null
  return { ...counts, total, inbox_rate }
}
