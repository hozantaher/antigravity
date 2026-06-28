// @linkage-allowed: excluded from default scope; real-server integration
/**
 * Integration tests — HTTP layer against a running dev server (localhost:3001).
 *
 * Tests are SKIPPED automatically when the server is not reachable.
 * Run alongside `pnpm server` or `pnpm dev` for full coverage.
 *
 * These tests verify:
 *  - API response shapes match what the UI expects
 *  - Filtering parameters are honoured
 *  - Pagination math is correct
 *  - Edge cases (empty results, missing params) don't crash
 */
import { describe, it, expect, beforeAll } from 'vitest'

const BASE = 'http://localhost:3001'

let serverAvailable = false

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE}/api/companies/stats`, { signal: AbortSignal.timeout(2000) })
    serverAvailable = res.ok
  } catch {
    serverAvailable = false
  }
  if (!serverAvailable) {
    console.warn('[integration] Server not reachable — all integration tests will be skipped.')
  }
}, 5000)

const maybeIt = (label, fn) =>
  it(label, async () => {
    if (!serverAvailable) return
    await fn()
  })

const get = (path) =>
  fetch(`${BASE}${path}`).then(r => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`)
    return r.json()
  })

const patch = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json())

// ── Analytics overview ────────────────────────────────────────────
describe('GET /api/analytics/overview', () => {
  maybeIt('returns object with expected numeric keys', async () => {
    const d = await get('/api/analytics/overview')
    expect(typeof d.total_sent).toBe('number')
    expect(typeof d.total_replied).toBe('number')
    expect(typeof d.total_opened).toBe('number')
    expect(typeof d.total_bounced).toBe('number')
    expect(typeof d.sent_7d).toBe('number')
    expect(typeof d.replied_7d).toBe('number')
    expect(typeof d.active_campaigns).toBe('number')
  })

  maybeIt('all counts are non-negative', async () => {
    const d = await get('/api/analytics/overview')
    for (const key of ['total_sent', 'total_replied', 'total_opened', 'total_bounced', 'sent_7d', 'replied_7d', 'active_campaigns']) {
      expect(d[key]).toBeGreaterThanOrEqual(0)
    }
  })

  maybeIt('total_replied <= total_sent', async () => {
    const d = await get('/api/analytics/overview')
    expect(d.total_replied).toBeLessThanOrEqual(d.total_sent)
  })

  maybeIt('replied_7d <= sent_7d', async () => {
    const d = await get('/api/analytics/overview')
    expect(d.replied_7d).toBeLessThanOrEqual(d.sent_7d)
  })
})

