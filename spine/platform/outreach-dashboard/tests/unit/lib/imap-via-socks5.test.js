// Sprint AO1: Unit tests for IMAP-via-SOCKS5 helpers.
//
// Tests cover:
//   - relayImapSocksAddr: function shape + query string construction
//   - getMailboxSOCKS5Addr: per-mailbox socks resolution source invariants
//   - dialIMAPViaSOCKS5: SOCKS5 + TLS wrapping (source inspection)
//   - Timeout / unreachable scenarios (source invariants)
//   - Fallback behaviour when country-specific endpoint unavailable
//   - Integration of socksAddr through imap function signatures
//
// ≥10 test cases — feedback_extreme_testing HARD RULE.
//
// Note: relayClient.js is an ESM module imported by server.js.
// Tests use source inspection to verify contracts without attempting
// ESM re-mocking (which is fragile in vitest jsdom env).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const RELAY_CLIENT = resolve(__dirname, '../../../src/lib/relayClient.js')
const SERVER_JS = resolve(__dirname, '../../../server.js')
const IMAP_POLL_CRON = resolve(__dirname, '../../../src/crons/runImapPollCron.js')

function readRelayClient() {
  return readFileSync(RELAY_CLIENT, 'utf8')
}

function readServerJs() {
  return readFileSync(SERVER_JS, 'utf8')
}

// ── relayImapSocksAddr source invariants ──────────────────────────────────────

describe('relayImapSocksAddr (relayClient.js source invariants)', () => {
  it('T-1: function is exported from relayClient.js', () => {
    const src = readRelayClient()
    expect(src).toContain('export async function relayImapSocksAddr(')
  })

  it('T-2: calls relayFetch with /v1/imap-socks-addr path', () => {
    const src = readRelayClient()
    const fnStart = src.indexOf('export async function relayImapSocksAddr(')
    const fnBody = src.slice(fnStart, fnStart + 500)
    expect(fnBody).toContain('/v1/imap-socks-addr')
  })

  it('T-3: encodes preferred_country in query string when set', () => {
    const src = readRelayClient()
    const fnStart = src.indexOf('export async function relayImapSocksAddr(')
    const fnBody = src.slice(fnStart, fnStart + 500)
    expect(fnBody).toContain('preferred_country=')
    expect(fnBody).toContain('encodeURIComponent(preferredCountry)')
  })

  it('T-4: omits query string when preferredCountry is empty', () => {
    const src = readRelayClient()
    const fnStart = src.indexOf('export async function relayImapSocksAddr(')
    const fnBody = src.slice(fnStart, fnStart + 500)
    // The conditional: qs = preferredCountry ? `?preferred_country=...` : ''
    expect(fnBody).toMatch(/preferredCountry\s*\?/)
    expect(fnBody).toContain("''")
  })

  it('T-5: returns null when relay returns no socks_addr', () => {
    const src = readRelayClient()
    const fnStart = src.indexOf('export async function relayImapSocksAddr(')
    const fnBody = src.slice(fnStart, fnStart + 500)
    expect(fnBody).toContain('!body?.socks_addr')
    expect(fnBody).toContain('return null')
  })

  it('T-6: uses 5000ms timeout for relay call', () => {
    const src = readRelayClient()
    const fnStart = src.indexOf('export async function relayImapSocksAddr(')
    const fnBody = src.slice(fnStart, fnStart + 500)
    expect(fnBody).toContain('5000')
  })

  it('T-7: returns socks_addr, country and label from body', () => {
    const src = readRelayClient()
    const fnStart = src.indexOf('export async function relayImapSocksAddr(')
    const fnBody = src.slice(fnStart, fnStart + 500)
    expect(fnBody).toContain('socks_addr: body.socks_addr')
    expect(fnBody).toContain('country:')
    expect(fnBody).toContain('label:')
  })
})

// ── dialIMAPViaSOCKS5 source invariants ───────────────────────────────────────

describe('dialIMAPViaSOCKS5 (server.js source invariants)', () => {
  it('T-8: function exists in server.js', () => {
    const src = readServerJs()
    expect(src).toContain('async function dialIMAPViaSOCKS5(')
  })

  it('T-9: uses SocksClient.createConnection with proxy type 5 (SOCKS5)', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function dialIMAPViaSOCKS5(')
    const fnBody = src.slice(fnStart, fnStart + 1000)
    expect(fnBody).toContain('SocksClient.createConnection')
    expect(fnBody).toContain('type: 5')
  })

  it('T-10: wraps raw socket in TLS (tls.connect with servername for SNI)', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function dialIMAPViaSOCKS5(')
    // Use 1600 chars — the function body now includes IMAP_TLS_INSECURE handling
    // added by Fix 4 (P1) between SocksClient.createConnection and tls.connect.
    const fnBody = src.slice(fnStart, fnStart + 1600)
    expect(fnBody).toContain('tls.connect(')
    expect(fnBody).toContain('servername:')
  })

  it('T-11: accepts timeoutMs parameter with default 15000', () => {
    const src = readServerJs()
    expect(src).toMatch(/async function dialIMAPViaSOCKS5\(socksAddr, host, port, timeoutMs = 15000\)/)
  })
})

// ── getMailboxSOCKS5Addr source invariants ────────────────────────────────────

