// ── Pure utility functions for Mailboxes ──────────────────────────
// No React, no side-effects — safe to unit test in isolation.

const NUMERIC_SORT_KEYS = new Set([
  'daily_limit', 'total_sent', 'total_bounced',
  'consecutive_bounces', 'warmup_day', 'port', 'imap_port',
])

/**
 * Security score 0–6.
 * proxy_url  +2, imap_host +1, SMTPS(465) +2 / STARTTLS(587) +1, antiTraceOk=true +1
 */
export function score(mb, antiTraceOk) {
  let s = 0
  if (mb.proxy_url)            s += 2
  if (mb.imap_host)            s += 1
  if (Number(mb.port) === 465) s += 2
  else if (Number(mb.port) === 587) s += 1
  if (antiTraceOk === true)    s += 1
  return s
}

/**
 * Sort mailboxes by key and direction.
 * Numeric fields are compared as numbers to avoid "10" < "2" bugs.
 */
export function sortMailboxes(mailboxes, sortKey, sortDir) {
  return [...mailboxes].sort((a, b) => {
    let av = a[sortKey] ?? 0
    let bv = b[sortKey] ?? 0
    if (NUMERIC_SORT_KEYS.has(sortKey)) {
      av = Number(av) || 0
      bv = Number(bv) || 0
    } else {
      av = String(av ?? '').toLowerCase()
      bv = String(bv ?? '').toLowerCase()
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return sortDir === 'asc' ? cmp : -cmp
  })
}

/**
 * Returns bounce rate as a fixed-1 string ("10.0") or null when total_sent=0.
 */
export function getBounceRate(total_sent, total_bounced) {
  const ts = Number(total_sent || 0)
  const tb = Number(total_bounced || 0)
  if (ts === 0) return null
  return ((tb / ts) * 100).toFixed(1)
}

/** Relative/absolute date label in Czech. */
export const fmtDate = iso => {
  if (!iso) return '—'
  const d = Math.floor((Date.now() - new Date(iso)) / 60000)
  if (d < 2)     return 'právě teď'
  if (d < 60)    return `před ${d} min`
  if (d < 1440)  return `před ${Math.floor(d / 60)} hod`
  if (d < 10080) return `před ${Math.floor(d / 1440)} dny`
  return new Date(iso).toLocaleDateString('cs-CZ')
}

/** Localized integer (Czech thousands separator). */
export const fmtNum = n => Number(n || 0).toLocaleString('cs-CZ')

/**
 * Builds an RFC 2822 Date header string in the given IANA timezone,
 * with the explicit UTC offset (e.g. +0200 for CEST, +0100 for CET).
 * @param {Date} now
 * @param {string} tz  IANA timezone e.g. 'Europe/Prague'
 * @returns {string}  e.g. 'Fri, 18 Apr 2026 20:54:06 +0200'
 */
export function buildSmtpDate(now, tz) {
  const tzName = Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
    .formatToParts(now).find(p => p.type === 'timeZoneName')?.value || 'GMT+0'
  // tzName may be 'GMT+2', 'GMT+1', 'GMT+02:00', 'GMT-5', etc.
  const raw = tzName.replace('GMT', '') || '+0'
  const sign = raw.startsWith('-') ? '-' : '+'
  const parts = raw.replace(/^[+-]/, '').split(':')
  const hh = String(Number(parts[0] || 0)).padStart(2, '0')
  const mm = String(Number(parts[1] || 0)).padStart(2, '0')
  const offset = `${sign}${hh}${mm}`
  const pad = n => String(n).padStart(2, '0')
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }))
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${days[local.getDay()]}, ${local.getDate()} ${months[local.getMonth()]} ${local.getFullYear()} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())} ${offset}`
}

function proxyDetail(proxy_url) {
  if (!proxy_url) return 'Bez proxy'
  if (proxy_url.includes('@')) return proxy_url.split('@').pop()
  try {
    const u = new URL(proxy_url)
    return `${u.hostname}:${u.port}`
  } catch {
    return proxy_url
  }
}

/** Milliseconds → human-readable string. */
export const fmtMs = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`

