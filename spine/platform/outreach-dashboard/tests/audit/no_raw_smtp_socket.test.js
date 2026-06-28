// Sprint AO5 — Audit ratchet: no raw SMTP socket dials outside the approved whitelist.
//
// Rule: any new raw SMTP connection attempt (net.Socket + connect to port 25/465/587,
// tls.connect targeting an smtp host, or nodemailer/createTransport with a direct
// host without SOCKS5 proxy routing) must go through the relay service (relaySmtpCheck /
// relaySmtpAuthProbe from src/lib/relayClient.js) — not direct socket.
//
// Whitelist (AO6 — updated 2026-05-08):
//   server.js :: smtpSend — AO6 migration COMPLETE. smtpSend now posts to relay
//     /v1/submit via HTTP. No raw socket, no SocksClient, no proxy_url. The old
//     proxy_url guard is removed; relay owns all routing.
//   server.js :: dialIMAPViaSOCKS5 — IMAP via SOCKS5, not SMTP. tls.connect is for IMAP
//     TLS wrapping. Covered by the IMAP ratchet (no_raw_imap_socket.test.js).
//   server.js :: smtpCheck — delegates to relaySmtpCheck from relayClient.js (approved).
//
// Baseline: 0 violations outside whitelist.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const SERVER_JS = resolve(__dirname, '../../server.js')
const SRC_DIR = resolve(__dirname, '../../src')

function getServerSource() {
  return readFileSync(SERVER_JS, 'utf8')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns lines from src that look like a direct SMTP connection outside
 * relayClient delegation.
 *
 * Banned patterns (outside whitelist context):
 *   1. new net.Socket() near 'smtp' context — AO5 SMTP side of AO1
 *   2. nodemailer.createTransport({ host: ..., port: 465|587 }) without socks
 *   3. SocksClient.createConnection near smtp host — only allowed inside smtpSend
 *      (which requires proxy_url from DB)
 */
function findDirectSMTPPatterns(src, options = {}) {
  const { skipFunctions = [] } = options
  const lines = src.split('\n')
  const violations = []

  // Build skip ranges for whitelisted function bodies.
  const skipRanges = buildSkipRanges(src, skipFunctions)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Skip if inside a whitelisted function body.
    if (isInSkipRange(lineNum, skipRanges)) continue

    // Pattern 1: new net.Socket() near SMTP context.
    if (line.includes('new net.Socket()')) {
      const context = getSurroundingContext(lines, i, 20).toLowerCase()
      if (context.includes('smtp') || context.includes('mail from') || context.includes('ehlo')) {
        violations.push({
          lineNumber: lineNum,
          line: line.trim(),
          reason: 'new net.Socket() near SMTP context — must use relaySmtpCheck from relayClient.js',
        })
      }
    }

    // Pattern 2: nodemailer createTransport with direct host (not via relay).
    if (/nodemailer\.createTransport\s*\(/.test(line) || /createTransport\s*\(\s*\{/.test(line)) {
      const context = getSurroundingContext(lines, i, 5)
      if (/port\s*:\s*(?:25|465|587)/.test(context) && !context.includes('relay')) {
        violations.push({
          lineNumber: lineNum,
          line: line.trim(),
          reason: 'nodemailer.createTransport with direct SMTP port — route through relay instead',
        })
      }
    }
  }

  return violations
}

/**
 * Scans server.js to ensure smtpCheck delegates to relaySmtpCheck (not a raw dial).
 */
function verifySmtpCheckDelegation(src) {
  const fnStart = src.indexOf('async function smtpCheck(')
  if (fnStart === -1) return { found: false, delegatesToRelay: false }

  const fnEnd = src.indexOf('\nasync function ', fnStart + 1)
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 500)

  return {
    found: true,
    delegatesToRelay: fnBody.includes('relaySmtpCheck('),
  }
}

/**
 * Sprint AO6: smtpSend no longer uses SocksClient or proxy_url.
 * Verifies it delegates to relay /v1/submit via HTTP fetch (not raw socket).
 */
function verifySmtpSendUsesRelay(src) {
  const fnStart = src.indexOf('async function smtpSend(')
  if (fnStart === -1) return { found: false, usesRelay: false, hasRawSocket: false, usesSOCKS: false }

  const fnEnd = src.indexOf('\nasync function ', fnStart + 1)
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000)

  return {
    found: true,
    // Must POST to relay /v1/submit — not raw socket.
    usesRelay: fnBody.includes('/v1/submit') && fnBody.includes('fetch('),
    // Must NOT use SocksClient (AO6 removal).
    usesSOCKS: fnBody.includes('SocksClient.createConnection'),
    hasRawSocket: fnBody.includes('new net.Socket()'),
    // Must NOT have proxy_url guard (that was the old AO5 requirement pre-AO6).
    hasLegacyProxyGuard: fnBody.includes('if (!proxy_url)'),
  }
}

/**
 * Scan src/ files for raw SMTP patterns.
 */
function findRawSmtpInSrcFiles() {
  const violations = []

  function scan(dir) {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const full = resolve(dir, entry)
      try {
        if (statSync(full).isDirectory()) { scan(full); continue }
      } catch { continue }
      if (!entry.endsWith('.js') && !entry.endsWith('.ts')) continue
      // relayClient.js is the approved SMTP egress — skip.
      if (full.endsWith('relayClient.js')) continue

      const src = readFileSync(full, 'utf8')
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Direct SMTP nodemailer without relay.
        if (/nodemailer\.createTransport/.test(line)) {
          const ctx = getSurroundingContext(lines, i, 5)
          if (/port\s*:\s*(?:25|465|587)/.test(ctx) && !ctx.includes('relay')) {
            violations.push({ file: full, lineNumber: i + 1, line: line.trim() })
          }
        }
        // net.Socket near SMTP context in src files.
        if (line.includes('new net.Socket()')) {
          const ctx = getSurroundingContext(lines, i, 20).toLowerCase()
          if (ctx.includes('smtp') || ctx.includes('mail from') || ctx.includes('ehlo')) {
            violations.push({ file: full, lineNumber: i + 1, line: line.trim() })
          }
        }
      }
    }
  }

  scan(SRC_DIR)
  return violations
}

