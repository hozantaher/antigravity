// Envelope snapshot tests — pin concrete byte shape per endpoint.
// Different signal from contracts (Zod = shape only). Snapshot fixes
// values + presence + key order, catches silent serialization drift.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'

const BASE = 'http://localhost:3001'

beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

// Volatile keys = wallclock or auto-incrementing values that drift between runs.
// Replaced with deterministic placeholder so snapshot stays stable.
const VOLATILE = new Set([
  'id', 'created_at', 'updated_at', 'last_contacted', 'last_send_at',
  'received_at', 'handled_at', 'enrolled_at', 'last_step_at', 'scored_at',
  'checked_at', 'last_built_at', 'verified_at', 'email_verified_at',
  'company_count', 'total', 'best_targeting_score', 'composite_score',
  'icp_score', 'engagement_score', 'sector_confidence', 'rating_value',
  'rating_count', 'total_sent', 'total_replied', 'total_opened',
  'total_bounced', 'consecutive_bounces',
])

function stripVolatile(v, depth = 0) {
  if (depth > 8) return '<DEPTH>'
  if (v === null || v === undefined) return v
  if (Array.isArray(v)) {
    // Filter test-fixture probe rows (race.matrix etc.) so parallel test
    // contamination doesn't poison the snapshot's first-item sample.
    const filtered = v.filter(item => !/race_probe|idem_probe|__probe__/.test(JSON.stringify(item)))
    // Truncate large arrays to first item — shape, not data volume.
    return filtered.length === 0 ? [] : [stripVolatile(filtered[0], depth + 1)]
  }
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      out[k] = VOLATILE.has(k) ? `<${typeof v[k]}>` : stripVolatile(v[k], depth + 1)
    }
    return out
  }
  // Strings that look like ISO timestamps → placeholder.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return '<ISO>'
  // Long opaque strings (HTML, base64) → length only.
  if (typeof v === 'string' && v.length > 200) return `<string:${v.length}>`
  // 13-digit ms epoch embedded in test-fixture names/emails → placeholder.
  // Keeps snapshots stable across reruns that re-seed timestamped fixtures.
  if (typeof v === 'string' && /\d{13}/.test(v)) return v.replace(/\d{13}/g, '<ts>')
  return v
}

async function envelope(path) {
  const r = await fetch(BASE + path)
  const ct = r.headers.get('content-type') || ''
  const body = ct.includes('application/json') ? await r.json() : await r.text()
  return {
    status: r.status,
    contentType: ct.split(';')[0],
    body: stripVolatile(body),
  }
}

describe('API envelope snapshots — shape + types pinned per endpoint', () => {
  it('GET /api/companies/stats', async () => {
    expect(await envelope('/api/companies/stats')).toMatchSnapshot()
  })

  it('GET /api/companies?limit=2', async () => {
    expect(await envelope('/api/companies?limit=2')).toMatchSnapshot()
  })

  it('GET /api/companies/:ico (404 path)', async () => {
    expect(await envelope('/api/companies/00000000')).toMatchSnapshot()
  })

  it('GET /api/campaigns', async () => {
    expect(await envelope('/api/campaigns')).toMatchSnapshot()
  })

  it('GET /api/campaigns/null (validation 404)', async () => {
    expect(await envelope('/api/campaigns/null')).toMatchSnapshot()
  })

  it('GET /api/mailboxes', async () => {
    expect(await envelope('/api/mailboxes')).toMatchSnapshot()
  })

  it('GET /api/templates', async () => {
    expect(await envelope('/api/templates')).toMatchSnapshot()
  })

  it('GET /api/segments', async () => {
    expect(await envelope('/api/segments')).toMatchSnapshot()
  })

  it('GET /api/replies?limit=2', async () => {
    expect(await envelope('/api/replies?limit=2')).toMatchSnapshot()
  })

  it('GET /api/contacts?limit=2', async () => {
    expect(await envelope('/api/contacts?limit=2')).toMatchSnapshot()
  })
})

describe('Error envelope snapshots — error shape pinned', () => {
  it('POST /api/templates {} — missing fields', async () => {
    const r = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const body = await r.text()
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = body.slice(0, 200) }
    expect({
      status: r.status,
      body: stripVolatile(parsed),
    }).toMatchSnapshot()
  })

  it('POST /api/templates {invalid json}', async () => {
    const r = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect({
      status: r.status,
      body: await r.json(),
    }).toMatchSnapshot()
  })
})