/**
 * Filter mailboxes by free-text search and status.
 * search    — matches email, host, display_name (case-insensitive substring)
 * status    — '' | 'all' means no filter; otherwise exact mb.status match
 * Pure — no side-effects.
 */
export function filterMailboxes(mailboxes, search = '', status = '') {
  const q = search.trim().toLowerCase()
  return mailboxes.filter(mb => {
    if (q) {
      const hit = [mb.email, mb.host, mb.display_name]
        .some(v => v && String(v).toLowerCase().includes(q))
      if (!hit) return false
    }
    if (status && status !== 'all') {
      if (mb.status !== status) return false
    }
    return true
  })
}

// ── Status labels ────────────────────────────────────────────────

/** Map raw mailbox status → (Czech label, badge color key). */
const STATUS_META = {
  active:      { label: 'Aktivní',      color: 'green'  },
  paused:      { label: 'Pozastavena',  color: 'yellow' },
  bounce_hold: { label: 'Bounce hold',  color: 'yellow' },
  warming:     { label: 'Warmup',       color: 'gray'   },
  retired:     { label: 'Vyřazena',     color: 'gray'   },
}

export function statusLabel(status) {
  return STATUS_META[status]?.label ?? status ?? '—'
}

function statusColor(status) {
  return STATUS_META[status]?.color ?? 'gray'
}

// ── Health band ──────────────────────────────────────────────────

/**
 * Map live health score (0-100, null) to a band.
 * Returns one of: 'ok' | 'warn' | 'crit' | 'unknown'
 */
export function healthBand(score) {
  if (score == null) return 'unknown'
  if (score >= 80) return 'ok'
  if (score >= 50) return 'warn'
  return 'crit'
}

/**
 * Filter mailboxes by health band. Accepts live-score map {id: {score}} and a band key.
 * Band key 'all' returns all mailboxes unchanged.
 */
export function filterByHealthBand(mailboxes, liveScores, band = 'all') {
  if (band === 'all') return mailboxes
  return mailboxes.filter(mb => healthBand(liveScores[mb.id]?.score) === band)
}

// ── Sprint 1/2/3 pure utility functions ──────────────────────────

export function parseSmtpCheckResult(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, failStep: null, failMsg: 'no steps' }
  for (const s of steps) {
    if (!s || typeof s !== 'object') return { ok: false, failStep: null, failMsg: 'malformed step' }
    if (!s.ok) return { ok: false, failStep: s.name ?? null, failMsg: s.msg ?? null }
  }
  return { ok: true, failStep: null, failMsg: null }
}

export function parseImapCheckResult(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, failStep: null, failMsg: 'no steps' }
  for (const s of steps) {
    if (!s || typeof s !== 'object') return { ok: false, failStep: null, failMsg: 'malformed step' }
    if (!s.ok) return { ok: false, failStep: s.name ?? null, failMsg: s.msg ?? null }
  }
  return { ok: true, failStep: null, failMsg: null }
}