// ── Utility ───────────────────────────────────────────────────────────────────

function getSurroundingContext(lines, idx, radius) {
  const start = Math.max(0, idx - radius)
  const end = Math.min(lines.length - 1, idx + radius)
  return lines.slice(start, end + 1).join('\n')
}

/**
 * Builds line ranges to skip for named function bodies.
 * Simple brace-counting parser — good enough for audit purposes.
 */
function buildSkipRanges(src, functionNames) {
  const ranges = []
  const lines = src.split('\n')

  for (const fnName of functionNames) {
    const searchStr = `function ${fnName}(`
    let startLine = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(searchStr)) { startLine = i + 1; break }
    }
    if (startLine === -1) continue

    // Count braces to find the end of this function.
    let depth = 0
    let endLine = startLine
    let inFn = false
    for (let i = startLine - 1; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') { depth++; inFn = true }
        else if (ch === '}') depth--
      }
      if (inFn && depth === 0) { endLine = i + 1; break }
    }
    ranges.push({ start: startLine, end: endLine })
  }
  return ranges
}

function isInSkipRange(lineNum, ranges) {
  return ranges.some(r => lineNum >= r.start && lineNum <= r.end)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AO5 audit ratchet: no raw SMTP socket dials', () => {
  it('T-1: server.js has 0 new net.Socket() near SMTP context (smtpSend is now relay-only — AO6)', () => {
    const violations = findDirectSMTPPatterns(getServerSource(), {
      // AO6: smtpSend no longer uses raw sockets — removed from whitelist.
      // dialIMAPViaSOCKS5 still uses SocksClient+TLS for IMAP (covered by IMAP ratchet).
      skipFunctions: ['dialIMAPViaSOCKS5'],
    })
    if (violations.length > 0) {
      const detail = violations.map(v => `  line ${v.lineNumber}: ${v.line}\n    reason: ${v.reason}`).join('\n')
      throw new Error(
        `AO5 ratchet FAIL: ${violations.length} raw SMTP socket pattern(s) found outside whitelist.\n${detail}`
      )
    }
    expect(violations.length).toBe(0)
  })

  it('T-2: src/ files have 0 raw SMTP socket dials', () => {
    const violations = findRawSmtpInSrcFiles()
    if (violations.length > 0) {
      const detail = violations.map(v => `  ${v.file}:${v.lineNumber}: ${v.line}`).join('\n')
      throw new Error(
        `AO5 ratchet FAIL: ${violations.length} raw SMTP pattern(s) in src/.\n${detail}`
      )
    }
    expect(violations.length).toBe(0)
  })

  it('T-3: smtpCheck function exists in server.js', () => {
    expect(getServerSource()).toContain('async function smtpCheck(')
  })

  it('T-4: smtpCheck delegates to relaySmtpCheck (not a raw dial)', () => {
    const result = verifySmtpCheckDelegation(getServerSource())
    expect(result.found).toBe(true)
    expect(result.delegatesToRelay).toBe(true)
  })

  it('T-5: relaySmtpCheck is imported from relayClient.js', () => {
    const src = getServerSource()
    expect(src).toContain('relaySmtpCheck,')
  })

  it('T-6: smtpSend function exists in server.js', () => {
    expect(getServerSource()).toContain('async function smtpSend(')
  })

  it('T-7 (AO6): smtpSend posts to relay /v1/submit — no raw socket, no proxy_url guard', () => {
    const result = verifySmtpSendUsesRelay(getServerSource())
    expect(result.found).toBe(true)
    expect(result.usesRelay).toBe(true)
    expect(result.hasLegacyProxyGuard).toBe(false)
  })

  it('T-8 (AO6): smtpSend does NOT use SocksClient or raw net.Socket', () => {
    const result = verifySmtpSendUsesRelay(getServerSource())
    expect(result.usesSOCKS).toBe(false)
    expect(result.hasRawSocket).toBe(false)
  })

  it('T-9: socks5Probe delegates to relaySocks5Probe (not raw dial)', () => {
    const src = getServerSource()
    const fnStart = src.indexOf('async function socks5Probe(')
    const fnEnd = src.indexOf('\nasync function ', fnStart + 1)
    const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 300)
    expect(fnBody).toContain('relaySocks5Probe(')
  })

  it('T-10: no nodemailer.createTransport with direct SMTP port in server.js', () => {
    const src = getServerSource()
    // nodemailer with direct port 25/465/587 outside relay would be a violation.
    const lines = src.split('\n')
    const violations = []
    for (let i = 0; i < lines.length; i++) {
      if (/nodemailer\.createTransport/.test(lines[i])) {
        const ctx = getSurroundingContext(lines, i, 5)
        if (/port\s*:\s*(?:25|465|587)/.test(ctx) && !ctx.includes('relay')) {
          violations.push(`line ${i + 1}: ${lines[i].trim()}`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(`AO5: nodemailer direct SMTP found:\n${violations.join('\n')}`)
    }
    expect(violations.length).toBe(0)
  })
})