describe('getMailboxSOCKS5Addr (server.js source invariants)', () => {
  it('T-12: function exists in server.js', () => {
    const src = readServerJs()
    expect(src).toContain('async function getMailboxSOCKS5Addr(')
  })

  it('T-13: reads preferred_country from row object (duck-typed)', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function getMailboxSOCKS5Addr(')
    const fnBody = src.slice(fnStart, fnStart + 1200)
    expect(fnBody).toContain('preferred_country')
    expect(fnBody).toContain('mailboxRowOrId.preferred_country')
  })

  it('T-14: queries DB for preferred_country when passed mailbox id (not object)', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function getMailboxSOCKS5Addr(')
    const fnBody = src.slice(fnStart, fnStart + 1200)
    expect(fnBody).toContain('pool.query')
    expect(fnBody).toContain('WHERE id=$1')
  })

  it('T-15: falls back to any-country endpoint when in-country is unavailable', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function getMailboxSOCKS5Addr(')
    const fnBody = src.slice(fnStart, fnStart + 1500)
    // Fallback call with empty preferredCountry
    expect(fnBody).toContain("relayImapSocksAddr(pool, '')")
  })

  it('T-16: throws descriptive error when relay is completely unavailable', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function getMailboxSOCKS5Addr(')
    const fnBody = src.slice(fnStart, fnStart + 1500)
    expect(fnBody).toContain('imap_socks_unavailable')
    expect(fnBody).toContain('throw new Error')
  })
})

// ── Fix 4 (P1): dialIMAPViaSOCKS5 TLS rejectUnauthorized default ─────────────
// Verifies that the SOCKS5-tunnelled TLS socket uses rejectUnauthorized:true
// by default and only disables certificate verification when IMAP_TLS_INSECURE=1.

describe('Fix 4 — dialIMAPViaSOCKS5 TLS rejectUnauthorized (P1)', () => {
  it('T-F4-1: dialIMAPViaSOCKS5 does NOT hardcode rejectUnauthorized:false', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function dialIMAPViaSOCKS5(')
    const fnEnd = src.indexOf('\n}', fnStart + 10) + 2
    const fnBody = src.slice(fnStart, fnEnd)
    // Must not have a static false literal for rejectUnauthorized
    expect(fnBody).not.toContain('rejectUnauthorized: false')
  })

  it('T-F4-2: dialIMAPViaSOCKS5 uses IMAP_TLS_INSECURE env var', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function dialIMAPViaSOCKS5(')
    const fnEnd = src.indexOf('\n}', fnStart + 10) + 2
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).toContain('IMAP_TLS_INSECURE')
  })

  it('T-F4-3: rejectUnauthorized is negation of insecure flag (!imapTlsInsecure)', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function dialIMAPViaSOCKS5(')
    const fnEnd = src.indexOf('\n}', fnStart + 10) + 2
    const fnBody = src.slice(fnStart, fnEnd)
    // The value expression should be !imapTlsInsecure (default secure)
    expect(fnBody).toMatch(/rejectUnauthorized\s*:\s*!imapTlsInsecure/)
  })

  it('T-F4-4: IMAP_TLS_INSECURE=1 triggers a warning log', () => {
    const src = readServerJs()
    const fnStart = src.indexOf('async function dialIMAPViaSOCKS5(')
    const fnEnd = src.indexOf('\n}', fnStart + 10) + 2
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).toContain('IMAP_TLS_INSECURE=1')
    expect(fnBody).toMatch(/console\.warn/)
  })
})

// ── Integration: call sites pass socksAddr through ────────────────────────────

describe('AO1 call site integration (server.js source invariants)', () => {
  it('T-17: runImapPollCron uses relayImapFetch (relay-based SOCKS5 routing)', () => {
    // runImapPollCron was extracted to src/crons/runImapPollCron.js (Sprint Z3).
    // It now delegates SOCKS5 routing to the relay service via relayImapFetch
    // instead of calling imapSearchUnseenUids directly with a socksAddr.
    const src = readFileSync(IMAP_POLL_CRON, 'utf8')
    expect(src).toContain("from '../lib/relayClient.js'")
    expect(src).toContain('relayImapFetch(')
  })

  it('T-18: runImapPollCron does not dial IMAP directly (relay handles SOCKS5)', () => {
    // Ensures the cron file does not contain direct imapFetchHeaders calls
    // (those would bypass relay SOCKS5 routing). relayImapFetch is the only path.
    const src = readFileSync(IMAP_POLL_CRON, 'utf8')
    expect(src).not.toContain('imapFetchHeaders(')
    expect(src).not.toContain('imapSearchUnseenUids(')
  })

  it('T-19: /api/mailboxes/:id/imap-inbox resolves socksAddr before dialling', () => {
    const src = readServerJs()
    // The endpoint should contain getMailboxSOCKS5Addr call before imapSearchUnseen
    const inboxHandler = src.slice(
      src.indexOf("app.get('/api/mailboxes/:id/imap-inbox'"),
      src.indexOf("app.post('/api/mailboxes/bulk-assign-proxy'")
    )
    expect(inboxHandler).toContain('getMailboxSOCKS5Addr')
    expect(inboxHandler).toContain('imapSearchUnseen(imap_host, Number(imap_port) || 993, username, password, socksAddr)')
  })

  it('T-20: /api/mailboxes/:id/imap-check resolves socksAddr before dialling', () => {
    const src = readServerJs()
    const checkHandler = src.slice(
      src.indexOf("app.get('/api/mailboxes/:id/imap-check'"),
      src.indexOf("app.post('/api/mailboxes/:id/header-probe'")
    )
    expect(checkHandler).toContain('getMailboxSOCKS5Addr')
    expect(checkHandler).toContain('imapCheck(imap_host, imap_port || 993, username, password, socksAddr)')
  })
})