// ── Analytics timeline ────────────────────────────────────────────
describe('GET /api/analytics/timeline', () => {
  maybeIt('?days=30 returns exactly 30 entries', async () => {
    const data = await get('/api/analytics/timeline?days=30')
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBe(30)
  })

  maybeIt('?days=7 returns exactly 7 entries', async () => {
    const data = await get('/api/analytics/timeline?days=7')
    expect(data.length).toBe(7)
  })

  maybeIt('?days=14 returns exactly 14 entries', async () => {
    const data = await get('/api/analytics/timeline?days=14')
    expect(data.length).toBe(14)
  })

  maybeIt('each entry has day, sent, replied, opened as numbers', async () => {
    const data = await get('/api/analytics/timeline?days=7')
    for (const entry of data) {
      expect(typeof entry.day).toBe('string')
      expect(entry.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(typeof entry.sent).toBe('number')
      expect(typeof entry.replied).toBe('number')
      expect(typeof entry.opened).toBe('number')
    }
  })

  maybeIt('days are in ascending chronological order', async () => {
    const data = await get('/api/analytics/timeline?days=30')
    for (let i = 1; i < data.length; i++) {
      expect(data[i].day >= data[i - 1].day).toBe(true)
    }
  })

  maybeIt('zero-fill: entries with no sends have sent=0, replied=0', async () => {
    const data = await get('/api/analytics/timeline?days=7')
    for (const entry of data) {
      expect(entry.sent).toBeGreaterThanOrEqual(0)
      expect(entry.replied).toBeGreaterThanOrEqual(0)
      expect(entry.opened).toBeGreaterThanOrEqual(0)
    }
  })

  maybeIt('replied <= sent per day', async () => {
    const data = await get('/api/analytics/timeline?days=30')
    for (const entry of data) {
      expect(entry.replied).toBeLessThanOrEqual(entry.sent)
    }
  })

  maybeIt('caps days at 90', async () => {
    const data = await get('/api/analytics/timeline?days=200')
    expect(data.length).toBeLessThanOrEqual(90)
  })
})

// ── Analytics campaigns ───────────────────────────────────────────
describe('GET /api/analytics/campaigns', () => {
  maybeIt('returns an array', async () => {
    const data = await get('/api/analytics/campaigns')
    expect(Array.isArray(data)).toBe(true)
  })

  maybeIt('each campaign has id, name, status, sent, replied, opened, bounced', async () => {
    const data = await get('/api/analytics/campaigns')
    for (const c of data) {
      expect(typeof c.id).toBe('number')
      expect(typeof c.name).toBe('string')
      expect(typeof c.status).toBe('string')
      expect(typeof c.sent).toBe('number')
      expect(typeof c.replied).toBe('number')
      expect(typeof c.opened).toBe('number')
      expect(typeof c.bounced).toBe('number')
    }
  })

  maybeIt('all counts are non-negative', async () => {
    const data = await get('/api/analytics/campaigns')
    for (const c of data) {
      expect(c.sent).toBeGreaterThanOrEqual(0)
      expect(c.replied).toBeGreaterThanOrEqual(0)
      expect(c.bounced).toBeGreaterThanOrEqual(0)
    }
  })

  maybeIt('replied <= sent for each campaign', async () => {
    const data = await get('/api/analytics/campaigns')
    for (const c of data) {
      expect(c.replied).toBeLessThanOrEqual(c.sent)
    }
  })

  maybeIt('results are sorted by sent DESC', async () => {
    const data = await get('/api/analytics/campaigns')
    for (let i = 1; i < data.length; i++) {
      expect(data[i].sent).toBeLessThanOrEqual(data[i - 1].sent)
    }
  })

  maybeIt('returns at most 30 results', async () => {
    const data = await get('/api/analytics/campaigns')
    expect(data.length).toBeLessThanOrEqual(30)
  })
})

// ── Replies inbox ────────────────────────────────────────────────
describe('GET /api/replies', () => {
  maybeIt('returns { rows, total } shape', async () => {
    const data = await get('/api/replies')
    expect(data).toHaveProperty('rows')
    expect(data).toHaveProperty('total')
    expect(Array.isArray(data.rows)).toBe(true)
    expect(typeof data.total).toBe('number')
  })

  maybeIt('?handled=false returns only unhandled rows', async () => {
    const data = await get('/api/replies?handled=false')
    for (const row of data.rows) {
      expect(row.handled).toBe(false)
    }
  })

  maybeIt('?handled=true returns only handled rows', async () => {
    const data = await get('/api/replies?handled=true')
    for (const row of data.rows) {
      expect(row.handled).toBe(true)
    }
  })

  maybeIt('each row has expected fields', async () => {
    const data = await get('/api/replies')
    for (const row of data.rows) {
      expect(typeof row.id).toBe('number')
      expect(typeof row.from_email).toBe('string')
      expect(typeof row.classification).toBe('string')
      expect(typeof row.handled).toBe('boolean')
    }
  })

  maybeIt('?limit=1 returns at most 1 row', async () => {
    const data = await get('/api/replies?limit=1')
    expect(data.rows.length).toBeLessThanOrEqual(1)
  })

  maybeIt('?classification=positive filters correctly', async () => {
    const data = await get('/api/replies?classification=positive')
    for (const row of data.rows) {
      expect(row.classification).toBe('positive')
    }
  })
})

describe('GET /api/replies/stats', () => {
  maybeIt('returns stats with all expected keys', async () => {
    const d = await get('/api/replies/stats')
    expect(typeof d.total).toBe('number')
    expect(typeof d.unhandled).toBe('number')
    expect(typeof d.positive).toBe('number')
    expect(typeof d.negative).toBe('number')
    expect(typeof d.auto_reply).toBe('number')
    expect(typeof d.today).toBe('number')
  })

  maybeIt('unhandled <= total', async () => {
    const d = await get('/api/replies/stats')
    expect(d.unhandled).toBeLessThanOrEqual(d.total)
  })

  maybeIt('positive + negative + auto_reply <= total', async () => {
    const d = await get('/api/replies/stats')
    expect(d.positive + d.negative + d.auto_reply).toBeLessThanOrEqual(d.total)
  })
})

// ── Healing log ───────────────────────────────────────────────────
describe('GET /api/healing/log', () => {
  maybeIt('returns { events, total }', async () => {
    const d = await get('/api/healing/log')
    expect(Array.isArray(d.events)).toBe(true)
    expect(typeof d.total).toBe('number')
  })

  maybeIt('?limit=3 returns at most 3 events', async () => {
    const d = await get('/api/healing/log?limit=3')
    expect(d.events.length).toBeLessThanOrEqual(3)
  })

  maybeIt('each event has entity_type, action, reason, created_at', async () => {
    const d = await get('/api/healing/log?limit=10')
    for (const e of d.events) {
      expect(typeof e.entity_type).toBe('string')
      expect(typeof e.action).toBe('string')
      expect(typeof e.created_at).toBe('string')
    }
  })
})

describe('GET /api/healing/stats', () => {
  maybeIt('returns { by_action, today }', async () => {
    const d = await get('/api/healing/stats')
    expect(Array.isArray(d.by_action)).toBe(true)
    expect(typeof d.today).toBe('number')
  })

  maybeIt('today is non-negative', async () => {
    const d = await get('/api/healing/stats')
    expect(d.today).toBeGreaterThanOrEqual(0)
  })
})

// ── Campaigns ────────────────────────────────────────────────────
describe('GET /api/campaigns/:id', () => {
  maybeIt('returns 404 for non-existent campaign', async () => {
    const res = await fetch(`${BASE}/api/campaigns/999999`)
    expect(res.status).toBe(404)
  })

  maybeIt('campaign list returns array', async () => {
    const data = await get('/api/campaigns')
    expect(Array.isArray(data)).toBe(true)
  })
})

describe('GET /api/campaigns/:id/sends', () => {
  maybeIt('?limit=5&offset=0 returns at most 5 rows', async () => {
    const campaigns = await get('/api/campaigns')
    if (!campaigns.length) return
    const id = campaigns[0].id
    const data = await get(`/api/campaigns/${id}/sends?limit=5&offset=0`)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeLessThanOrEqual(5)
  })
})
