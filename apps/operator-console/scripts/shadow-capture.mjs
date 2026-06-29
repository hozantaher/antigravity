#!/usr/bin/env node
// Shadow capture — hit ~100 representative GET endpoints, strip volatile,
// save reports/replay/baseline.json. The companion test (replay.diff.test.js)
// re-runs same URLs and diffs shape against baseline. Catches silent
// serialization drift across the full surface area, complementing the
// curated 12-endpoint api.snapshot.test.js.
//
// Run: node scripts/shadow-capture.mjs [--update] (overwrites baseline)

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'

const BASE = process.env.SHADOW_BASE || 'http://localhost:3001'
const UPDATE = process.argv.includes('--update')
mkdirSync('reports/replay', { recursive: true })

const VOLATILE_KEYS = new Set([
  'id', 'created_at', 'updated_at', 'last_contacted', 'last_send_at', 'received_at',
  'handled_at', 'enrolled_at', 'last_step_at', 'scored_at', 'checked_at', 'last_built_at',
  'verified_at', 'email_verified_at', 'company_count', 'total', 'best_targeting_score',
  'composite_score', 'icp_score', 'engagement_score', 'sector_confidence', 'rating_value',
  'rating_count', 'total_sent', 'total_replied', 'total_opened', 'total_bounced',
  'consecutive_bounces', 'count', 'cnt', 'n', 'value', 'price',
])

// Skeleton: type-only representation. Catches structural drift without
// being sensitive to live data churn.
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

const PATHS = [
  '/api/companies/stats',
  '/api/companies?limit=3',
  '/api/companies?limit=3&offset=10',
  '/api/companies?limit=3&sort=score&dir=desc',
  '/api/companies?limit=3&sort=score&dir=asc',
  '/api/companies?limit=3&sort=created_at',
  '/api/companies?limit=3&sort=composite_score&dir=desc',
  '/api/companies?limit=3&icp=A',
  '/api/companies?limit=3&icp=B',
  '/api/companies?limit=3&size=micro',
  '/api/companies?limit=3&email_status=verified',
  '/api/companies?limit=3&uncontacted=1',
  '/api/companies?limit=3&search=test',
  '/api/scoring/config',
  '/api/scoring/stats',
  '/api/email-verification/stats',
  '/api/meta/categories',
  '/api/meta/categories/tree',
  '/api/meta/categories/top',
  '/api/meta/categories/search?q=auto',
  '/api/segments',
  '/api/campaigns',
  '/api/templates',
  '/api/mailboxes',
  '/api/mailboxes/health-summary',
  '/api/proxy-pool',
  '/api/anti-trace/health',
  '/api/health/watchdog',
  '/api/contacts?limit=3',
  '/api/suppression?limit=3',
  '/api/healing/log',
  '/api/healing/stats',
  '/api/analytics/overview',
  '/api/analytics/timeline',
  '/api/analytics/campaigns',
  '/api/replies?limit=3',
  '/api/replies/stats',
  '/api/categories',
  '/api/cohorts/lookup?ico=00000000',
]

// Discover dynamic IDs by hitting a parent endpoint first.
async function expand(paths) {
  const out = [...paths]
  try {
    const co = await fetch(`${BASE}/api/companies?limit=1`).then(r => r.json())
    const ico = co?.rows?.[0]?.ico
    if (ico) {
      out.push(`/api/companies/${ico}`)
      out.push(`/api/companies/${ico}/expected-value`)
      out.push(`/api/companies/${ico}/facts`)
      out.push(`/api/companies/${ico}/facts/current`)
      out.push(`/api/companies/${ico}/verification-history`)
    }
  } catch {}
  try {
    const cs = await fetch(`${BASE}/api/campaigns`).then(r => r.json())
    const id = cs?.[0]?.id
    if (id) {
      out.push(`/api/campaigns/${id}`)
      out.push(`/api/campaigns/${id}/sends`)
      out.push(`/api/campaigns/${id}/estimate`)
      out.push(`/api/campaigns/${id}/email-quality`)
    }
  } catch {}
  try {
    const ms = await fetch(`${BASE}/api/mailboxes`).then(r => r.json())
    const id = ms?.[0]?.id
    if (id) {
      out.push(`/api/mailboxes/${id}/stats`)
      out.push(`/api/mailboxes/${id}/send-log`)
      out.push(`/api/mailboxes/${id}/warmup-status`)
      out.push(`/api/mailboxes/${id}/bounce-status`)
      out.push(`/api/mailboxes/${id}/send-rate`)
      out.push(`/api/mailboxes/${id}/check-history`)
      out.push(`/api/mailboxes/${id}/alerts`)
    }
  } catch {}
  return out
}

const all = await expand(PATHS)
process.stderr.write(`shadow capture: ${all.length} paths ... `)
const captured = {}
let okN = 0
for (const path of all) {
  try {
    const r = await fetch(BASE + path)
    const body = r.headers.get('content-type')?.includes('application/json')
      ? await r.json()
      : '<non-json>'
    captured[path] = { status: r.status, shape: skeleton(body) }
    if (r.status < 500) okN++
  } catch (e) {
    captured[path] = { status: 'fetch-error', error: e.message.slice(0, 80) }
  }
}
process.stderr.write(`ok=${okN}/${all.length}\n`)

const TARGET = (UPDATE || !existsSync('reports/replay/baseline.json'))
  ? 'reports/replay/baseline.json'
  : 'reports/replay/current.json'

writeFileSync(TARGET, JSON.stringify({
  capturedAt: new Date().toISOString(),
  base: BASE,
  paths: all.length,
  captured,
}, null, 2))
console.log(`shadow → ${TARGET} (${all.length} paths)`)
if (TARGET.endsWith('current.json')) console.log('compare via vitest src/replay.diff.test.js')
