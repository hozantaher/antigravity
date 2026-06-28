// Shadow replay diff — re-fetch every path captured in
// reports/replay/baseline.json and compare type-skeleton. New keys
// (additive) tolerated; removed keys = regression. Status changes from
// 2xx → 4xx/5xx = regression. Update baseline:
//   node scripts/shadow-capture.mjs --update
// (only on a green main commit, after intentional schema changes).
//
// Skipped if baseline missing OR backend not reachable.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'
import { readFileSync, existsSync } from 'node:fs'

const BASE = 'http://localhost:3001'
const PATH = 'reports/replay/baseline.json'

beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

const VOLATILE_KEYS = new Set([
  'id', 'created_at', 'updated_at', 'last_contacted', 'last_send_at', 'received_at',
  'handled_at', 'enrolled_at', 'last_step_at', 'scored_at', 'checked_at', 'last_built_at',
  'verified_at', 'email_verified_at', 'company_count', 'total', 'best_targeting_score',
  'composite_score', 'icp_score', 'engagement_score', 'sector_confidence', 'rating_value',
  'rating_count', 'total_sent', 'total_replied', 'total_opened', 'total_bounced',
  'consecutive_bounces', 'count', 'cnt', 'n', 'value', 'price',
])
function skeleton(v, depth = 0) {
  if (depth > 6) return 'DEEP'
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length === 0 ? '[]' : ['<', skeleton(v[0], depth + 1), '>']
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      out[k] = VOLATILE_KEYS.has(k) ? typeof v[k] : skeleton(v[k], depth + 1)
    }
    return out
  }
  return typeof v
}

// Compare baseline shape vs current shape. Allow ADDED keys, forbid REMOVED.
function diff(base, cur, path = '') {
  if (typeof base === 'string' && typeof cur === 'string') {
    // "any" on either side = intentional heterogeneity (e.g. JSONB values)
    if (base === 'any' || cur === 'any') return []
    return base === cur ? [] : [`${path}: type ${base} → ${cur}`]
  }
  if (Array.isArray(base) && Array.isArray(cur)) {
    if (base.length !== cur.length) return [`${path}: array shape changed`]
    return [...diff(base[1], cur[1], `${path}[]`)]
  }
  if (base && typeof base === 'object' && cur && typeof cur === 'object' && !Array.isArray(base)) {
    const errs = []
    for (const k of Object.keys(base)) {
      if (!(k in cur)) { errs.push(`${path}.${k}: removed`); continue }
      errs.push(...diff(base[k], cur[k], `${path}.${k}`))
    }
    return errs
  }
  if (base !== cur) return [`${path}: ${JSON.stringify(base)} → ${JSON.stringify(cur)}`]
  return []
}

describe.skipIf(!existsSync(PATH))('Shadow replay diff vs baseline', () => {
  const baseline = JSON.parse(readFileSync(PATH, 'utf8'))
  const paths = Object.keys(baseline.captured)

  // Sanity check baseline isn't empty.
  it('baseline has paths', () => {
    expect(paths.length).toBeGreaterThan(20)
  })

  async function fetchRetry(url, tries = 3) {
    let last
    for (let i = 0; i < tries; i++) {
      try { return await fetch(url) }
      catch (e) {
        last = e
        await new Promise(r => setTimeout(r, 200 * (i + 1)))
      }
    }
    throw last
  }

  for (const p of paths) {
    it(`replay ${p}`, async () => {
      const baseEntry = baseline.captured[p]
      const r = await fetchRetry(BASE + p)
      const body = r.headers.get('content-type')?.includes('application/json')
        ? await r.json() : '<non-json>'
      const curShape = skeleton(body)

      // Status regression: 2xx baseline → non-2xx current = bad.
      if (baseEntry.status >= 200 && baseEntry.status < 300) {
        expect(r.status, `${p} status ${baseEntry.status} → ${r.status}`).toBeLessThan(400)
      }

      const errs = diff(baseEntry.shape, curShape)
      expect(errs, `${p} shape drift:\n  ${errs.join('\n  ')}`).toEqual([])
    }, 10_000)
  }
})
