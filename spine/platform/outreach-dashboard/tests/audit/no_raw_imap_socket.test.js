// Sprint AO1 — Audit ratchet: no raw net.Socket IMAP dials.
//
// All BFF IMAP code paths must go through dialIMAPViaSOCKS5 (SocksClient +
// TLS) — direct net.Socket().connect(993, imap.seznam.cz) is the
// multi-country login pattern that triggered the nowak.gorak fraud lock.
//
// This ratchet fails if ANY pattern matching direct raw TCP IMAP dial is
// found in server.js. Baseline: 0 violations.
//
// Approach: text scan of server.js for the banned pattern combo.
// The banned pattern is: net.Socket() + .connect(<port>, 'imap.') on the
// same short code block — but since we refactored, ANY new net.Socket usage
// near IMAP is a violation.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SERVER_JS = resolve(__dirname, '../../server.js')

function getSource() {
  return readFileSync(SERVER_JS, 'utf8')
}

// A raw IMAP socket pattern: net.Socket() appears inside an imap-related block.
// We scan for the combination of `new net.Socket()` within 10 lines of
// `.connect(` where the connect target could be an imap host.
// Since our refactor removes ALL net.Socket from IMAP functions, any remaining
// net.Socket in the imap function area is a violation.

function findRawImapSocketViolations(src) {
  const violations = []
  const lines = src.split('\n')

  // Find all occurrences of `new net.Socket()` — each is a candidate.
  // Banned if any of the surrounding 20 lines reference 'imap' in any context
  // (function name, host, comment about IMAP).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('new net.Socket()')) continue

    // Check surrounding context (±20 lines) for imap references
    const start = Math.max(0, i - 20)
    const end = Math.min(lines.length - 1, i + 20)
    const context = lines.slice(start, end + 1).join('\n').toLowerCase()

    if (context.includes('imap')) {
      violations.push({
        lineNumber: i + 1,
        line: line.trim(),
        reason: 'net.Socket() found near IMAP context — must use dialIMAPViaSOCKS5 instead',
      })
    }
  }
  return violations
}

// Also scan src files under src/ (server-routes, lib)
function findRawSocketInSrcFiles() {
  const glob = [
    resolve(__dirname, '../../src/server-routes'),
    resolve(__dirname, '../../src/lib'),
  ]
  const violations = []
  const { readdirSync, statSync } = require('node:fs')

  function scan(dir) {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const full = resolve(dir, entry)
      try {
        if (statSync(full).isDirectory()) { scan(full); continue }
      } catch { continue }
      if (!entry.endsWith('.js') && !entry.endsWith('.ts')) continue
      const src = readFileSync(full, 'utf8')
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('new net.Socket()') && src.toLowerCase().includes('imap')) {
          violations.push({ file: full, lineNumber: i + 1, line: lines[i].trim() })
        }
      }
    }
  }
  for (const dir of glob) scan(dir)
  return violations
}

