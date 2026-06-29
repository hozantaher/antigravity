// Thin HTTP client for the anti-trace-relay service (SMTP-EGRESS-LOCKDOWN R5).
// The BFF no longer dials SMTP/IMAP/SOCKS5 directly — every network-probe
// helper (smtpCheck, smtpAuthProbe, socks5Probe, proxy-pool lookups) is a
// forward to relay endpoints exposed in services/anti-trace-relay/internal/httpapi.
//
// Config resolution order (first hit wins):
//   1. process.env.ANTI_TRACE_RELAY_URL_OVERRIDE (dev escape hatch — beats
//      stale DB values; fixes pingAntiTrace false-red when the DB still
//      holds an old relay URL but the developer pointed env at localhost)
//   2. outreach_config.anti_trace_url in DB (production source of truth)
//   3. process.env.ANTI_TRACE_RELAY_URL (legacy fallback)
//
// Bearer token: process.env.ANTI_TRACE_RELAY_TOKEN (required when relay auth
// is enabled; harmless in dev when relay allows anonymous).

function stripTrailingSlashes(url) {
  return url ? url.replace(/\/+$/, '') : null
}

export async function getRelayBase(pool) {
  const override = process.env.ANTI_TRACE_RELAY_URL_OVERRIDE
  if (override) return stripTrailingSlashes(override)
  if (pool && typeof pool.query === 'function') {
    try {
      const { rows } = await pool.query(
        "SELECT value FROM outreach_config WHERE key='anti_trace_url'"
      )
      const dbUrl = rows[0]?.value
      if (dbUrl) return stripTrailingSlashes(dbUrl)
    } catch {
      // Fall through to env var.
    }
  }
  return stripTrailingSlashes(process.env.ANTI_TRACE_RELAY_URL)
}

export async function relayFetch(pool, path, { method = 'GET', body = null, timeoutMs = 30_000 } = {}) {
  const base = await getRelayBase(pool)
  if (!base) {
    return { ok: false, status: 0, error: 'relay_not_configured', body: null }
  }
  const token = process.env.ANTI_TRACE_RELAY_TOKEN || ''
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  try {
    const res = await fetch(base + path, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { ok: res.ok, status: res.status, body: json, error: res.ok ? null : (json?.error || `status ${res.status}`) }
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e.message || String(e) }
  }
}

// ─── Forward helpers with return shapes matching the old BFF-local probes ───

// Drop-in replacement for the old smtpCheck(host, port, user, pass) helper.
// Returns { ok, ms, steps: [{name, ok, ms, msg}] } — same shape the UI already
// consumes from /api/mailboxes/:id/full-check.
//
// Sprint AO3: pass mailboxId + preferredCountry so relay routes probe via the
// same wgPool endpoint as drain — eliminates multi-country signal for fraud detection.
export async function relaySmtpCheck(pool, host, port, username, password, { mailboxId = '', preferredCountry = '' } = {}) {
  const start = Date.now()
  // Use /v1/probe with up to 3 retries on socks5 proxy connectivity failures.
  // Some proxies in the pool can TLS-handshake to port 465 (probe target) but
  // fail on port 587 (STARTTLS) — relay auto-rotates on the next call.
  const MAX_RETRIES = 3
  let lastResult = null
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const probeBody = { smtp_host: host, smtp_port: Number(port), smtp_username: username, password }
    if (mailboxId) probeBody.mailbox_id = mailboxId
    if (preferredCountry) probeBody.preferred_country = preferredCountry
    const { ok, body, error } = await relayFetch(pool, '/v1/probe', {
      method: 'POST',
      body: probeBody,
      timeoutMs: 30_000,
    })
    if (!ok) {
      lastResult = { ok: false, ms: Date.now() - start, steps: [{ name: 'relay', ok: false, ms: Date.now() - start, msg: error }] }
      break
    }
    const smtpChecks = body?.checks?.smtp ?? body
    const smtpOk = smtpChecks?.ok === true
    const steps = Array.isArray(smtpChecks?.steps) ? smtpChecks.steps.filter(Boolean) : []
    // Retry only on proxy connectivity failures (socks5 errors), not AUTH failures
    const isProxyFail = !smtpOk && steps.some(s => s?.name === 'socks_dial' && !s.ok)
    lastResult = { ok: smtpOk, ms: smtpChecks?.ms ?? (Date.now() - start), steps }
    if (smtpOk || !isProxyFail) break
  }
  return lastResult
}

