// Audit ratchet: every server-route that CALLS clampInt() must IMPORT it.
//
// Incident (2026-05-31): clampInt was extracted to src/lib/clampInt.js and call
// sites refactored, but 4 of 6 server-route files (companies, prospects, leads,
// dedupGuard) never got the import. `clampInt is not defined` → HTTP 500 on
// /api/prospects/top, /api/dedup-guard/recent-skips, /api/leads, and a latent
// 500 on /api/companies/score-trends. A missing import is a runtime ReferenceError
// only surfaced when the endpoint is hit — exactly the class a static ratchet
// should catch at commit time, not a breadth screenshot days later.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROUTES_DIR = resolve(__dirname, '../../src/server-routes')

describe('audit: server-routes using clampInt() must import it', () => {
  const files = readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js'))

  for (const f of files) {
    const src = readFileSync(join(ROUTES_DIR, f), 'utf8')
    const calls = /\bclampInt\s*\(/.test(src)
    if (!calls) continue
    it(`${f} imports clampInt (it calls it)`, () => {
      const imports = /import\s*\{[^}]*\bclampInt\b[^}]*\}\s*from\s*['"][^'"]*clampInt(\.js)?['"]/.test(src)
      expect(imports).toBe(true)
    })
  }

  it('covers at least the known callers', () => {
    // sanity: the scan found server-routes that call clampInt
    const callers = files.filter(f =>
      /\bclampInt\s*\(/.test(readFileSync(join(ROUTES_DIR, f), 'utf8')))
    expect(callers.length).toBeGreaterThanOrEqual(4)
  })
})
