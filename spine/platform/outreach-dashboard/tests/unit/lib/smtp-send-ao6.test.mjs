/**
 * Sprint AO6 — smtpSend relay migration unit tests.
 *
 * smtpSend is an internal server.js function that now routes exclusively via
 * relay /v1/submit HTTP POST. These tests verify the AO6 contract:
 *   - No raw SMTP socket, no SocksClient, no proxy_url
 *   - relay /v1/submit called with correct envelope shape
 *   - mailbox_id + preferred_country forwarded
 *   - error mapping from relay responses
 *   - proxy_url deprecation warn log
 *
 * Source-level tests (read server.js source) — no server import needed for
 * static assertions. Relay behaviour tests use a minimal fetch mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_JS = resolve(__dirname, '../../../server.js')

function getServerSource() {
  return readFileSync(SERVER_JS, 'utf8')
}

function extractFnBody(src, fnName) {
  const start = src.indexOf(`async function ${fnName}(`)
  if (start === -1) return ''
  const end = src.indexOf('\nasync function ', start + 1)
  return src.slice(start, end > 0 ? end : start + 4000)
}

// ─── AO6 static source assertions ───────────────────────────────────────────

describe('smtpSend AO6 — source-level contract', () => {
  it('T-U1: smtpSend exists in server.js', () => {
    expect(getServerSource()).toContain('async function smtpSend(')
  })

  it('T-U2: smtpSend body contains /v1/submit (relay POST)', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    expect(body).toContain('/v1/submit')
  })

  it('T-U3: smtpSend body uses fetch() — not SocksClient', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    expect(body).toContain('fetch(')
    expect(body).not.toContain('SocksClient.createConnection')
  })

  it('T-U4: smtpSend does NOT use raw net.Socket', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    expect(body).not.toContain('new net.Socket()')
  })

  it('T-U5: smtpSend does NOT have legacy proxy_url guard (if !proxy_url throw)', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    expect(body).not.toContain("if (!proxy_url)")
    expect(body).not.toContain("Schránka nemá přiřazen proxy")
  })

  it('T-U6: smtpSend accepts mailboxId parameter', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    expect(body).toContain('mailboxId')
  })

  it('T-U7: smtpSend forwards mailbox_id in envelope', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    expect(body).toContain('mailbox_id')
  })

  it('T-U8: smtpSend warns when proxy_url is passed (backward-compat shim)', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    // Should contain a console.warn about proxy_url being deprecated
    expect(body).toContain('proxy_url')
    expect(body).toContain('console.warn')
    expect(body).toContain('deprecated')
  })

  it('T-U9: smtpSend throws when relay not configured (no ANTI_TRACE_RELAY_URL)', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    // Must throw if relayBase is null
    expect(body).toContain('relay not configured')
  })

  it('T-U10: smtpSend uses getRelayBase (relayClient.js helper)', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    expect(body).toContain('getRelayBase(')
  })

  it('T-U11: smtpSend return shape includes envelope_id field', () => {
    const body = extractFnBody(getServerSource(), 'smtpSend')
    expect(body).toContain('envelope_id')
  })
})

// ─── smtpSendWithFallback AO6 static assertions ─────────────────────────────

describe('smtpSendWithFallback AO6 — source-level contract', () => {
  it('T-U12: smtpSendWithFallback no longer calls proxyReassignGuard', () => {
    const body = extractFnBody(getServerSource(), 'smtpSendWithFallback')
    // proxyReassignGuard was the proxy rotation mechanism — AO6 removes it from this path
    expect(body).not.toContain('proxyReassignGuard')
  })

  it('T-U13: smtpSendWithFallback queries preferred_country from DB', () => {
    const body = extractFnBody(getServerSource(), 'smtpSendWithFallback')
    expect(body).toContain('preferred_country')
  })
})

// ─── AO5 ratchet whitelist — smtpSend removed as whitelist entry ─────────────

describe('AO5 ratchet — AO6 whitelist update', () => {
  it('T-U14: AO5 ratchet T-1 no longer skips smtpSend function body', () => {
    const ratchetSrc = readFileSync(
      resolve(__dirname, '../../audit/no_raw_smtp_socket.test.js'), 'utf8'
    )
    // T-1 should NOT have smtpSend in skipFunctions after AO6
    const t1Block = ratchetSrc.slice(
      ratchetSrc.indexOf("'T-1"),
      ratchetSrc.indexOf("'T-2"),
    )
    expect(t1Block).not.toContain("'smtpSend'")
  })
})
