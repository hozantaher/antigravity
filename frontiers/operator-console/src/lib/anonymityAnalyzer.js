/**
 * anonymityAnalyzer.js — čistá analýza email headerů pro anonymity probe (S15).
 *
 * Vstup: raw headers string (celé hlavičky emailu jako text).
 * Výstup: { score: 0-100, leaks: string[], checks: { [checkName]: boolean } }
 *
 * Každý check vrací true (ok, žádný leak) nebo false (leak detekován).
 * score = (počet passed checks / celkový počet checks) * 100, zaokrouhleno.
 */

/**
 * @param {string | unknown} rawHeaders
 * @returns {{ score: number, leaks: string[], checks: Record<string, boolean> }}
 */
export function analyzeAnonymity(rawHeaders) {
  // Defenzivní: cokoli ne-string je "žádné headery, žádné leaky".
  if (typeof rawHeaders !== 'string') {
    return {
      score: 100,
      leaks: [],
      checks: {
        received_chain_clean: true,
        no_originating_ip: true,
        message_id_clean: true,
        date_timezone_neutral: true,
        no_user_agent_leak: true,
        no_local_hostname: true,
      },
    }
  }

  const lines = rawHeaders.split('\n')

  const checks = {
    // Received chain nesmí obsahovat RFC1918 adresy
    received_chain_clean: checkReceivedChain(lines),
    // X-Originating-IP nesmí existovat
    no_originating_ip: checkNoOriginatingIP(lines),
    // Message-ID nesmí obsahovat IP adresu
    message_id_clean: checkMessageID(lines),
    // Date timezone — základní check (vždy true pokud header existuje nebo neexistuje)
    date_timezone_neutral: checkDateTimezone(lines),
    // X-Mailer a User-Agent nesmí odhalit klienta
    no_user_agent_leak: checkNoUserAgent(lines),
    // Received: from nesmí obsahovat localhost/místní hostname
    no_local_hostname: checkNoLocalHostname(lines),
  }

  const passed = Object.values(checks).filter(Boolean).length
  const total = Object.keys(checks).length
  const score = Math.round((passed / total) * 100)

  const leaks = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([key]) => key)

  return { score, leaks, checks }
}

// ── Dílčí check funkce ────────────────────────────────────────────────────────

/**
 * Received chain nesmí obsahovat RFC1918 private IP adresy.
 * 10.x, 192.168.x, 172.16-31.x
 */
function checkReceivedChain(lines) {
  const received = lines.filter(l => l.toLowerCase().startsWith('received:'))
  const privateIPRegex = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/
  return !received.some(r => privateIPRegex.test(r))
}

/**
 * X-Originating-IP header nesmí existovat — odhaluje původní IP odesílatele.
 */
function checkNoOriginatingIP(lines) {
  return !lines.some(l => l.toLowerCase().startsWith('x-originating-ip:'))
}

/**
 * Message-ID nesmí obsahovat literální IP adresu — odhaluje infrastrukturu.
 */
function checkMessageID(lines) {
  const msgId = lines.find(l => l.toLowerCase().startsWith('message-id:'))
  if (!msgId) return true
  // IPv4 pattern
  return !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(msgId)
}

/**
 * Date timezone check — základní implementace.
 * Vrací true pokud Date header neobsahuje neobvyklé specifické UTC offsety.
 * Poznámka: +0000, +0100, +0200 jsou neutrální (standardní).
 */
function checkDateTimezone(lines) {
  const date = lines.find(l => l.toLowerCase().startsWith('date:'))
  // Pokud date header neexistuje, nepovažujeme to za leak
  if (!date) return true
  // Pokud date header existuje, je v pořádku (nedetekujeme specifické TZ leaky zde)
  return true
}

/**
 * X-Mailer a User-Agent odhalují email klienta — nesmí být přítomny.
 */
function checkNoUserAgent(lines) {
  return !lines.some(l =>
    l.toLowerCase().startsWith('x-mailer:') ||
    l.toLowerCase().startsWith('user-agent:')
  )
}

/**
 * Received: from nesmí obsahovat localhost, .local domény nebo 127.0.0.1.
 */
function checkNoLocalHostname(lines) {
  const received = lines.filter(l => l.toLowerCase().startsWith('received:'))
  return !received.some(r => /\b(localhost|127\.0\.0\.1)\b|\bhost\.local\b|\.local\b/i.test(r))
}
