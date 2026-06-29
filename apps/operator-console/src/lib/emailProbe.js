/**
 * Server-only network probes for email verification.
 *   - MX lookup via dns.resolveMx with A-record fallback
 *   - SMTP RCPT-TO probe (port 25)
 *   - Catch-all detection (probe random local-part)
 *
 * Not imported by client code — uses node:dns and node:net.
 */
import dns from 'dns/promises'
import net from 'net'
import { runPureChecks, classifyStatus, computeConfidence } from './emailVerify.js'

const SMTP_TIMEOUT_MS   = 8_000
const SMTP_PORT         = 25
const FROM_PROBE        = 'verify-probe@example.com'

// ── MX ──────────────────────────────────────────────────────────────
async function lookupMX(domain, timeoutMs = 5_000) {
  try {
    const mx = await withTimeout(dns.resolveMx(domain), timeoutMs)
    if (Array.isArray(mx) && mx.length) {
      mx.sort((a, b) => a.priority - b.priority)
      return { exists: true, hosts: mx.map(r => r.exchange) }
    }
  } catch {}
  try {
    const a = await withTimeout(dns.resolve4(domain), timeoutMs)
    if (Array.isArray(a) && a.length) return { exists: true, hosts: [domain] }
  } catch {}
  return { exists: false, hosts: [] }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ])
}

// ── Domain auth (SPF/DMARC) ─────────────────────────────────────────
// DKIM not checked — selectors are arbitrary per-sender, no canonical lookup.
async function lookupDomainAuth(domain, timeoutMs = 5_000) {
  const flat = (records) => records.flatMap(r => Array.isArray(r) ? r : [r]).join(' ').toLowerCase()
  let spf = false, dmarc = false
  try {
    const root = await withTimeout(dns.resolveTxt(domain), timeoutMs)
    if (Array.isArray(root) && flat(root).includes('v=spf1')) spf = true
  } catch {}
  try {
    const dm = await withTimeout(dns.resolveTxt(`_dmarc.${domain}`), timeoutMs)
    if (Array.isArray(dm) && flat(dm).includes('v=dmarc1')) dmarc = true
  } catch {}
  return { spf, dmarc }
}

// ── SMTP RCPT probe ─────────────────────────────────────────────────
/**
 * @returns {Promise<{ code:number|null, response:string, accepted:boolean|null, tempfail:boolean }>}
 *   accepted=true  → 250 RCPT TO
 *   accepted=false → 550/551/553 permanent rejection
 *   accepted=null  → tempfail (4xx) or connection error; cannot conclude
 */
async function probeRCPT(mxHost, rcptTo, fromAddr = FROM_PROBE) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: mxHost, port: SMTP_PORT })
    let buf = ''
    let step = 0
    let ended = false
    const lines = []

    const done = (result) => {
      if (ended) return
      ended = true
      try { socket.end('QUIT\r\n') } catch {}
      try { socket.destroy() } catch {}
      resolve(result)
    }

    const timer = setTimeout(() => done({ code: null, response: 'timeout', accepted: null, tempfail: true }), SMTP_TIMEOUT_MS)

    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        lines.push(line)
        // SMTP multiline: "250-foo" continues, "250 foo" ends.
        if (/^\d{3} /.test(line)) {
          handleResponse(line)
        }
      }
    })
    socket.on('error', () => { clearTimeout(timer); done({ code: null, response: 'connect_error', accepted: null, tempfail: true }) })
    socket.on('close', () => { clearTimeout(timer); if (!ended) done({ code: null, response: lines.join('\n'), accepted: null, tempfail: true }) })

    function handleResponse(line) {
      const code = parseInt(line.slice(0, 3), 10)
      if (step === 0) {
        if (code !== 220) return done({ code, response: line, accepted: null, tempfail: true })
        step = 1
        socket.write(`EHLO verify.local\r\n`)
      } else if (step === 1) {
        if (code !== 250) {
          // fall back to HELO
          step = 2
          socket.write(`HELO verify.local\r\n`)
          return
        }
        step = 3
        socket.write(`MAIL FROM:<${fromAddr}>\r\n`)
      } else if (step === 2) {
        if (code !== 250) return done({ code, response: line, accepted: null, tempfail: code >= 400 && code < 500 })
        step = 3
        socket.write(`MAIL FROM:<${fromAddr}>\r\n`)
      } else if (step === 3) {
        if (code !== 250) return done({ code, response: line, accepted: null, tempfail: code >= 400 && code < 500 })
        step = 4
        socket.write(`RCPT TO:<${rcptTo}>\r\n`)
      } else if (step === 4) {
        clearTimeout(timer)
        if (code === 250 || code === 251) return done({ code, response: line, accepted: true, tempfail: false })
        if (code >= 500) return done({ code, response: line, accepted: false, tempfail: false })
        return done({ code, response: line, accepted: null, tempfail: true })
      }
    }
  })
}