export function parseConfigIssues(mb) {
  const issues = []
  if (!mb.password)      issues.push({ field: 'password',      severity: 'critical', msg: 'Password is missing' })
  if (!mb.smtp_host)     issues.push({ field: 'smtp_host',     severity: 'critical', msg: 'SMTP host is missing' })
  if (!mb.smtp_username) issues.push({ field: 'smtp_username', severity: 'critical', msg: 'SMTP username is missing' })

  const port = Number(mb.smtp_port)
  if (!mb.smtp_port || isNaN(port) || port <= 0 || port > 65535) {
    issues.push({ field: 'smtp_port', severity: 'critical', msg: `Invalid SMTP port: ${mb.smtp_port}` })
  }

  const cap = Number(mb.daily_cap_override)
  if (mb.daily_cap_override !== undefined && mb.daily_cap_override !== null && (!cap || cap <= 0)) {
    issues.push({ field: 'daily_cap_override', severity: 'warn', msg: 'Daily cap must be > 0' })
  } else if (cap > 0 && cap < 10) {
    issues.push({ field: 'daily_cap_override', severity: 'warn', msg: `Daily cap ${cap} — nerealisticky nízké` })
  }

  if (mb.imap_host) {
    if (!mb.imap_username) {
      issues.push({ field: 'imap_username', severity: 'warn', msg: 'IMAP host nastaven, IMAP username chybí' })
    }
    const ip = Number(mb.imap_port)
    if (!mb.imap_port || isNaN(ip) || ![143, 993].includes(ip)) {
      issues.push({ field: 'imap_port', severity: 'warn', msg: `IMAP port ${mb.imap_port || 'chybí'} — očekáváno 143 nebo 993` })
    }
  }

  if (mb.proxy_url) {
    try {
      const u = new URL(mb.proxy_url)
      if (u.protocol !== 'socks5:') {
        issues.push({ field: 'proxy_url', severity: 'warn', msg: `Proxy scheme '${u.protocol.replace(':','')}' — očekáváno socks5://` })
      }
    } catch {
      issues.push({ field: 'proxy_url', severity: 'warn', msg: `Neplatná proxy URL: ${mb.proxy_url}` })
    }
  }

  return issues
}

// Weights MUST sum to exactly 100. Invariant checked at module load.
const CHECK_WEIGHTS = { smtp: 30, imap: 14, config: 14, proxy: 10, anti_trace: 10, warmup: 10, bounce: 6, send_rate: 3, pipeline: 3 }
const _W_SUM = Object.values(CHECK_WEIGHTS).reduce((a, b) => a + b, 0)
if (_W_SUM !== 100) throw new Error(`CHECK_WEIGHTS must sum to 100, got ${_W_SUM}`)

export function calcFullCheckScore(checks) {
  let earned = 0
  let total = 0
  for (const [k, weight] of Object.entries(CHECK_WEIGHTS)) {
    if (checks[k] == null) continue
    total += weight
    if (checks[k]?.ok) earned += weight
  }
  if (total === 0) return 100
  return Math.max(0, Math.round((earned / total) * 100))
}

export function isWarmupStale(last_advanced_at, thresholdH = 24) {
  if (!last_advanced_at) return true
  const ageMs = Date.now() - new Date(last_advanced_at).getTime()
  return ageMs >= thresholdH * 60 * 60 * 1000
}

export function classifyBounceHealth(rate, consecutive) {
  // Evaluate the critical conditions together (max severity) BEFORE the
  // consecutive>=3 warn branch — otherwise a >=10%-bouncing mailbox with
  // consecutive in {3,4} was downgraded to 'warn' and skipped the warmup pause.
  if (consecutive >= 5 || (rate != null && rate >= 10)) return 'critical'
  if (consecutive >= 3) return 'warn'
  if (rate != null && rate >= 5)  return 'warn'
  return 'ok'
}

export function formatPipelineAge(tested_at) {
  if (!tested_at) return { label: 'Nikdy', stale: true, warn: false, ageH: null }
  const ageMs = Date.now() - new Date(tested_at).getTime()
  const ageH  = Math.floor(ageMs / (60 * 60 * 1000))
  const ageMin = Math.floor(ageMs / 60000)
  const stale  = ageH >= 24
  const warn   = ageH >= 12 && !stale
  if (ageH >= 1) return { label: `před ${ageH} hod`, stale, warn, ageH }
  return { label: `před ${ageMin} min`, stale, warn, ageH: 0 }
}

const CRITICAL_CHECKS = new Set(['smtp', 'imap', 'config'])

/**
 * Klasifikuje příčinu SMTP selhání z kroků full-checku.
 * Vrací: 'proxy_fail' | 'auth_fail' | 'tls_fail' | 'unknown' | null (pokud ok)
 */