describe('AO1 audit ratchet: no raw net.Socket IMAP dials', () => {
  it('T-1: server.js has 0 raw net.Socket() near IMAP context (baseline ratchet)', () => {
    const violations = findRawImapSocketViolations(getSource())
    if (violations.length > 0) {
      const detail = violations.map(v => `  line ${v.lineNumber}: ${v.line}`).join('\n')
      throw new Error(
        `AO1 ratchet FAIL: ${violations.length} raw net.Socket() + IMAP violation(s) found.\n` +
        `All IMAP dials must use dialIMAPViaSOCKS5 (SocksClient+TLS).\n` +
        detail
      )
    }
    expect(violations.length).toBe(0)
  })

  it('T-2: src/ files have 0 raw net.Socket() near IMAP context', () => {
    const violations = findRawSocketInSrcFiles()
    if (violations.length > 0) {
      const detail = violations.map(v => `  ${v.file}:${v.lineNumber}: ${v.line}`).join('\n')
      throw new Error(
        `AO1 ratchet FAIL: ${violations.length} raw net.Socket() + IMAP violation(s) in src/.\n` +
        detail
      )
    }
    expect(violations.length).toBe(0)
  })

  it('T-3: dialIMAPViaSOCKS5 function exists in server.js', () => {
    const src = getSource()
    expect(src).toContain('async function dialIMAPViaSOCKS5(')
  })

  it('T-4: getMailboxSOCKS5Addr function exists in server.js', () => {
    const src = getSource()
    expect(src).toContain('async function getMailboxSOCKS5Addr(')
  })

  it('T-5: SocksClient.createConnection is used inside dialIMAPViaSOCKS5', () => {
    const src = getSource()
    // Extract the dialIMAPViaSOCKS5 function body
    const fnStart = src.indexOf('async function dialIMAPViaSOCKS5(')
    const fnEnd = src.indexOf('\nasync function ', fnStart + 1)
    const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000)
    expect(fnBody).toContain('SocksClient.createConnection')
  })

  it('T-6: dialIMAPViaSOCKS5 wraps in TLS (tls.connect)', () => {
    const src = getSource()
    const fnStart = src.indexOf('async function dialIMAPViaSOCKS5(')
    const fnEnd = src.indexOf('\nasync function ', fnStart + 1)
    const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000)
    expect(fnBody).toContain('tls.connect(')
  })

  it('T-7: imapCheck accepts socksAddr parameter (5th argument)', () => {
    const src = getSource()
    expect(src).toMatch(/async function imapCheck\(host, port, username, password, socksAddr\)/)
  })

  it('T-8: imapSearchUnseenUids accepts socksAddr parameter', () => {
    const src = getSource()
    expect(src).toMatch(/async function imapSearchUnseenUids\(host, port, username, password, socksAddr\)/)
  })

  it('T-9: imapFetchHeaders accepts socksAddr parameter (6th argument)', () => {
    const src = getSource()
    expect(src).toMatch(/async function imapFetchHeaders\(host, port, username, password, uids, socksAddr\)/)
  })

  it('T-10: imapFetchByMessageId accepts socksAddr parameter (6th argument)', () => {
    const src = getSource()
    expect(src).toMatch(/async function imapFetchByMessageId\(host, port, username, password, messageId, socksAddr\)/)
  })

  it('T-11: imapSearchUnseen accepts socksAddr parameter', () => {
    const src = getSource()
    expect(src).toMatch(/async function imapSearchUnseen\(host, port, username, password, socksAddr\)/)
  })

  it('T-12: runImapPollCron queries preferred_country column', () => {
    const src = getSource()
    expect(src).toContain('m.preferred_country')
  })

  // T-13/T-14: runImapPollCron moved from server.js → src/crons/runImapPollCron.js
  // (v2 unification) AND switched (2026-05-12, see cron header) from BFF-side
  // direct IMAP dials (imapSearchUnseenUids/imapFetchHeaders + imapSocks) to
  // relay-delegated fetch via relayImapFetch — the relay performs the IMAP dial
  // server-side. The anti-trace guarantee is therefore STRONGER (the BFF cron
  // never opens an IMAP socket at all). The ratchet now verifies that
  // relay-delegation plus the absence of any raw IMAP dial in the cron module.
  it('T-13: runImapPollCron delegates IMAP to the relay (relayImapFetch), no BFF-side dial', () => {
    const cronSrc = readFileSync(resolve(__dirname, '../../src/crons/runImapPollCron.js'), 'utf8')
    expect(cronSrc).toContain('relayImapFetch(')
  })

  it('T-14: runImapPollCron module opens no raw IMAP socket (net.Socket/tls.connect/imap.connect)', () => {
    const cronSrc = readFileSync(resolve(__dirname, '../../src/crons/runImapPollCron.js'), 'utf8')
    expect(cronSrc).not.toMatch(/new net\.Socket\(|tls\.connect\(|imap\.connect\(/)
  })

  it('T-15: relayImapSocksAddr is imported from relayClient.js', () => {
    const src = getSource()
    expect(src).toContain('relayImapSocksAddr,')
  })

  // ── AO5 extensions ─────────────────────────────────────────────────────────
  //
  // These checks extend the AO1 ratchet with coverage for:
  //   - tls.connect outside dialIMAPViaSOCKS5 near IMAP context
  //   - imap.connect() calls (third-party imap lib direct dial)
  //   - src/ files scanned for the same patterns

  it('T-16: tls.connect outside dialIMAPViaSOCKS5 is not near IMAP context in server.js', () => {
    const src = getSource()
    const lines = src.split('\n')

    // Build line ranges for whitelisted functions where tls.connect is permitted.
    // dialIMAPViaSOCKS5: uses tls.connect to wrap a SOCKS5-tunneled socket — approved.
    // smtpSend: AO6 migration complete — now uses HTTP fetch to relay /v1/submit,
    //   no longer uses tls.connect or SocksClient. Whitelist entry removed 2026-05-08.
    const whitelistedFns = ['dialIMAPViaSOCKS5']
    const skipRanges = buildLineRanges(src, whitelistedFns)

    const violations = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.includes('tls.connect(')) continue
      if (isLineInRanges(i + 1, skipRanges)) continue

      const ctx = lines.slice(Math.max(0, i - 15), Math.min(lines.length, i + 15)).join('\n').toLowerCase()
      if (ctx.includes('imap')) {
        violations.push(`line ${i + 1}: ${line.trim()}`)
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `AO5 ratchet FAIL: tls.connect near IMAP context outside approved functions:\n${violations.join('\n')}\n` +
        'All IMAP TLS wrapping must be inside dialIMAPViaSOCKS5.'
      )
    }
    expect(violations.length).toBe(0)
  })

  it('T-17: no imap.connect() library calls in server.js (direct imap lib banned)', () => {
    const src = getSource()
    // Third-party IMAP libraries expose imap.connect() or new Imap({ ... }).connect().
    // Any such call bypasses the SOCKS5 path.
    const banned = /(?:imap\.connect\s*\(|new\s+Imap\s*\()/i
    const lines = src.split('\n')
    const violations = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => banned.test(line))
      .map(({ line, i }) => `line ${i + 1}: ${line.trim()}`)

    if (violations.length > 0) {
      throw new Error(
        `AO5 ratchet FAIL: direct IMAP library call found (banned — bypasses SOCKS5):\n${violations.join('\n')}`
      )
    }
    expect(violations.length).toBe(0)
  })

  it('T-18: no imap.connect() library calls in src/ files', () => {
    const banned = /(?:imap\.connect\s*\(|new\s+Imap\s*\()/i
    const violations = findPatternInSrcFiles(banned)
    if (violations.length > 0) {
      const detail = violations.map(v => `  ${v.file}:${v.lineNumber}: ${v.line}`).join('\n')
      throw new Error(`AO5 ratchet FAIL: direct IMAP library call in src/:\n${detail}`)
    }
    expect(violations.length).toBe(0)
  })
})

// ── AO5 helpers (only used by T-16/17/18) ────────────────────────────────────

function buildLineRanges(src, functionNames) {
  const lines = src.split('\n')
  const ranges = []
  for (const fnName of functionNames) {
    let startLine = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`function ${fnName}(`)) { startLine = i + 1; break }
    }
    if (startLine === -1) continue
    let depth = 0
    let inFn = false
    let endLine = startLine
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

function isLineInRanges(lineNum, ranges) {
  return ranges.some(r => lineNum >= r.start && lineNum <= r.end)
}

function findPatternInSrcFiles(pattern) {
  const { readdirSync, statSync, readFileSync } = require('node:fs')
  const { resolve } = require('node:path')
  const dirs = [
    resolve(__dirname, '../../src/server-routes'),
    resolve(__dirname, '../../src/lib'),
  ]
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
      const src = readFileSync(full, 'utf8')
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          violations.push({ file: full, lineNumber: i + 1, line: lines[i].trim() })
        }
      }
    }
  }
  for (const d of dirs) scan(d)
  return violations
}