// ── Full verification pipeline ──────────────────────────────────────
/**
 * Complete verification with network probes + pure checks.
 * Respects per-domain cache lookup (caller provides getCache/setCache).
 *
 * @param {string} email
 * @param {object} opts
 *   opts.enableSMTP:   boolean   (default true)
 *   opts.detectCatchAll: boolean (default true)
 *   opts.fromAddr:     string    (SMTP MAIL FROM for probe)
 *   opts.domainCache:  { get(domain): record|null, set(domain, record): void }
 * @returns {Promise<{ email, status, detail, ...checks, checked_at }>}
 */
export async function verifyEmail(email, opts = {}) {
  const enableSMTP      = opts.enableSMTP !== false
  const detectCatchAll  = opts.detectCatchAll !== false
  const fromAddr        = opts.fromAddr ?? FROM_PROBE
  const cache           = opts.domainCache ?? null

  const finalize = (c) => {
    const { status, detail } = classifyStatus({ ...c, role: c.is_role })
    const confidence = computeConfidence(c)
    return { ...c, status, detail, confidence, checked_at: new Date().toISOString() }
  }

  const checks = runPureChecks(email)
  if (!checks.syntax_valid) return finalize(checks)

  // Fast short-circuit: disposable or spamtrap → no probe needed.
  if (checks.is_disposable || checks.is_spamtrap || checks.is_role === 'dangerous') {
    return finalize(checks)
  }

  const domain = checks.domain
  let domainRec = cache?.get ? await cache.get(domain) : null

  // MX lookup (cache first)
  if (domainRec?.mx_exists != null) {
    checks.mx_exists = domainRec.mx_exists
    checks.is_catch_all = domainRec.is_catch_all ?? null
  } else {
    const mx = await lookupMX(domain)
    checks.mx_exists = mx.exists
    domainRec = { ...domainRec, mx_exists: mx.exists, mx_host: mx.hosts[0] ?? null }
  }

  if (!checks.mx_exists) {
    if (cache?.set) await cache.set(domain, domainRec)
    return finalize(checks)
  }

  const mxHost = domainRec.mx_host ?? (await lookupMX(domain)).hosts[0]

  // Domain auth (SPF/DMARC) — cache on domain
  if (domainRec?.spf == null || domainRec?.dmarc == null) {
    const auth = await lookupDomainAuth(domain)
    checks.has_spf   = auth.spf
    checks.has_dmarc = auth.dmarc
    domainRec.spf    = auth.spf
    domainRec.dmarc  = auth.dmarc
  } else {
    checks.has_spf   = domainRec.spf
    checks.has_dmarc = domainRec.dmarc
  }

  // SMTP RCPT probe (only if enabled and no cached smtp_valid)
  if (enableSMTP && mxHost) {
    const probe = await probeRCPT(mxHost, email, fromAddr)
    if (probe.accepted === true) checks.smtp_valid = true
    else if (probe.accepted === false) checks.smtp_valid = false
    else checks.smtp_valid = null // tempfail — leave as risky
    checks.smtp_response = probe.response
  }

  // Catch-all detection: probe 3 distinct random local-parts. ≥2 accepts ⇒ catch-all.
  // Single probe = false-positive risk (greylist accept, MX silently logging-then-rejecting, etc).
  if (detectCatchAll && enableSMTP && mxHost && checks.smtp_valid === true && checks.is_catch_all == null) {
    const probes = await Promise.all([0, 1, 2].map(async i => {
      const rnd = `probe-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 10)}@${domain}`
      return probeRCPT(mxHost, rnd, fromAddr)
    }))
    const accepts = probes.filter(p => p.accepted === true).length
    checks.is_catch_all = accepts >= 2
    checks.catch_all_probes = { accepts, total: probes.length }
    domainRec.is_catch_all = checks.is_catch_all
  }

  if (cache?.set) await cache.set(domain, { ...domainRec, checked_at: new Date().toISOString() })

  return finalize(checks)
}
