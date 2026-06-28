// AT-F1 audit ratchet — server.js MUST wire BFF resilience handlers so
// transient PG errors (ETIMEDOUT from junction.proxy.rlwy.net) + stray
// rejections do not crash the BFF process. `node --watch` does not
// auto-restart on uncaught crashes — it only restarts on file changes —
// so a single crash leaves the dashboard dead until manual intervention.
//
// Verified contract:
//   1. pool.on('error', ...)             — pg idle-client error swallow
//   2. process.on('uncaughtException')   — process-level safety net
//   3. process.on('unhandledRejection')  — async-rejection safety net
//   4. keepAlive: true on pg.Pool        — addresses root cause (idle timeout)
//
// Why a static grep is sufficient: this is server-startup wiring that
// must exist at the source level — no plausible refactor removes these
// without manifest intent. The contract test covers run-time behavior.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SERVER_JS = resolve(__dirname, '../../server.js')

describe('audit: BFF resilience (AT-F1)', () => {
  const src = readFileSync(SERVER_JS, 'utf8')

  it('attaches pool.on(\'error\', ...) to swallow pg idle-client errors', () => {
    // Match `pool.on('error', ...)` or `pool.on("error", ...)`.
    expect(src).toMatch(/pool\.on\(\s*['"]error['"]\s*,/)
  })

  it('registers a process-level uncaughtException handler', () => {
    expect(src).toMatch(/process\.on\(\s*['"]uncaughtException['"]\s*,/)
  })

  it('registers a process-level unhandledRejection handler', () => {
    expect(src).toMatch(/process\.on\(\s*['"]unhandledRejection['"]\s*,/)
  })

  it('enables keepAlive on the pg.Pool to prevent idle ETIMEDOUT', () => {
    expect(src).toMatch(/keepAlive\s*:\s*true/)
  })

  it('uses a named constant for the keepAlive initial delay (no magic number)', () => {
    // feedback_no_magic_thresholds (T0) — operator must be able to find
    // + tune the value without reading inline literals.
    expect(src).toMatch(/PG_KEEPALIVE_INITIAL_DELAY_MS/)
  })
})