// Drop-in replacement for smtpAuthProbe(proxyAddr, host, port, user, pass).
// Returns { ok, ms, reason? }.
export async function relaySmtpAuthProbe(pool, proxyAddr, host, port, username, password) {
  const start = Date.now()
  const { ok, body, error } = await relayFetch(pool, '/v1/auth-check', {
    method: 'POST',
    body: {
      smtp_host: host, smtp_port: Number(port),
      smtp_username: username, password,
      proxy_addr: proxyAddr,
    },
    timeoutMs: 25_000,
  })
  if (!ok) return { ok: false, ms: Date.now() - start, reason: error }
  return {
    ok: body?.ok === true,
    ms: body?.ms ?? (Date.now() - start),
    reason: body?.error || null,
  }
}

// Sprint AO3: relay-backed IMAP credential check via /v1/probe.
// Passes mailboxId + preferredCountry so relay routes via wgPool — same path as drain.
// Returns { ok, ms, steps: [{name, ok, ms, msg}] }
export async function relayImapCheck(pool, smtpHost, smtpPort, imapHost, imapPort, username, password, { mailboxId = '', preferredCountry = '' } = {}) {
  const start = Date.now()
  const probeBody = {
    smtp_host: smtpHost, smtp_port: Number(smtpPort),
    smtp_username: username, password,
    imap_host: imapHost, imap_port: Number(imapPort),
    imap_username: username,
  }
  if (mailboxId) probeBody.mailbox_id = mailboxId
  if (preferredCountry) probeBody.preferred_country = preferredCountry
  const { ok, body, error } = await relayFetch(pool, '/v1/probe', {
    method: 'POST',
    body: probeBody,
    timeoutMs: 30_000,
  })
  if (!ok) {
    return { ok: false, ms: Date.now() - start, steps: [{ name: 'relay', ok: false, ms: Date.now() - start, msg: error }] }
  }
  const imapChecks = body?.checks?.imap
  if (!imapChecks) {
    // Relay didn't run IMAP probe (imap fields missing or not implemented).
    return { ok: false, ms: Date.now() - start, steps: [], error: 'imap check not returned by relay' }
  }
  const imapOk = imapChecks?.ok === true
  const steps = Array.isArray(imapChecks?.steps) ? imapChecks.steps.filter(Boolean) : []
  return { ok: imapOk, ms: imapChecks?.ms ?? (Date.now() - start), steps }
}

// Drop-in replacement for socks5Probe(proxyHost, proxyPort, timeoutMs, targetHost, targetPort).
// Uses relay's /v1/auth-check in liveness mode (no creds — relay will attempt
// SOCKS handshake and report ok/ms from the `socks_dial` step).
export async function relaySocks5Probe(pool, proxyHost, proxyPort, timeoutMs = 6000, targetHost = 'smtp.seznam.cz', targetPort = 465) {
  const start = Date.now()
  const { ok, body, error } = await relayFetch(pool, '/v1/auth-check', {
    method: 'POST',
    body: {
      smtp_host: targetHost, smtp_port: Number(targetPort),
      // Dummy creds — we only care that the SOCKS dial succeeds. Auth will
      // fail, but the socks_dial step result is what we report.
      smtp_username: 'probe@probe.invalid', password: 'probe',
      proxy_addr: `${proxyHost}:${proxyPort}`,
    },
    timeoutMs: timeoutMs + 2000,
  })
  if (!ok) return { ok: false, ms: Date.now() - start }
  const dialStep = (body?.steps || []).find(s => s.name === 'socks_dial')
  if (dialStep) return { ok: dialStep.ok === true, ms: dialStep.ms ?? (Date.now() - start) }
  return { ok: body?.ok === true, ms: body?.ms ?? (Date.now() - start) }
}

// GET /v1/imap-socks-addr — Sprint AO1: returns the SOCKS5 addr to use for IMAP dial.
// preferred_country is the mailbox.preferred_country value (e.g. "CZ", "SK", or "" for any).
// Returns { socks_addr, country, label } on success, null on failure.
export async function relayImapSocksAddr(pool, preferredCountry = '') {
  const qs = preferredCountry ? `?preferred_country=${encodeURIComponent(preferredCountry)}` : ''
  const { ok, body } = await relayFetch(pool, `/v1/imap-socks-addr${qs}`, { timeoutMs: 5000 })
  if (!ok || !body?.socks_addr) return null
  return { socks_addr: body.socks_addr, country: body.country || '', label: body.label || 'single' }
}

