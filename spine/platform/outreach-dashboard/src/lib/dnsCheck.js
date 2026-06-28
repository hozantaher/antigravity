// Pure DNS check helpers — no side effects, testable in isolation.
// Dependency injection via `deps` parameter mirrors the mxLookup.js pattern.

import { promises as dnsPromises } from 'node:dns'

/**
 * Check MX records for a domain.
 * Returns { ok, records: string[], error? }
 *
 * @param {string} domain
 * @param {{ resolveMx: Function }} [deps]
 */
export async function checkMX(domain, deps = { resolveMx: dnsPromises.resolveMx }) {
  try {
    const records = await deps.resolveMx(domain)
    const sorted = (records || [])
      .sort((a, b) => a.priority - b.priority)
      .map(r => r.exchange)
    return { ok: sorted.length > 0, records: sorted }
  } catch (e) {
    return { ok: false, records: [], error: e.message }
  }
}

/**
 * Check SPF record for a domain (looks for TXT record starting with v=spf1).
 * Returns { ok, record: string|null, error? }
 *
 * @param {string} domain
 * @param {{ resolveTxt: Function }} [deps]
 */
export async function checkSPF(domain, deps = { resolveTxt: dnsPromises.resolveTxt }) {
  try {
    const records = await deps.resolveTxt(domain)
    const spf = (records || []).flat().find(r => r.startsWith('v=spf1'))
    return { ok: !!spf, record: spf || null }
  } catch (e) {
    return { ok: false, record: null, error: e.message }
  }
}

/**
 * Check DKIM record for a domain + selector.
 * Returns { ok, record: string|null, selector, error? }
 *
 * @param {string} domain
 * @param {string} [selector]
 * @param {{ resolveTxt: Function }} [deps]
 */
export async function checkDKIM(domain, selector = 'default', deps = { resolveTxt: dnsPromises.resolveTxt }) {
  try {
    const host = `${selector}._domainkey.${domain}`
    const records = await deps.resolveTxt(host)
    const dkim = (records || []).flat().find(r => r.includes('v=DKIM1'))
    return { ok: !!dkim, record: dkim || null, selector }
  } catch (e) {
    return { ok: false, record: null, selector, error: e.message }
  }
}

/**
 * Run full DNS check for a mailbox domain.
 * smtpHost: e.g. "smtp.seznam.cz" → domain = "seznam.cz"
 * DKIM optional — not all providers expose it.
 *
 * @param {string} smtpHost
 * @param {string} [dkimSelector]
 * @param {{ resolveMx: Function, resolveTxt: Function }} [deps]
 */
export async function runDNSCheck(smtpHost, dkimSelector = 'default', deps = { resolveMx: dnsPromises.resolveMx, resolveTxt: dnsPromises.resolveTxt }) {
  if (!smtpHost || typeof smtpHost !== 'string') {
    return { ok: false, domain: '', mx: { ok: false, records: [], error: 'no smtpHost' }, spf: { ok: false, record: null, error: 'no smtpHost' }, dkim: { ok: false, record: null, selector: dkimSelector, error: 'no smtpHost' } }
  }

  const parts = smtpHost.split('.')
  const domain = parts.length >= 2 ? parts.slice(-2).join('.') : smtpHost

  const mxDeps  = { resolveMx: deps.resolveMx }
  const txtDeps = { resolveTxt: deps.resolveTxt }

  const [mx, spf, dkim] = await Promise.all([
    checkMX(domain, mxDeps),
    checkSPF(domain, txtDeps),
    checkDKIM(domain, dkimSelector, txtDeps),
  ])

  // DKIM is optional — ok only requires MX + SPF
  const ok = mx.ok && spf.ok
  return { ok, domain, mx, spf, dkim }
}
