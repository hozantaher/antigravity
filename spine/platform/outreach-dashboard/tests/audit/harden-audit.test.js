// HARDEN-1..6 — discipline ratchets that lock in the security/safety
// invariants added 2026-04-27. Each test asserts a property of the source
// code itself; if a future edit reverts the hardening, this suite fails.
//
// @linkage-allowed: discipline ratchet — scans source files dynamically

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')

function read(p) {
  return readFileSync(resolve(ROOT, p), 'utf8')
}

describe('HARDEN-1: schema endpoints auth + path safety', () => {
  it('T-1: Go /schema endpoint is wrapped with apiKeyAuth', () => {
    const src = read('../../../features/inbound/orchestrator/web/server.go')
    expect(src).toMatch(/HandleFunc\("\/schema",\s*apiKeyAuth\(/)
  })

  it('T-2: BFF /api/health/test-quality reads via import.meta.url, not process.cwd()', () => {
    // T3.3 (2026-05-01): scan both server.js and the extracted health module
    // (PR #448 multi-file audit support pattern).
    const SOURCES = ['server.js', 'src/server-routes/health.js']
    let hit = false
    for (const path of SOURCES) {
      const src = read(path)
      const start = src.indexOf("app.get('/api/health/test-quality'")
      if (start === -1) continue
      hit = true
      // Match closing `})` at any indent — extracted module wraps handlers in
      // `mountHealthRoutes()` so the closing line is `  })\n` (2-space indent).
      const tail = src.slice(start)
      const closeMatch = tail.match(/\n\s*\}\)\n/)
      const handler = closeMatch
        ? tail.slice(0, closeMatch.index + closeMatch[0].length)
        : tail
      // Path expression resolves to repo-root hallucination-score.json regardless
      // of the host file's location (server.js sits at the dashboard root, the
      // extracted module at src/server-routes/, so the URL path differs).
      expect(handler).toMatch(/new URL\(['"][.\/]*hallucination-score\.json['"],\s*import\.meta\.url\)/)
      // Strip comments before checking — explanatory text mentions process.cwd()
      const codeOnly = handler.replace(/\/\/[^\n]*/g, '')
      expect(codeOnly).not.toMatch(/path\.resolve\(\s*process\.cwd\(\)/)
      expect(codeOnly).not.toMatch(/=\s*process\.cwd\(\)/)
    }
    expect(hit, 'no source file contains /api/health/test-quality handler').toBe(true)
  })
})

describe('HARDEN-2: synthetic-runs cron resilience', () => {
  it('T-3: synthetic cron has in-flight guard', () => {
    const src = read('server.js')
    const cron = src.match(/M2 — Synthetic prod-smoke[\s\S]{0,3500}/)
    expect(cron).toBeTruthy()
    expect(cron[0]).toMatch(/inFlight/)
  })

  it('T-4: synthetic cron has 45s timeout race', () => {
    const src = read('server.js')
    expect(src).toMatch(/synthetic-smoke timeout 45s/)
  })

  it('T-5: synthetic cron checks SKIP_SYNTHETIC_CRON per-tick', () => {
    const src = read('server.js')
    const cron = src.match(/M2 — Synthetic prod-smoke[\s\S]{0,3500}/)
    // Two checks: outer init guard + per-tick runtime check
    const matches = (cron[0].match(/SKIP_SYNTHETIC_CRON/g) || []).length
    expect(matches).toBeGreaterThanOrEqual(2)
  })

  it('T-6: synthetic_runs has 90-day retention sweep', () => {
    const src = read('server.js')
    expect(src).toMatch(/DELETE FROM synthetic_runs WHERE ran_at <\s*now\(\)\s*-\s*interval '90 days'/)
  })
})

describe('HARDEN-3: graceful shutdown handler', () => {
  it('T-7: SIGTERM and SIGINT registered', () => {
    const src = read('server.js')
    expect(src).toMatch(/process\.on\('SIGTERM',\s*\(\)\s*=>\s*shutdown/)
    expect(src).toMatch(/process\.on\('SIGINT',\s*\(\)\s*=>\s*shutdown/)
  })

  it('T-8: shutdown calls httpServer.close + pool.end + markPoolEnded', () => {
    const src = read('server.js')
    expect(src).toMatch(/httpServer\.close/)
    expect(src).toMatch(/pool\.end\(\)/)
    // Zombie-pool guard: markPoolEnded() must be called before pool.end()
    // in the shutdown path so cron ticks that race between pool.end and
    // process.exit see the _poolEnded flag and crash fast.
    expect(src).toMatch(/markPoolEnded\(\)/)
  })

  it('T-9: shutdown has force-exit safety net within Railway grace window', () => {
    const src = read('server.js')
    const m = src.match(/drain exceeded \d+s/)
    expect(m).toBeTruthy()
  })

  it('T-9b: force-timer does NOT use .unref() — must keep event loop alive to fire', () => {
    const src = read('server.js')
    // Extract the shutdown function body to scope the check.
    // .unref() after the forceTimer setTimeout is the bug that caused the
    // timer to silently drop when only cron handles kept the loop alive.
    const shutdownBlock = src.match(/const shutdown = \(signal\)[\s\S]+?^  process\.on\('SIGTERM'/m)?.[0] || ''
    expect(shutdownBlock).not.toMatch(/forceTimer[\s\S]{0,30}\.unref\(\)/)
  })

  it('T-9c: zombie-pool guard functions declared in server.js', () => {
    const src = read('server.js')
    expect(src).toMatch(/function markPoolEnded\s*\(\)/)
    expect(src).toMatch(/function assertPoolAlive\s*\(/)
  })

  it('T-9d: assertPoolAlive wired into timed() and watchdogFromBFF', () => {
    const src = read('server.js')
    // timed() must call assertPoolAlive before executing the cron fn
    const timedFn = src.match(/function timed\(name, fn\)[\s\S]+?^\}/m)?.[0] || ''
    expect(timedFn).toMatch(/assertPoolAlive/)
    // watchdogFromBFF must also guard itself (it's a plain setInterval, not timed())
    const heartbeatFn = src.match(/async function watchdogFromBFF\(\)[\s\S]+?^\}/m)?.[0] || ''
    expect(heartbeatFn).toMatch(/assertPoolAlive/)
  })
})

describe('HARDEN-4: heal-escalation hard latch', () => {
  it('T-10: isAutoHealAllowed returns false whenever escalated=true', () => {
    const src = read('src/lib/heal-escalation.js')
    const fn = src.match(/export function isAutoHealAllowed[\s\S]+?\n\}/)
    expect(fn).toBeTruthy()
    // Old buggy logic checked acknowledged_at; new one only checks escalated.
    expect(fn[0]).not.toMatch(/acknowledged_at/)
    expect(fn[0]).toMatch(/return\s+!state\.escalated/)
  })

  it('T-11: clearEscalation export exists', () => {
    const src = read('src/lib/heal-escalation.js')
    expect(src).toMatch(/export function clearEscalation/)
  })

  it('T-12: clearEscalation requires operator (audit guard)', () => {
    const src = read('src/lib/heal-escalation.js')
    const fn = src.match(/export function clearEscalation[\s\S]+?^\}/m)
    expect(fn[0]).toMatch(/operator required/)
  })
})

describe('HARDEN-5: script SSRF + atomic-write hardening', () => {
  it('T-13: prod-snapshot-capture has body-size cap', () => {
    const src = read('scripts/prod-snapshot-capture.mjs')
    expect(src).toMatch(/MAX_BODY_BYTES/)
    expect(src).toMatch(/text\.length\s*>\s*MAX_BODY_BYTES/)
  })

  it('T-14: flaky-ci-update writes atomically (temp + rename)', () => {
    const src = read('scripts/flaky-ci-update.mjs')
    expect(src).toMatch(/atomicWrite\(HISTORY_PATH/)
    expect(src).toMatch(/atomicWrite\(QUARANTINE_PATH/)
    expect(src).toMatch(/renameSync\(tmp,\s*path\)/)
  })
})

describe('HARDEN-6: boot invariant runner stack trace', () => {
  it('T-15: catch logs full stack trace', () => {
    const src = read('server.js')
    const block = src.match(/\[invariants\] FATAL[\s\S]{0,500}/)
    expect(block).toBeTruthy()
    expect(block[0]).toMatch(/e\.stack/)
  })

  it('T-16: uses captureException (preserves stack) not captureMessage', () => {
    const src = read('server.js')
    const block = src.match(/\[invariants\] FATAL[\s\S]{0,500}/)
    expect(block[0]).toMatch(/Sentry\.captureException/)
  })
})