// POST /v1/imap-fetch — 2026-05-12: relay-side IMAP UNSEEN + UID FETCH wrapper.
//
// Why: wgsocks bind 127.0.0.1:108x INSIDE the relay container, so BFF dial
// of that addr from the outreach-dashboard service fails ECONNREFUSED
// (memory project_bff_imap_cross_service_broken). The HTTP wrapper runs
// the IMAP poll INSIDE relay where wgsocks listens; BFF receives parsed
// headers via HTTP.
//
// Returns { ok, uid_validity, unseen_total, messages, egress_label } on
// success, { ok:false, error, uid_validity, unseen_total } on relay-side
// failure (partial state when SELECT succeeded but FETCH/SEARCH failed),
// null on transport/auth failure (relayFetch threw).
//
// `params` carries the inline IMAP creds + UID watermark:
//   { mailbox_address, imap_host, imap_port, username, password,
//     folder='INBOX', since_uid=0, limit=50, preferred_country='CZ' }
export async function relayImapFetch(pool, params) {
  const body = {
    mailbox_address:   params.mailboxAddress || '',
    imap_host:         params.imapHost,
    imap_port:         Number(params.imapPort) || 993,
    username:          params.username,
    password:          params.password,
    folder:            params.folder || 'INBOX',
    since_uid:         Number(params.sinceUid) || 0,
    limit:             Number(params.limit) || 50,
    preferred_country: params.preferredCountry || '',
    // include_body=true asks relay to also return RawBody (RFC 5322
    // bytes) per message so caller can MIME-parse + extract
    // attachments. Heavy (50-500 KB per msg). When false, only header
    // envelope is returned. Server caps limit at 30 when true.
    include_body:      params.includeBody === true,
  }
  // 120s timeout — relay-side IMAP poll caps at 90s (90s ctx + 30s
  // overhead) so the client deadline must comfortably exceed that.
  const res = await relayFetch(pool, '/v1/imap-fetch', {
    method:    'POST',
    body,
    timeoutMs: 120_000,
  })
  if (!res.ok) return { ok: false, error: res.error || 'relay HTTP error', unseen_total: 0, messages: [] }
  if (res.body?.ok === false) {
    return {
      ok:           false,
      error:        res.body.error || 'relay reported failure',
      uid_validity: res.body.uid_validity || 0,
      unseen_total: res.body.unseen_total || 0,
      messages:     [],
    }
  }
  return {
    ok:           true,
    uid_validity: res.body?.uid_validity || 0,
    unseen_total: res.body?.unseen_total || 0,
    messages:     Array.isArray(res.body?.messages) ? res.body.messages : [],
    egress_label: res.body?.egress_label || '',
  }
}

// GET /v1/proxy-pool — returns pool snapshot shaped like the old BFF cache.
// UI expects { mode, working: [{addr, country?, source?, probe_ms?, last_latency_ms?}], cz_working, eu_working, neighbour_working, cached_at }.
//
// `mode` mirrors the relay's egress architecture and is either:
//   "rotating-pool" — Working[] is the live pool
//   "mullvad"       — single hop via wireproxy → Mullvad WG; Working[] empty by design
//   "none"          — neither configured (relay misconfigured)
export async function relayProxyPool(pool) {
  const { ok, body, error } = await relayFetch(pool, '/v1/proxy-pool', { timeoutMs: 5000 })
  if (!ok) {
    return {
      mode: 'unknown',
      working: [],
      cz_working: 0, eu_working: 0, neighbour_working: 0,
      cached_at: new Date().toISOString(),
      total_candidates: 0, probed: 0,
      auth_validated: 0, quality_score: 0,
      error,
    }
  }
  const mode = body?.mode || 'rotating-pool'
  const raw = Array.isArray(body?.working) ? body.working : []
  const working = raw.map(e => ({
    addr: e.addr,
    country: e.country || 'ZZ',
    source: e.source || 'relay',
    probe_ms: e.latency_ms ?? null,
    last_latency_ms: e.latency_ms ?? null,
    last_probed_at: body?.last_refresh || null,
  }))
  const cz_working = working.filter(p => p.country === 'CZ').length
  const neighbour_working = working.filter(p => ['CZ', 'SK', 'PL', 'AT', 'DE', 'HU'].includes(p.country)).length
  const auth_validated = raw.filter(e => e.auth_valid === true).length
  const quality_score = working.length > 0 ? Math.round(auth_validated / working.length * 100) : 0
  return {
    mode,
    working,
    cz_working,
    eu_working: working.length,
    neighbour_working,
    cached_at: body?.last_refresh || new Date().toISOString(),
    total_candidates: body?.count ?? working.length,
    probed: working.length,
    auth_validated,
    quality_score,
    // wg-pool diagnostics (relay reports these only in wgpool mode).
    // Pass through so UI can render "N/M endpointů aktivní" instead of
    // falling back to "Všechny endpointy quarantined" when active_endpoints
    // field is undefined (Mailboxes.jsx ppActiveEndpoints derivation).
    pool_size: body?.pool_size,
    active_endpoints: body?.active_endpoints,
    endpoints: Array.isArray(body?.endpoints) ? body.endpoints : undefined,
    empty_pool_critical: body?.empty_pool_critical,
    consecutive_zero_refreshes: body?.consecutive_zero_refreshes,
  }
}
