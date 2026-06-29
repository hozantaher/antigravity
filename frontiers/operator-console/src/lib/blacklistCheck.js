// DNS-based email blacklist check. No external HTTP — pure DNS A lookups.
// Blacklists checked: Spamhaus ZEN, SpamCop, Barracuda, SORBS.
//
// Dependency injection via `deps` parameter mirrors the dnsCheck.js pattern
// so this module is fully testable without real DNS.

export const DNSBL_ZONES = [
  'zen.spamhaus.org',
  'bl.spamcop.net',
  'b.barracudacentral.org',
  'dnsbl.sorbs.net',
]

/**
 * Check if a domain/hostname is listed on DNS blacklists.
 * Resolves the smtp host to get IPs, then checks each IP against each zone.
 *
 * @param {string} smtpHost  e.g. "smtp.seznam.cz"
 * @param {{ dns?: { resolve4: Function, resolveMx: Function }, zones?: string[] }} [deps]
 * @returns {Promise<{ listed: boolean, hits: Array<{zone: string, ip: string}>, ips: string[], checked_at: string, error?: string }>}
 */
export async function checkBlacklist(smtpHost, deps = {}) {
  const dns = deps.dns || (await import('node:dns')).promises
  const zones = deps.zones ?? DNSBL_ZONES
  const checkedAt = new Date().toISOString()

  if (!smtpHost || typeof smtpHost !== 'string') {
    return { listed: false, hits: [], ips: [], checked_at: checkedAt, error: 'no_ip_resolved' }
  }

  // Get IP(s) for the smtp host
  let ips = []
  try {
    const addresses = await dns.resolve4(smtpHost)
    ips = addresses
  } catch {
    // Hostname not directly resolvable — try domain MX instead
    try {
      const parts = smtpHost.split('.')
      const domain = parts.length >= 2 ? parts.slice(-2).join('.') : smtpHost
      const mx = await dns.resolveMx(domain)
      if (mx && mx.length) {
        const addr = await dns.resolve4(mx[0].exchange).catch(() => [])
        ips = addr
      }
    } catch { /* no IPs found */ }
  }

  if (!ips.length) {
    return { listed: false, hits: [], ips: [], checked_at: checkedAt, error: 'no_ip_resolved' }
  }

  const hits = []
  for (const ip of ips) {
    const reversed = ip.split('.').reverse().join('.')
    for (const zone of zones) {
      const lookup = `${reversed}.${zone}`
      try {
        await dns.resolve4(lookup) // throws ENOTFOUND if not listed
        hits.push({ zone, ip })
      } catch { /* not listed — expected */ }
    }
  }

  return { listed: hits.length > 0, hits, ips, checked_at: checkedAt }
}