export function classifySmtpFailure(smtpCheck) {
  if (!smtpCheck || smtpCheck.ok) return null
  const steps = Array.isArray(smtpCheck.steps) ? smtpCheck.steps : []
  const socksFail = steps.find(s => s?.name === 'socks_dial' && !s.ok)
  if (socksFail) return 'proxy_fail'
  const authFail = steps.find(s => s?.name === 'smtp_auth' && !s.ok)
  if (authFail) return 'auth_fail'
  const tlsFail = steps.find(s => (s?.name === 'tls_handshake' || s?.name === 'starttls') && !s.ok)
  if (tlsFail) return 'tls_fail'
  return 'unknown'
}

/**
 * Vrací human-readable popis SMTP selhání.
 */
export function smtpFailureLabel(smtpCheck) {
  const reason = classifySmtpFailure(smtpCheck)
  switch (reason) {
    case 'proxy_fail': return 'Proxy nedostupná'
    case 'auth_fail': return 'Špatné heslo / přihlášení selhalo'
    case 'tls_fail': return 'TLS handshake selhal'
    case 'unknown': return 'SMTP selhalo'
    default: return null
  }
}

/**
 * Detects greylisting (451 / "try again" / "temporarily deferred") in an SMTP
 * check result. Greylisted responses must NOT count as auth failures — the
 * mailbox is healthy, just asked to retry later.
 *
 * @param {object|null|undefined} smtpCheck  Full SMTP check object with .steps[]
 * @returns {boolean}
 */
export function isGreylisted(smtpCheck) {
  const steps = Array.isArray(smtpCheck?.steps) ? smtpCheck.steps : []
  return steps.some(s => {
    if (!s || typeof s.msg !== 'string' || !s.msg) return false
    return (
      s.msg.includes('451') ||
      /try.again|greylist|temporarily/i.test(s.msg)
    )
  })
}

export function buildFullCheckSummary(checks) {
  const score = calcFullCheckScore(checks)
  const critical = []
  const warnings = []
  const passing  = []
  for (const [k, v] of Object.entries(checks)) {
    if (v == null) continue
    if (v.ok) { passing.push(k); continue }
    if (k === 'smtp' && classifySmtpFailure(v) === 'proxy_fail') {
      warnings.push(k) // proxy problem = dočasný = warn, ne critical
    } else if (CRITICAL_CHECKS.has(k)) {
      critical.push(k)
    } else {
      warnings.push(k)
    }
  }
  // near_limit and warn flags escalate to warnings without marking ok=false
  if (checks.send_rate?.near_limit && checks.send_rate?.ok && !warnings.includes('send_rate')) warnings.push('send_rate')
  if (checks.pipeline?.warn && checks.pipeline?.ok && !warnings.includes('pipeline')) warnings.push('pipeline')
  if (checks.warmup?.near_end && checks.warmup?.ok && !warnings.includes('warmup')) warnings.push('warmup')
  if (checks.bounce?.insufficient_data && !warnings.includes('bounce') && !passing.includes('bounce')) warnings.push('bounce')
  // proxy check null = relay handles routing globally — don't penalise
  const proxyBlocking = checks.proxy?.ok === false
  const send_ready = !proxyBlocking && score >= 50
  const effectiveScore = proxyBlocking ? Math.min(score, 74) : score
  return { score: effectiveScore, critical, warnings, passing, send_ready }
}

/**
 * Returns the 4 security checklist items for a mailbox.
 * Pure — all inputs explicit, no global state.
 *
 * @param {object} mb           Mailbox record
 * @param {boolean|null} antiTraceOk  Anti-trace relay live status
 * @param {object} [checks={}]  Live check results (from full-check API).
 *                              checks.proxy?.ok === false → proxy warn state.
 *                              Unknown/missing = optimistic (no penalisation).
 * @param {object|null} [poolData=null] Proxy pool snapshot (from relayProxyPool).
 *                              When provided, enriches the Anti-trace detail with
 *                              working count and auth_validated count.
 */
