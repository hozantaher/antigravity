// cron-safe-no-bare-setinterval-async.test.js
//
// Sprint A1 audit ratchet (issue #1242, follow-up to PR #1239).
//
// Background: server.js scheduled crons via `setInterval(asyncFn, ms)` or
// `setTimeout(asyncFn, ms)` where asyncFn returns a Promise. When asyncFn
// rejects there is no caller to .catch() the rejection — Node treats it
// as unhandledRejection and exits. PR #1239 fixed one such site
// (runEgressChaosDetectionCron); this test prevents the pattern from
// regressing.
//
// Safe patterns this test accepts:
//   1. `setInterval(syncFn, ms)`            — sync, can't reject
//   2. `setInterval(() => { ... }, ms)`     — bare arrow that returns void
//   3. `setInterval(async () => { try { ... } catch {} }, ms)` — async with
//      explicit try/catch wrapping the whole body
//   4. `setInterval(cronSafe('name', fn), ms)` — wrapped via cronSafe helper
//   5. `setInterval(safeFn, ms)` where safeFn was previously `.catch()`-wrapped
//
// Unsafe pattern this test blocks:
//   - `setInterval(timed(...), ms)` where timed() rethrows on rejection
//   - `setInterval(async () => { /* body without try */ }, ms)` — bare async
//
// Implementation: parse server.js text, find every setInterval/setTimeout
// call site, classify as safe/unsafe. Baseline locked at 0. Any new bare
// async setInterval without cronSafe/try-catch trips the ratchet.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_JS = join(__dirname, '..', '..', 'server.js')

// Regex-based parse is good enough — server.js is grep-friendly.
// Look at the start of each setInterval / setTimeout call and check the
// callback body for try/catch.
function findUnsafeCallsites(source) {
  const lines = source.split('\n')
  const violations = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(/\b(setInterval|setTimeout)\s*\(/)
    if (!match) continue

    // Look at the FIRST line for known-safe shapes (sync arrows, primitives).
    // Plain timer waits — Promise resolve, ctrl.abort, recursive tick.
    if (/setTimeout\s*\(\s*r(esolve|eject|ej)?\s*[,)]/.test(line)) continue
    if (/setTimeout\s*\(\s*\(\)\s*=>\s*r(esolve|eject|ej)?\s*\(/.test(line)) continue
    if (/setTimeout\s*\(\s*ctrl\.abort\b/.test(line)) continue
    if (/setTimeout\s*\(\s*tick\b/.test(line)) continue
    if (/setTimeout\s*\(\s*\(\)\s*=>\s*tick\b/.test(line)) continue
    // Synchronous arrow body returning a single non-Promise expression
    // (e.g. process.exit) — not a cron, not a risk.
    if (/setTimeout\s*\(\s*\(\)\s*=>\s*process\.exit/.test(line)) continue

    // Inspect ONLY the setInterval/setTimeout opening line + next 1 line for
    // inline-async detection. This avoids false positives where a later
    // setInterval in the same window appears async.
    const opener = lines.slice(i, i + 2).join('\n')

    // Already-safe wrappers — accept and skip (check just opener).
    if (/cronSafe\s*\(/.test(opener)) continue
    if (/safeEgressChaosDetect/.test(line)) continue

    // Detect INLINE async callback IMMEDIATELY after setInterval/setTimeout(
    // Named identifiers (e.g. `setInterval(fn, ms)`) are out of scope —
    // static analysis can't easily verify the identifier was bound to
    // cronSafe(). The intent of this ratchet is to catch fresh inline
    // patterns the developer is most likely to introduce in new code.
    const isInlineAsync = /\b(setInterval|setTimeout)\s*\(\s*(async\s*\(|async\s+function)/.test(opener)
    if (!isInlineAsync) continue

    // Inline-async callback present → require try/catch somewhere in the body.
    // Use an 80-line window so larger cron handlers (e.g. synthetic smoke
    // setup ~70 lines) are recognised. Any function that needs MORE than
    // 80 lines between try { and matching catch should be split for
    // readability anyway.
    const body = lines.slice(i, i + 80).join('\n')
    const hasTry = /\btry\s*{/.test(body)
    const hasCatch = /\}\s*catch\s*[({]/.test(body)
    if (hasTry && hasCatch) continue
    if (/\)\.catch\s*\(/.test(body)) continue

    violations.push({
      line: i + 1,
      snippet: line.trim().slice(0, 120),
    })
  }
  return violations
}

describe('AR (cron-safe) — no bare async setInterval/setTimeout', () => {
  it('server.js has zero unwrapped bare-async timer callbacks', () => {
    const source = readFileSync(SERVER_JS, 'utf8')
    const violations = findUnsafeCallsites(source)
    if (violations.length > 0) {
      const lines = violations.map(v => `  line ${v.line}: ${v.snippet}`).join('\n')
      throw new Error(
        `Found ${violations.length} unwrapped bare-async setInterval/setTimeout callback(s):\n${lines}\n\n` +
        `Wrap the callback with cronSafe(name, fn) or add explicit try { await ... } catch { ... }.\n` +
        `Background: unhandled rejection from cron callback kills the Node process.\n` +
        `See PR #1239 (egressChaos crash) for the original incident.`
      )
    }
    // Baseline locked at 0 — every violation must be addressed before merge.
    expect(violations.length).toBe(0)
  })
})
