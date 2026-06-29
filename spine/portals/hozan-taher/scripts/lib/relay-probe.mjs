// scripts/lib/relay-probe.mjs
// Helper for posting an SMTP AUTH probe to the anti-trace-relay /v1/probe.
//
// Mirrors the calling convention used by apps/outreach-dashboard/src/lib/
// relayClient.js (relaySmtpCheck) and the relay's request schema in
// services/relay/web/probe.go (`probeRequest`).
//
// REQUIRED:
//   - Authorization: Bearer ${ANTI_TRACE_RELAY_TOKEN} header — relay's
//     requireActor() rejects unauthenticated probes with HTTP 401.
//   - Body shape: { smtp_host, smtp_port, smtp_username, password }.
//     `mailbox` is NOT a field the relay accepts (the previous
//     verify-launch.mjs Gate 3 sent `{ mailbox }` and got 400/401 every run).

/**
 * @typedef {{ id?: number|string, from_address?: string, smtp_host: string, smtp_port: number|string, smtp_username: string, password: string }} MailboxRow
 */

/**
 * @typedef {{ ok: boolean, status: number, body: any, error: string|null }} ProbeResult
 */

/**
 * Posts a single SMTP AUTH probe to the relay.
 *
 * @param {object} opts
 * @param {string} opts.relayBase   — e.g. "https://relay.example.com"
 * @param {string} opts.token       — bearer token (empty = no auth header, dev only)
 * @param {MailboxRow} opts.mailbox — DB row with smtp_host/smtp_port/smtp_username/password
 * @param {number} [opts.timeoutMs] — abort after N ms (default 15s)
 * @param {typeof fetch} [opts.fetchImpl] — injection point for tests
 * @returns {Promise<ProbeResult>}
 */
export async function probeMailboxViaRelay({ relayBase, token, mailbox, timeoutMs = 15_000, fetchImpl = globalThis.fetch }) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const body = JSON.stringify({
    smtp_host: mailbox.smtp_host,
    smtp_port: Number(mailbox.smtp_port),
    smtp_username: mailbox.smtp_username,
    password: mailbox.password,
  })

  try {
    const res = await fetchImpl(`${relayBase.replace(/\/+$/, '')}/v1/probe`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, body: null, error: `HTTP ${res.status} — ${text.slice(0, 120)}` }
    }
    const json = await res.json().catch(() => null)
    const smtpOk = json?.checks?.smtp?.ok === true
    if (!smtpOk) {
      const reason = json?.checks?.smtp?.error || 'AUTH probe returned ok=false'
      return { ok: false, status: res.status, body: json, error: reason }
    }
    return { ok: true, status: res.status, body: json, error: null }
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e?.message || String(e) }
  }
}