export function getSecurityItems(mb, antiTraceOk, checks = {}, poolData = null) {
  const port = Number(mb.port)
  // Per-mailbox proxy: ok unless the live check explicitly returned ok=false.
  // No checks available (null/undefined/missing) → optimistic, no warn.
  const proxyExplicitFail = !!(mb.proxy_url && checks.proxy?.ok === false)
  return [
    {
      ok:   port === 465,
      warn: port === 587,
      label:  'TLS šifrování',
      detail: port === 465
        ? 'SMTPS (port 465)'
        : port === 587
          ? 'STARTTLS (port 587)'
          : `Port ${port} – nezabezpečeno`,
    },
    {
      ok:     !!mb.imap_host,
      label:  'IMAP monitoring',
      detail: mb.imap_host ? `${mb.imap_host}:${mb.imap_port}` : 'Nenastaveno',
    },
    {
      // Per-mailbox proxy: ok unless live check explicitly says failing.
      // No per-mailbox proxy: fall back to anti-trace relay.
      ok:   mb.proxy_url
        ? checks.proxy?.ok !== false   // optimistic unless explicitly false
        : antiTraceOk === true,
      warn: proxyExplicitFail,
      label:  'Proxy anonymizace',
      detail: mb.proxy_url
        ? proxyExplicitFail
          ? `Proxy selhává: ${proxyDetail(mb.proxy_url)}`
          : proxyDetail(mb.proxy_url)
        : antiTraceOk === true
          ? 'Anti-trace relay (globální)'
          : 'Bez proxy',
    },
    {
      ok:     antiTraceOk === true,
      label:  'Anti-trace',
      detail: antiTraceOk === true
        ? `OK — ${poolData?.working?.length || 0} proxies${poolData?.auth_validated > 0 ? `, ${poolData.auth_validated} auth-validated` : ''}`
        : antiTraceOk === false
          ? 'DOWN — relay nedostupný'
          : 'Načítám…',
    },
  ]
}

/**
 * Analyze raw email header string for IP/identity leakage.
 * Returns { score: 0–100, issues: [{field, severity, msg}], safe: boolean }
 */
export function analyzeHeaderAnonymity(rawHeaders) {
  const issues = []
  let deductions = 0

  // Defensive: callers may pass null, undefined, or non-strings (server payloads,
  // tests, partial DB rows). Treat anything non-stringy as "no headers, no leaks".
  if (typeof rawHeaders !== 'string') return { score: 100, issues, safe: true }

  const xOrigIp = rawHeaders.match(/^X-Originating-IP:\s*(.+)$/im)
  if (xOrigIp) {
    issues.push({ field: 'X-Originating-IP', severity: 'critical', msg: `IP leaked: ${xOrigIp[1].trim()}` })
    deductions += 40
  }

  const xForwarded = rawHeaders.match(/^X-Forwarded-For:\s*(.+)$/im)
  if (xForwarded) {
    issues.push({ field: 'X-Forwarded-For', severity: 'critical', msg: `IP chain leaked: ${xForwarded[1].trim()}` })
    deductions += 40
  }

  const privateIpRe = /\b(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/
  const receivedLines = rawHeaders.match(/^Received:.*$/gim) || []
  for (const line of receivedLines) {
    if (privateIpRe.test(line)) {
      const ip = line.match(privateIpRe)[0]
      issues.push({ field: 'Received', severity: 'warn', msg: `Private IP in Received header: ${ip}` })
      deductions += 15
      break
    }
  }

  const xMailer = rawHeaders.match(/^X-Mailer:\s*(.+)$/im)
  if (xMailer) {
    issues.push({ field: 'X-Mailer', severity: 'warn', msg: `Client fingerprint: ${xMailer[1].trim()}` })
    deductions += 10
  }

  const userAgent = rawHeaders.match(/^User-Agent:\s*(.+)$/im)
  if (userAgent) {
    issues.push({ field: 'User-Agent', severity: 'warn', msg: `User-Agent exposed: ${userAgent[1].trim()}` })
    deductions += 10
  }

  const score = Math.max(0, 100 - deductions)
  return { score, issues, safe: score >= 70 }
}
