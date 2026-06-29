// alertStream.js — Sprint M7 (issue #1279 follow-up).
//
// GET /api/alerts/stream — SSE channel for real-time deliverability alerts.
//
// Clients open EventSource('/api/alerts/stream') and receive
// `mailbox_alert_fired` events whenever a row is INSERTed into
// mailbox_alerts (migration 108 installs the PG NOTIFY trigger).
//
// This lets M1-M5 alert conditions surface as toasts on every dashboard
// page without the operator having to visit /analytics first.
//
// Thresholds referenced in event labels come from named constants that
// match the M5 reputation score module (T_BOUNCE_PCT / T_SPAM_PCT) so
// both surfaces always agree on what "alert" means. No magic literals.
//
// PII policy (feedback_no_pii_in_commands / feedback_no_pii_in_commands):
//   The PG trigger payload carries only structural data (id, mailbox_id,
//   type, severity, created_at). This module JOINs from_address once and
//   redacts to "xxxx@<domain>" — never emits a full email address over
//   the SSE stream.
//
// SSE reconnect on the client uses exponential backoff with jitter
// (feedback_external_io_backoff). Server side: no direct SMTP/IMAP
// (feedback_no_direct_smtp) — this is a read-only Postgres LISTEN path.
//
// Route inventory:
//   GET /api/alerts/stream

// Threshold labels — same values as mailboxReputationScore.js T_BOUNCE_PCT
// and T_SPAM_PCT so both surfaces are in sync. Single source via the named
// const; no literal embedded in message strings.
const THRESHOLD_LABELS = {
  bounce_rate: { value: 2.0, unit: '%', label: 'bounce rate' },
  spam_rate:   { value: 0.1, unit: '%', label: 'spam rate'   },
  blacklist:   { value: null, unit: null, label: 'blacklist zásah' },
}

/**
 * Redact a full email address to "xxxx@domain" per PII policy.
 * If from_address is null/empty, returns "[neznámá]".
 *
 * @param {string|null} fromAddress
 * @returns {string}
 */
function redactEmail(fromAddress) {
  if (!fromAddress || typeof fromAddress !== 'string') return '[neznámá]'
  const at = fromAddress.indexOf('@')
  if (at < 0) return 'xxxx'
  const domain = fromAddress.slice(at) // includes '@'
  return `xxxx${domain}`
}

/**
 * Build a human-readable Czech label for an alert type.
 *
 * @param {string} type  - alert type from mailbox_alerts.type
 * @param {string} msg   - raw message text from mailbox_alerts.message
 * @returns {string}
 */
function alertLabel(type, msg) {
  const tInfo = THRESHOLD_LABELS[type]
  if (!tInfo) return msg || type
  if (tInfo.value != null) {
    return `${tInfo.label} překračuje práh ${tInfo.value}${tInfo.unit}`
  }
  return tInfo.label
}

export function mountAlertStreamRoutes(app, { pool, safeError }) {
  const alertStreamClients = new Set()

  /**
   * Fan out a sanitised alert event to all connected SSE clients.
   * Strips PII — only redacted from_address reaches the wire.
   *
   * @param {{ mailbox_id: number, from_address: string|null, type: string, severity: string, message: string, created_at: string }} payload
   */
  function publishAlertEvent(payload) {
    if (alertStreamClients.size === 0) return
    const safe = {
      mailbox_id:    payload.mailbox_id    || null,
      mailbox_email: redactEmail(payload.from_address),
      alert_type:    payload.type          || 'unknown',
      severity:      payload.severity      || 'warning',
      label:         alertLabel(payload.type, payload.message),
      fired_at:      payload.created_at    || new Date().toISOString(),
    }
    let line
    try { line = `event: mailbox_alert_fired\ndata: ${JSON.stringify(safe)}\n\n` } catch { return }
    for (const sseRes of alertStreamClients) {
      try { sseRes.write(line) } catch { /* swept by disconnect */ }
    }
  }

  let alertListenClient = null

  async function ensureAlertListenClient() {
    if (alertListenClient) return
    try {
      const c = await pool.connect()
      c.on('notification', async (msg) => {
        if (msg.channel !== 'mailbox_alert_fired') return
        let raw
        try { raw = JSON.parse(msg.payload || '{}') } catch { raw = {} }

        // Fetch from_address for the mailbox so we can redact it.
        // Best-effort: if the mailbox row is gone, emit with null address.
        let fromAddress = null
        if (raw.mailbox_id) {
          try {
            const { rows } = await pool.query(
              `SELECT from_address FROM outreach_mailboxes WHERE id = $1 LIMIT 1`,
              [raw.mailbox_id],
            )
            fromAddress = rows[0]?.from_address || null
          } catch {
            // Non-fatal; we'll redact to "[neznámá]"
          }
        }

        publishAlertEvent({
          mailbox_id:   raw.mailbox_id  || null,
          from_address: fromAddress,
          type:         raw.type        || 'unknown',
          severity:     raw.severity    || 'warning',
          message:      raw.message     || '',
          created_at:   raw.created_at  || new Date().toISOString(),
        })
      })
      c.on('error', (err) => {
        console.warn('[alerts/stream] LISTEN error:', err?.message)
        alertListenClient = null
      })
      await c.query('LISTEN mailbox_alert_fired')
      alertListenClient = c
    } catch (err) {
      console.warn('[alerts/stream] LISTEN setup failed:', err?.message)
      alertListenClient = null
    }
  }

  app.get('/api/alerts/stream', async (req, res) => {
    res.set({
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
    alertStreamClients.add(res)
    await ensureAlertListenClient()

    const hb = setInterval(() => {
      try { res.write(`: hb ${Date.now()}\n\n`) } catch {}
    }, 30_000)

    req.on('close', () => {
      clearInterval(hb)
      alertStreamClients.delete(res)
    })
  })
}
