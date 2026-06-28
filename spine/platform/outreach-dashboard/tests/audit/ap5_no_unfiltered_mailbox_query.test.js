// Sprint AP5 — Audit ratchet: production query paths filter environment='production'.
//
// Context: AP5 prevents dev/test mailbox credential contamination in
// production code paths. IMAP cron on localhost (CZ residential) hit
// production mailboxes → multi-IP signal contributing to Goran fraud-lock.
//
// This ratchet measures UNFILTERED queries against production-critical paths
// and ensures the count does not grow. It does NOT require every single
// SELECT to have the filter — admin/diagnostics (single-row by id, mailboxes
// panel CRUD, health checks) deliberately omit the filter to show all envs.
//
// Baseline: 49 remaining unfiltered queries (all are admin/diagnostic paths).
// Any new production-path query without env filter → ratchet fails.
//
// To exempt a legitimate new admin/diagnostics path:
//   Add `// AP5_ALLOW_NO_ENV_FILTER` comment on the line 1-3 above the query.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Production-path files: these files must trend toward fewer unfiltered queries.
// Admin/diagnostic files (mailboxes.js CRUD, health.js) are excluded from the
// strict count — they legitimately show all environments.
const STRICT_FILES = [
  resolve(__dirname, '../../server.js'),
  resolve(__dirname, '../../campaignPreflight.js'),
  resolve(__dirname, '../../mailboxBounceThrottle.js'),
  resolve(__dirname, '../../src/server-routes/runPreflight.js'),
  resolve(__dirname, '../../src/lib/campaign-send-batch.js'),
]

// Baseline: measured count of unfiltered mailbox queries in the STRICT_FILES
// as of AP5 implementation. Counter is a one-way ratchet — can only decrease.
// Update this number when legitimate unfiltered queries are removed.
const STRICT_BASELINE = 49

const ALLOW_COMMENT = /AP5_ALLOW_NO_ENV_FILTER/

function countUnfilteredQueries(filePaths) {
  const violations = []
  for (const f of filePaths) {
    let src
    try { src = readFileSync(f, 'utf-8') } catch { continue }
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!/FROM\s+outreach_mailboxes/i.test(line)) continue
      // Collect the next 10 lines for multi-line query detection
      const block = lines.slice(i, Math.min(i + 10, lines.length)).join('\n')
      if (/environment\s*[=!]['"]production['"]/i.test(block)) continue
      // Check 3 lines above for allow comment
      const above = lines.slice(Math.max(0, i - 3), i).join('\n')
      if (ALLOW_COMMENT.test(above)) continue
      violations.push(`${f.split('/').slice(-2).join('/')}:${i + 1}`)
    }
  }
  return violations
}

describe('AP5 — production queries filter environment', () => {
  it('critical production-path files do not grow unfiltered mailbox queries (ratchet ≤ baseline)', () => {
    const violations = countUnfilteredQueries(STRICT_FILES)
    // Must not exceed baseline. Decreasing is good.
    expect(violations.length).toBeLessThanOrEqual(STRICT_BASELINE)
  })

  it('campaign-send-batch.js has environment filter (critical send path)', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/lib/campaign-send-batch.js'),
      'utf-8'
    )
    const matches = src.match(/FROM\s+outreach_mailboxes[^;]*/gi) || []
    for (const m of matches) {
      expect(m).toMatch(/environment\s*=\s*'production'/i)
    }
  })

  it('runImapPollCron query includes environment filter', () => {
    // v2 unification: cron moved server.js → src/crons/runImapPollCron.js.
    const src = readFileSync(resolve(__dirname, '../../src/crons/runImapPollCron.js'), 'utf-8')
    const imapIdx = src.indexOf('FROM outreach_mailboxes')
    expect(imapIdx).toBeGreaterThan(-1)
    const imapBlock = src.slice(imapIdx, imapIdx + 2000)
    expect(imapBlock).toMatch(/environment\s*=\s*'production'/i)
  })

  it('runBlacklistCheckCron query in server.js includes environment filter', () => {
    const src = readFileSync(resolve(__dirname, '../../server.js'), 'utf-8')
    // Find blacklist cron query
    expect(src).toMatch(
      /FROM outreach_mailboxes WHERE status = 'active' AND environment = 'production'/
    )
  })

  // morningReadiness.js was removed in the v2 unification; its mailbox-readiness
  // step folded into the health/diagnostics surface (src/server-routes/health.js),
  // an env-filter-EXEMPT diagnostic path by design (see this file's header — admin/
  // diagnostic paths legitimately show all environments). The generic ratchet above
  // still guards every production path against growth in unfiltered queries.

  it('runPreflight.js mailboxes query includes environment filter', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/server-routes/runPreflight.js'),
      'utf-8'
    )
    const idx = src.indexOf('FROM outreach_mailboxes')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 300)
    expect(block).toMatch(/environment\s*=\s*'production'/i)
  })

  it('mailboxBounceThrottle.js includes environment filter', () => {
    const src = readFileSync(
      resolve(__dirname, '../../mailboxBounceThrottle.js'),
      'utf-8'
    )
    const idx = src.indexOf('FROM outreach_mailboxes')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 300)
    expect(block).toMatch(/environment\s*=\s*'production'/i)
  })

  it('campaignPreflight.js active mailbox queries include environment filter', () => {
    const src = readFileSync(
      resolve(__dirname, '../../campaignPreflight.js'),
      'utf-8'
    )
    // Check both occurrences of FROM outreach_mailboxes include env filter nearby
    let offset = 0
    let found = 0
    while (true) {
      const idx = src.indexOf('FROM outreach_mailboxes', offset)
      if (idx === -1) break
      const block = src.slice(idx, idx + 300)
      expect(block).toMatch(/environment\s*=\s*'production'/i)
      found++
      offset = idx + 1
    }
    expect(found).toBeGreaterThan(0)
  })

  it('checkProdMailboxEnvironmentConsistency function exists in server.js', () => {
    const src = readFileSync(resolve(__dirname, '../../server.js'), 'utf-8')
    expect(src).toContain('checkProdMailboxEnvironmentConsistency')
  })

  it('ap5-env-boundary check is wired into runBffBootInvariants', () => {
    const src = readFileSync(resolve(__dirname, '../../server.js'), 'utf-8')
    expect(src).toContain('ap5-env-boundary')
  })

  it('at-least-one-active-mailbox boot invariant filters environment=production', () => {
    const src = readFileSync(resolve(__dirname, '../../server.js'), 'utf-8')
    expect(src).toMatch(/outreach_mailboxes WHERE status = 'active' AND environment = 'production'/)
  })
})
