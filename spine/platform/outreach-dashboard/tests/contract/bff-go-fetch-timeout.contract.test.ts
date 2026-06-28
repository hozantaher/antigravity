// ═══════════════════════════════════════════════════════════════════════════
//  F2-4 — every BFF→Go fetch on the operator hot path must carry a
//         per-request AbortSignal/timeout.
//
//  Pre-fix: POST /api/campaigns, POST /api/campaigns/:id/run, POST
//  /api/campaigns/:id/pause did `await fetch(GO_SERVER_URL/...)` with
//  no signal. A slow / hung Go upstream would hang the operator's
//  click indefinitely.
//
//  Goes RED if anyone removes the signal from these specific call sites.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Post-T3.4: campaigns endpoints extracted to src/server-routes/campaigns.js.
const SERVER_JS = readFileSync(join(__dirname, '..', '..', 'src', 'server-routes', 'campaigns.js'), 'utf8')

// Slice out the handler region for an /api/campaigns/* fetch and
// verify it has a `signal:` line within the fetch options.
function handlerSliceWithFetch(serverJs: string, after: string, withinChars = 1500): string {
  const idx = serverJs.indexOf(after)
  if (idx < 0) throw new Error(`anchor not found: ${after}`)
  return serverJs.slice(idx, idx + withinChars)
}

describe('F2-4 — BFF→Go hot-path fetches must have AbortSignal/timeout', () => {
  it('1: POST /api/campaigns Go fetch carries a signal', () => {
    const region = handlerSliceWithFetch(
      SERVER_JS,
      "fetch(`${goURL.replace(/\\/$/, '')}/api/campaigns`",
      400,
    )
    expect(region, 'POST /api/campaigns Go fetch must include signal: AbortSignal.timeout(...)').toMatch(
      /signal:\s*AbortSignal\.timeout\(/,
    )
  })

  it('2: POST /api/campaigns/:id/run Go fetch carries a signal', () => {
    const region = handlerSliceWithFetch(
      SERVER_JS,
      '/api/campaigns/${req.params.id}/run',
      400,
    )
    expect(region, '/run Go fetch must include signal: AbortSignal.timeout(...)').toMatch(
      /signal:\s*AbortSignal\.timeout\(/,
    )
  })

  it('3: POST /api/campaigns/:id/pause Go fetch carries a signal', () => {
    const region = handlerSliceWithFetch(
      SERVER_JS,
      '/api/campaigns/${req.params.id}/pause',
      400,
    )
    expect(region, '/pause Go fetch must include signal: AbortSignal.timeout(...)').toMatch(
      /signal:\s*AbortSignal\.timeout\(/,
    )
  })

  it('4: timeout is at most 30s (operator click should not wait longer)', () => {
    // Find every fetch with signal: AbortSignal.timeout(N) and assert N<=30000.
    const re = /signal:\s*AbortSignal\.timeout\(([\d_]+)\)/g
    const found: number[] = []
    let m
    while ((m = re.exec(SERVER_JS)) !== null) {
      const n = Number(m[1].replace(/_/g, ''))
      found.push(n)
    }
    expect(found.length, 'no AbortSignal.timeout(...) calls found in server.js').toBeGreaterThan(0)
    for (const n of found) {
      expect(n, `AbortSignal.timeout(${n}) > 30s — operator click can't wait that long`).toBeLessThanOrEqual(30_000)
    }
  })

  it('5: timeout for the 3 hot paths is at most 10s', () => {
    // Tight cap on the create/run/pause hot paths specifically.
    for (const anchor of [
      "fetch(`${goURL.replace(/\\/$/, '')}/api/campaigns`",
      '/api/campaigns/${req.params.id}/run',
      '/api/campaigns/${req.params.id}/pause',
    ]) {
      const region = handlerSliceWithFetch(SERVER_JS, anchor, 600)
      const m = region.match(/signal:\s*AbortSignal\.timeout\(([\d_]+)\)/)
      expect(m, `timeout missing for anchor: ${anchor}`).not.toBeNull()
      const n = Number(m![1].replace(/_/g, ''))
      expect(n, `hot-path timeout ${n}ms exceeds 10s`).toBeLessThanOrEqual(10_000)
    }
  })
})
