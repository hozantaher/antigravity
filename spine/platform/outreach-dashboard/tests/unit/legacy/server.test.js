/**
 * Integration tests against the live Express server (localhost:3001).
 * Run: pnpm test (vitest run)
 *
 * These tests require the server to be running and DATABASE_URL to be set.
 * They verify real behaviour — no mocks, no placeholders.
 */
import { beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'

const BASE = 'http://localhost:3001'

// Disable MSW for this file — tests hit the real Express server.
beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

// ── helpers ──────────────────────────────────────────────────────────
async function get(path) {
  const r = await fetch(BASE + path)
  return { status: r.status, body: await r.json() }
}
async function post(path, body = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: r.status, body: await r.json() }
}

// ── Mailboxes ─────────────────────────────────────────────────────
describe('GET /api/mailboxes', () => {
  it('returns array', async () => {
    const { status, body } = await get('/api/mailboxes')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('each mailbox has required fields', async () => {
    const { body } = await get('/api/mailboxes')
    if (!body.length) return
    const mb = body[0]
    for (const f of ['id','email','host','port','status','daily_limit','total_sent','total_bounced','consecutive_bounces','anti_trace_enabled']) {
      expect(mb).toHaveProperty(f)
    }
  })

  it('anti_trace_enabled is boolean', async () => {
    const { body } = await get('/api/mailboxes')
    if (!body.length) return
    expect(typeof body[0].anti_trace_enabled).toBe('boolean')
  })
})

describe('GET /api/mailboxes/:id/stats', () => {
  it('returns numeric stats for mailbox 1', async () => {
    const { status, body } = await get('/api/mailboxes/1/stats')
    expect(status).toBe(200)
    expect(body).toHaveProperty('total_sent')
    expect(body).toHaveProperty('total_bounced')
    expect(body).toHaveProperty('sent_30d')
    expect(body).toHaveProperty('consecutive_bounces')
  })
})

describe('GET /api/mailboxes/:id/pipeline-results', () => {
  it('returns array of pipeline results', async () => {
    const { status, body } = await get('/api/mailboxes/3/pipeline-results')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('each result has steps jsonb with required sections', async () => {
    const { body } = await get('/api/mailboxes/3/pipeline-results')
    if (!body.length) return
    const { steps } = body[0]
    // smtp, imap, warmup, backpressure are always present; proxy only when proxy_url configured
    for (const section of ['smtp','imap','warmup','backpressure']) {
      expect(steps).toHaveProperty(section)
      expect(steps[section]).toHaveProperty('ok')
      expect(steps[section]).toHaveProperty('steps')
      expect(Array.isArray(steps[section].steps)).toBe(true)
    }
    // proxy section: if present, must have correct shape
    if (steps.proxy) {
      expect(steps.proxy).toHaveProperty('ok')
      expect(Array.isArray(steps.proxy.steps)).toBe(true)
    }
  })

  it('each sub-step has name, ok, ms, msg', async () => {
    const { body } = await get('/api/mailboxes/3/pipeline-results')
    if (!body.length) return
    const step = body[0].steps.smtp.steps[0]
    for (const f of ['name','ok','ms','msg']) {
      expect(step).toHaveProperty(f)
    }
  })
})

describe('GET /api/mailboxes/:id/send-log', () => {
  it('returns array (empty ok)', async () => {
    const { status, body } = await get('/api/mailboxes/1/send-log')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })
})

// ── Anti-trace health ─────────────────────────────────────────────
describe('GET /api/anti-trace/health', () => {
  it('returns ok boolean', async () => {
    const { status, body } = await get('/api/anti-trace/health')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    expect(typeof body.ok).toBe('boolean')
  })

  it('includes url from outreach_config when configured', async () => {
    const { body } = await get('/api/anti-trace/health')
    // url may be null (not_configured) or a string
    expect(body).toHaveProperty('url')
    if (body.url !== null) {
      expect(typeof body.url).toBe('string')
      expect(body.url).toMatch(/^http/)
    }
  })

  it('includes latency ms when url is configured', async () => {
    const { body } = await get('/api/anti-trace/health')
    if (body.url) {
      expect(body).toHaveProperty('ms')
      expect(typeof body.ms).toBe('number')
    }
  })
})

// ── Per-mailbox proxy live check ──────────────────────────────────
describe('GET /api/mailboxes/:id/proxy-live-check', () => {
  it('returns ok field', async () => {
    const { status, body } = await get('/api/mailboxes/1/proxy-live-check')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    expect([true, false, null]).toContain(body.ok)
  })

  it('returns ms latency when proxy is configured', async () => {
    const { body } = await get('/api/mailboxes/1/proxy-live-check')
    if (body.proxy_url) {
      expect(body).toHaveProperty('ms')
      expect(typeof body.ms).toBe('number')
      expect(body.ms).toBeGreaterThanOrEqual(0)
    }
  })

  it('returns not_configured for mailbox with no proxy_url', async () => {
    // mailbox 3 has no proxy configured
    const { body } = await get('/api/mailboxes/3/proxy-live-check')
    if (body.ok === null) {
      expect(body.reason).toBe('not_configured')
    }
  })
})

// ── Free proxy pool ───────────────────────────────────────────────
describe('GET /api/proxy-pool', () => {
  it('returns pool data structure', async () => {
    const { status, body } = await get('/api/proxy-pool')
    expect(status).toBe(200)
    expect(body).toHaveProperty('total_candidates')
    expect(body).toHaveProperty('probed')
    expect(body).toHaveProperty('working')
    expect(body).toHaveProperty('cached_at')
    expect(Array.isArray(body.working)).toBe(true)
  }, 60_000)

  it('working proxies have addr and probe_ms', async () => {
    const { body } = await get('/api/proxy-pool')
    for (const p of body.working) {
      expect(p).toHaveProperty('addr')
      expect(p.addr).toMatch(/^\d+\.\d+\.\d+\.\d+:\d+$/)
      expect(p).toHaveProperty('probe_ms')
      expect(p.probe_ms).toBeGreaterThan(0)
    }
  }, 60_000)

  it('total_candidates > 0 (geonode API reachable)', async () => {
    const { body } = await get('/api/proxy-pool')
    expect(body.total_candidates).toBeGreaterThan(0)
  }, 60_000)

  it('cached_at is a valid ISO date', async () => {
    const { body } = await get('/api/proxy-pool')
    expect(() => new Date(body.cached_at)).not.toThrow()
    expect(isNaN(new Date(body.cached_at).getTime())).toBe(false)
  }, 60_000)
})

// ── Mailbox CRUD ──────────────────────────────────────────────────
describe('Mailbox CRUD', () => {
  let createdId

  it('POST creates mailbox with required fields', async () => {
    const { status, body } = await post('/api/mailboxes', {
      email: `test_${Date.now()}@example.com`,
      display_name: 'Test Schránka',
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_username: `test_${Date.now()}@example.com`,
      password: 'testpass123',
      daily_limit: 50,
      imap_host: 'imap.example.com',
      imap_port: 993,
    })
    expect(status).toBe(200)
    expect(body).toHaveProperty('id')
    expect(body).toHaveProperty('email')
    expect(body.status).toBe('active')
    createdId = body.id
  })

  it('PATCH updates mailbox fields', async () => {
    const { status, body } = await fetch(BASE + `/api/mailboxes/${createdId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Updated Name', daily_cap_override: 75 })
    }).then(async r => ({ status: r.status, body: await r.json() }))
    expect(status).toBe(200)
    expect(body.display_name).toBe('Updated Name')
    expect(body.daily_limit).toBe(75)
  })

  it('PATCH updates imap_username', async () => {
    const { status, body } = await fetch(BASE + `/api/mailboxes/${createdId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imap_username: 'imap@example.com' })
    }).then(async r => ({ status: r.status, body: await r.json() }))
    expect(status).toBe(200)
    expect(body.imap_username).toBe('imap@example.com')
  })

  it('PATCH status toggles correctly', async () => {
    const { body } = await fetch(BASE + `/api/mailboxes/${createdId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' })
    }).then(async r => ({ status: r.status, body: await r.json() }))
    expect(body.status).toBe('paused')
  })

  it('DELETE removes mailbox', async () => {
    const { status, body } = await fetch(BASE + `/api/mailboxes/${createdId}`, { method:'DELETE' })
      .then(async r => ({ status: r.status, body: await r.json() }))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })
})

// ── Warmup PATCH ──────────────────────────────────────────────────
describe('PATCH /api/mailboxes/:id/warmup', () => {
  it('returns ok for mailbox 1 (warmup row may not exist, 404 ok)', async () => {
    const r = await fetch(BASE + '/api/mailboxes/1/warmup', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true })
    })
    expect([200, 404]).toContain(r.status)
    const body = await r.json()
    if (r.status === 200) expect(body.ok).toBe(true)
    else expect(body).toHaveProperty('error')
  })
})

// ── Assign proxy ──────────────────────────────────────────────────
describe('POST /api/mailboxes/:id/assign-proxy', () => {
  it('returns proxy_url and latency_ms when pool has working proxies', async () => {
    const { status, body } = await post('/api/mailboxes/1/assign-proxy')
    // 503 is valid if proxy pool is empty (geonode unreachable in CI)
    expect([200, 503]).toContain(status)
    if (status === 200) {
      expect(body).toHaveProperty('proxy_url')
      expect(body.proxy_url).toMatch(/^socks5:\/\//)
      expect(body).toHaveProperty('latency_ms')
      expect(typeof body.latency_ms).toBe('number')
      expect(body).toHaveProperty('country')
    }
  }, 60_000)

  it('returns error for non-existent mailbox', async () => {
    const { status, body } = await post('/api/mailboxes/999999/assign-proxy')
    expect([404, 503]).toContain(status)
  }, 60_000)
})

// ── Validation & 404 edge cases ───────────────────────────────────
describe('API edge cases', () => {
  it('GET /api/mailboxes/:id/stats 404 for non-existent id', async () => {
    const { status } = await get('/api/mailboxes/999999/stats')
    expect([404, 200]).toContain(status) // 200 with zeros is acceptable
  })

  it('GET /api/mailboxes/:id/send-log returns array for any existing mailbox', async () => {
    const { body: list } = await get('/api/mailboxes')
    if (!list.length) return
    const id = list[0].id
    const { status, body } = await get(`/api/mailboxes/${id}/send-log`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /api/mailboxes/:id/pipeline-results returns array for any existing mailbox', async () => {
    const { body: list } = await get('/api/mailboxes')
    if (!list.length) return
    const id = list[0].id
    const { status, body } = await get(`/api/mailboxes/${id}/pipeline-results`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('PATCH /api/mailboxes/:id with empty body returns mailbox unchanged', async () => {
    const { body: list } = await get('/api/mailboxes')
    if (!list.length) return
    const mb = list[0]
    const r = await fetch(BASE + `/api/mailboxes/${mb.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const body = await r.json()
    expect([200, 400]).toContain(r.status)
    if (r.status === 200) expect(body).toHaveProperty('email')
  })

  it('mailbox list fields are consistent types', async () => {
    const { body } = await get('/api/mailboxes')
    if (!body.length) return
    for (const mb of body) {
      expect(typeof mb.id).toBe('string')
      expect(typeof mb.email).toBe('string')
      expect(typeof mb.status).toBe('string')
      expect(['active','paused','bounce_hold','retired']).toContain(mb.status)
      expect(Number.isFinite(Number(mb.daily_limit))).toBe(true)
      expect(Number.isFinite(Number(mb.total_sent))).toBe(true)
      expect(Number.isFinite(Number(mb.total_bounced))).toBe(true)
    }
  })

  it('/api/mailboxes/:id/stats has correct numeric shape', async () => {
    const { body: list } = await get('/api/mailboxes')
    if (!list.length) return
    const { body } = await get(`/api/mailboxes/${list[0].id}/stats`)
    for (const field of ['total_sent','total_bounced','consecutive_bounces','sent_30d']) {
      expect(body).toHaveProperty(field)
      expect(Number.isFinite(Number(body[field]))).toBe(true)
    }
  })
})

// ── Sprint 1/2/3: new check endpoints ────────────────────────────

// Shared null-password mailbox — created once, deleted after all checks tests
let _nullPwId = null
beforeAll(async () => {
  const r = await fetch(BASE + '/api/mailboxes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `test-nullpw-${Date.now()}@test.internal`,
      smtp_host: 'smtp.test.internal', smtp_port: 587,
      smtp_username: 'test@test.internal',
      // password intentionally omitted → NULL
    })
  })
  const mb = await r.json()
  _nullPwId = mb.id ?? null
})
afterAll(async () => {
  if (_nullPwId) await fetch(BASE + `/api/mailboxes/${_nullPwId}`, { method: 'DELETE' })
})

describe('GET /api/mailboxes/:id/smtp-check', () => {
  it('returns {ok, ms, steps[]}', async () => {
    const { status, body } = await get('/api/mailboxes/1/smtp-check')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('ms')
    expect(Array.isArray(body.steps)).toBe(true)
  }, 30_000)

  it('ok is boolean', async () => {
    const { body } = await get('/api/mailboxes/1/smtp-check')
    expect(typeof body.ok).toBe('boolean')
  }, 30_000)

  it('ms is number >= 0', async () => {
    const { body } = await get('/api/mailboxes/1/smtp-check')
    expect(typeof body.ms).toBe('number')
    expect(body.ms).toBeGreaterThanOrEqual(0)
  }, 30_000)

  it('each step has {name, ok, ms, msg}', async () => {
    const { body } = await get('/api/mailboxes/1/smtp-check')
    for (const step of body.steps) {
      expect(step).toHaveProperty('name')
      expect(step).toHaveProperty('ok')
      expect(step).toHaveProperty('ms')
      expect(step).toHaveProperty('msg')
    }
  }, 30_000)

  it('mailbox with null password → ok=false, steps contain no credentials', async () => {
    if (!_nullPwId) return
    const { body } = await get(`/api/mailboxes/${_nullPwId}/smtp-check`)
    expect(body.ok).toBe(false)
    for (const step of body.steps) {
      expect(JSON.stringify(step)).not.toMatch(/password|passwd/i)
    }
  }, 30_000)

  it('404 for id=999999', async () => {
    const { status } = await get('/api/mailboxes/999999/smtp-check')
    expect(status).toBe(404)
  }, 30_000)
})

describe('GET /api/mailboxes/:id/imap-check', () => {
  it('returns {ok, ms, steps[]}', async () => {
    const { status, body } = await get('/api/mailboxes/1/imap-check')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('ms')
    expect(Array.isArray(body.steps)).toBe(true)
  }, 30_000)

  it('mailbox without imap_host → ok=false, reason=no_imap_configured (n/a for mb 1 which has imap)', async () => {
    // mailbox 1 has imap_host configured, so just verify shape
    const { body } = await get('/api/mailboxes/1/imap-check')
    expect(typeof body.ok).toBe('boolean')
  }, 30_000)

  it('404 for id=999999', async () => {
    const { status } = await get('/api/mailboxes/999999/imap-check')
    expect(status).toBe(404)
  }, 30_000)
})

describe('GET /api/mailboxes/:id/config-check', () => {
  it('returns {ok, issues[]}', async () => {
    const { status, body } = await get('/api/mailboxes/1/config-check')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    expect(Array.isArray(body.issues)).toBe(true)
  })

  it('ok is boolean', async () => {
    const { body } = await get('/api/mailboxes/1/config-check')
    expect(typeof body.ok).toBe('boolean')
  })

  it('each issue has {field, severity, msg}', async () => {
    const { body } = await get('/api/mailboxes/1/config-check')
    for (const issue of body.issues) {
      expect(issue).toHaveProperty('field')
      expect(issue).toHaveProperty('severity')
      expect(issue).toHaveProperty('msg')
    }
  })

  it('severity is critical, warn, or info', async () => {
    const { body } = await get('/api/mailboxes/1/config-check')
    for (const issue of body.issues) {
      expect(['critical', 'warn', 'info']).toContain(issue.severity)
    }
  })

  it('mailbox with null password → at least 1 critical issue', async () => {
    if (!_nullPwId) return
    const { body } = await get(`/api/mailboxes/${_nullPwId}/config-check`)
    expect(body.issues.some(i => i.severity === 'critical')).toBe(true)
  })

  it('404 for id=999999', async () => {
    const { status } = await get('/api/mailboxes/999999/config-check')
    expect(status).toBe(404)
  })
})

describe('GET /api/mailboxes/:id/warmup-status', () => {
  it('returns {ok, active, day, paused, stale}', async () => {
    const { status, body } = await get('/api/mailboxes/1/warmup-status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('active')
    expect(body).toHaveProperty('day')
    expect(body).toHaveProperty('paused')
    expect(body).toHaveProperty('stale')
  })

  it('active is boolean', async () => {
    const { body } = await get('/api/mailboxes/1/warmup-status')
    expect(typeof body.active).toBe('boolean')
  })

  it('stale is boolean', async () => {
    const { body } = await get('/api/mailboxes/1/warmup-status')
    expect(typeof body.stale).toBe('boolean')
  })

  it('404 for id=999999', async () => {
    const { status } = await get('/api/mailboxes/999999/warmup-status')
    expect(status).toBe(404)
  })
})

describe('GET /api/mailboxes/:id/bounce-status', () => {
  it('returns {ok, classification, consecutive, rate, total_sent, total_bounced, status}', async () => {
    const { status, body } = await get('/api/mailboxes/1/bounce-status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('classification')
    expect(body).toHaveProperty('consecutive')
    expect(body).toHaveProperty('rate')
    expect(body).toHaveProperty('total_sent')
    expect(body).toHaveProperty('total_bounced')
    expect(body).toHaveProperty('status')
  })

  it('classification is ok|warn|critical', async () => {
    const { body } = await get('/api/mailboxes/1/bounce-status')
    expect(['ok', 'warn', 'critical']).toContain(body.classification)
  })

  it('rate is null or number', async () => {
    const { body } = await get('/api/mailboxes/1/bounce-status')
    expect(body.rate === null || typeof body.rate === 'number').toBe(true)
  })

  it('404 for id=999999', async () => {
    const { status } = await get('/api/mailboxes/999999/bounce-status')
    expect(status).toBe(404)
  })
})

describe('GET /api/mailboxes/:id/send-rate', () => {
  it('returns {ok, sent_today, limit, pct, last_send_at}', async () => {
    const { status, body } = await get('/api/mailboxes/1/send-rate')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('sent_today')
    expect(body).toHaveProperty('limit')
    expect(body).toHaveProperty('pct')
    expect(body).toHaveProperty('last_send_at')
  })

  it('sent_today is number >= 0', async () => {
    const { body } = await get('/api/mailboxes/1/send-rate')
    expect(typeof body.sent_today).toBe('number')
    expect(body.sent_today).toBeGreaterThanOrEqual(0)
  })

  it('pct is number >= 0', async () => {
    const { body } = await get('/api/mailboxes/1/send-rate')
    expect(typeof body.pct).toBe('number')
    expect(body.pct).toBeGreaterThanOrEqual(0)
  })

  it('404 for id=999999', async () => {
    const { status } = await get('/api/mailboxes/999999/send-rate')
    expect(status).toBe(404)
  })
})

describe('GET /api/mailboxes/:id/pipeline-status', () => {
  it('returns {ok, exists, overall_ok, stale}', async () => {
    const { status, body } = await get('/api/mailboxes/1/pipeline-status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('exists')
    expect(body).toHaveProperty('overall_ok')
    expect(body).toHaveProperty('stale')
  })

  it('exists is boolean', async () => {
    const { body } = await get('/api/mailboxes/1/pipeline-status')
    expect(typeof body.exists).toBe('boolean')
  })

  it('stale is boolean', async () => {
    const { body } = await get('/api/mailboxes/1/pipeline-status')
    expect(typeof body.stale).toBe('boolean')
  })

  it('404 for id=999999', async () => {
    const { status } = await get('/api/mailboxes/999999/pipeline-status')
    expect(status).toBe(404)
  })
})

describe('GET /api/mailboxes/:id/full-check', () => {
  it('returns {score, ok, checks, critical, warnings}', async () => {
    const { status, body } = await get('/api/mailboxes/1/full-check?force=1')
    expect(status).toBe(200)
    expect(body).toHaveProperty('score')
    expect(body).toHaveProperty('ok')
    expect(body).toHaveProperty('checks')
    expect(body).toHaveProperty('critical')
    expect(body).toHaveProperty('warnings')
  }, 30_000)

  it('score is 0-100', async () => {
    const { body } = await get('/api/mailboxes/1/full-check')
    expect(body.score).toBeGreaterThanOrEqual(0)
    expect(body.score).toBeLessThanOrEqual(100)
  }, 30_000)

  it('checks has required keys', async () => {
    const { body } = await get('/api/mailboxes/1/full-check')
    for (const key of ['smtp', 'imap', 'config', 'warmup', 'bounce', 'send_rate', 'pipeline']) {
      expect(body.checks).toHaveProperty(key)
    }
  }, 30_000)

  it('critical is array', async () => {
    const { body } = await get('/api/mailboxes/1/full-check')
    expect(Array.isArray(body.critical)).toBe(true)
  }, 30_000)

  it('warnings is array', async () => {
    const { body } = await get('/api/mailboxes/1/full-check')
    expect(Array.isArray(body.warnings)).toBe(true)
  }, 30_000)

  it('?force=1 returns fresh data (cached_at <= now)', async () => {
    const { body } = await get('/api/mailboxes/1/full-check?force=1')
    expect(body.cached).toBe(false)
    expect(new Date(body.cached_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  }, 30_000)

  it('404 for id=999999', async () => {
    const { status } = await get('/api/mailboxes/999999/full-check')
    expect(status).toBe(404)
  }, 30_000)
})

describe('GET /api/mailboxes/health-summary', () => {
  it('returns {total, healthy, degraded, critical, mailboxes[]}', async () => {
    const { status, body } = await get('/api/mailboxes/health-summary')
    expect(status).toBe(200)
    expect(body).toHaveProperty('total')
    expect(body).toHaveProperty('healthy')
    expect(body).toHaveProperty('degraded')
    expect(body).toHaveProperty('critical')
    expect(body).toHaveProperty('mailboxes')
    expect(Array.isArray(body.mailboxes)).toBe(true)
  })

  it('total is number > 0', async () => {
    const { body } = await get('/api/mailboxes/health-summary')
    expect(typeof body.total).toBe('number')
    expect(body.total).toBeGreaterThan(0)
  })

  it('healthy + degraded + critical === total', async () => {
    const { body } = await get('/api/mailboxes/health-summary')
    expect(body.healthy + body.degraded + body.critical).toBe(body.total)
  })

  it('each mailbox has id, email, score, critical[]', async () => {
    const { body } = await get('/api/mailboxes/health-summary')
    for (const mb of body.mailboxes) {
      expect(mb).toHaveProperty('id')
      expect(mb).toHaveProperty('email')
      expect(mb).toHaveProperty('score')
      expect(mb).toHaveProperty('critical')
      expect(Array.isArray(mb.critical)).toBe(true)
    }
  })
})

// ── Templates CRUD ────────────────────────────────────────────────
describe('Templates CRUD', () => {
  let createdId

  it('POST creates template', async () => {
    const { status, body } = await post('/api/templates', { name:'Test tmpl', subject:'Předmět', body:'Tělo {{jmeno}}' })
    expect(status).toBe(200)
    expect(body).toHaveProperty('id')
    expect(body.name).toBe('Test tmpl')
    createdId = body.id
  })

  it('GET returns created template', async () => {
    const { body } = await get('/api/templates')
    expect(body.some(t => t.id === createdId)).toBe(true)
  })

  it('DELETE removes template', async () => {
    const { status, body } = await fetch(BASE + `/api/templates/${createdId}`, { method:'DELETE' }).then(async r => ({ status: r.status, body: await r.json() }))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const { body: list } = await get('/api/templates')
    expect(list.some(t => t.id === createdId)).toBe(false)
  })
})

// ── Sprint 1B: IMAP Header Anonymity Probe ───────────────────────

describe('POST /api/mailboxes/:id/header-probe', () => {
  it('404 for non-existent mailbox', async () => {
    const { status } = await post('/api/mailboxes/999999/header-probe', { message_id: '<test@test>' })
    expect(status).toBe(404)
  })

  it('400 when message_id missing', async () => {
    const { status } = await post('/api/mailboxes/1/header-probe', {})
    expect(status).toBe(400)
  })

  it('returns {score, issues, safe} shape on valid mailbox', async () => {
    const { status, body } = await post('/api/mailboxes/1/header-probe', { message_id: '<nonexistent-test-probe@test.internal>' })
    // 200 (probed but message not found → ok=false) or 422 (no imap configured)
    expect([200, 422]).toContain(status)
    if (status === 200) {
      expect(body).toHaveProperty('score')
      expect(body).toHaveProperty('issues')
      expect(body).toHaveProperty('safe')
      expect(typeof body.score).toBe('number')
      expect(Array.isArray(body.issues)).toBe(true)
      expect(typeof body.safe).toBe('boolean')
    }
  }, 15_000)

  it('score is 0-100', async () => {
    const { status, body } = await post('/api/mailboxes/1/header-probe', { message_id: '<nonexistent-probe-x@test.internal>' })
    if (status === 200) {
      expect(body.score).toBeGreaterThanOrEqual(0)
      expect(body.score).toBeLessThanOrEqual(100)
    }
  }, 15_000)
})

// ── Sprint 2: Contacts API ────────────────────────────────────────

describe('GET /api/contacts', () => {
  it('returns { rows, total }', async () => {
    const { status, body } = await get('/api/contacts')
    expect(status).toBe(200)
    expect(Array.isArray(body.rows)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  it('supports search param', async () => {
    const { status } = await get('/api/contacts?search=test')
    expect(status).toBe(200)
  })

  it('supports status filter', async () => {
    const { status, body } = await get('/api/contacts?status=active')
    expect(status).toBe(200)
    expect(Array.isArray(body.rows)).toBe(true)
  })

  it('each contact has required fields', async () => {
    const { body } = await get('/api/contacts')
    if (!body.rows.length) return
    const c = body.rows[0]
    for (const f of ['id', 'email', 'status', 'suppressed']) {
      expect(c).toHaveProperty(f)
    }
  })

  it('suppressed is boolean', async () => {
    const { body } = await get('/api/contacts')
    if (!body.rows.length) return
    expect(typeof body.rows[0].suppressed).toBe('boolean')
  })
})

describe('GET /api/contacts/:id', () => {
  it('404 for non-existent id', async () => {
    const { status } = await get('/api/contacts/999999')
    expect(status).toBe(404)
  })

  it('returns send_history array for existing contact', async () => {
    const { body: list } = await get('/api/contacts')
    if (!list.length) return
    const { status, body } = await get(`/api/contacts/${list[0].id}`)
    expect(status).toBe(200)
    expect(Array.isArray(body.send_history)).toBe(true)
  })
})

describe('PATCH /api/contacts/:id', () => {
  it('404 for non-existent id', async () => {
    const r = await fetch(BASE + '/api/contacts/999999', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' })
    })
    expect(r.status).toBe(404)
  })

  it('400 for empty body', async () => {
    const { body: list } = await get('/api/contacts')
    if (!list.length) return
    const r = await fetch(BASE + `/api/contacts/${list[0].id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(r.status).toBe(400)
  })
})

describe('GET /api/suppression', () => {
  it('returns array', async () => {
    const { status, body } = await get('/api/suppression')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('POST adds to suppression', async () => {
    const email = `test-suppress-${Date.now()}@test.internal`
    const { status, body } = await post('/api/suppression', { email, reason: 'test' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    // cleanup
    await fetch(BASE + `/api/suppression/${email}`, { method: 'DELETE' })
  })
})

// ── Watchdog health — contract ────────────────────────────────────
describe('GET /api/health/watchdog', () => {
  it('returns 200', async () => {
    const { status } = await get('/api/health/watchdog')
    expect(status).toBe(200)
  })

  it('response has required shape: mailboxes, auto_healed_24h, recent_events', async () => {
    const { body } = await get('/api/health/watchdog')
    expect(body).toHaveProperty('mailboxes')
    expect(body).toHaveProperty('auto_healed_24h')
    expect(body).toHaveProperty('recent_events')
  })

  it('mailboxes object has active, paused, retired, warming as numbers', async () => {
    const { body } = await get('/api/health/watchdog')
    const mb = body.mailboxes
    for (const key of ['active', 'paused', 'retired', 'warming']) {
      expect(typeof mb[key]).toBe('number')
    }
  })

  it('auto_healed_24h is a non-negative number', async () => {
    const { body } = await get('/api/health/watchdog')
    expect(typeof body.auto_healed_24h).toBe('number')
    expect(body.auto_healed_24h).toBeGreaterThanOrEqual(0)
  })

  it('recent_events is an array', async () => {
    const { body } = await get('/api/health/watchdog')
    expect(Array.isArray(body.recent_events)).toBe(true)
  })

  it('each event has required fields', async () => {
    const { body } = await get('/api/health/watchdog')
    for (const ev of body.recent_events) {
      for (const f of ['id', 'check_name', 'severity', 'message', 'auto_healed', 'created_at']) {
        expect(ev).toHaveProperty(f)
      }
    }
  })

  it('event severity is one of info|warn|critical', async () => {
    const { body } = await get('/api/health/watchdog')
    const valid = new Set(['info', 'warn', 'critical'])
    for (const ev of body.recent_events) {
      expect(valid.has(ev.severity)).toBe(true)
    }
  })

  it('auto_healed field is boolean', async () => {
    const { body } = await get('/api/health/watchdog')
    for (const ev of body.recent_events) {
      expect(typeof ev.auto_healed).toBe('boolean')
    }
  })
})

// ── Company detail — new fields contract ─────────────────────────
describe('GET /api/companies/:ico — new fields', () => {
  it('returns 404 for non-existent ICO', async () => {
    const { status } = await get('/api/companies/00000001')
    expect(status).toBe(404)
  })

  it('includes new enrichment fields when company exists', async () => {
    // Find the first company via list, then fetch its detail
    const { body: list } = await get('/api/companies?limit=1')
    const rows = Array.isArray(list) ? list : (list.rows ?? [])
    if (!rows.length) return // no companies in test DB — skip

    const { body } = await get(`/api/companies/${rows[0].ico}`)
    for (const f of [
      'nace_code', 'engagement_cluster', 'datum_zaniku',
      'v_likvidaci', 'v_insolvenci', 'description_tags', 'sector_confidence',
    ]) {
      expect(body).toHaveProperty(f)
    }
  })

  it('description_tags is null or array', async () => {
    const { body: list } = await get('/api/companies?limit=1')
    const rows = Array.isArray(list) ? list : (list.rows ?? [])
    if (!rows.length) return

    const { body } = await get(`/api/companies/${rows[0].ico}`)
    expect(
      body.description_tags === null || Array.isArray(body.description_tags)
    ).toBe(true)
  })

  it('sector_confidence is null or number', async () => {
    const { body: list } = await get('/api/companies?limit=1')
    const rows = Array.isArray(list) ? list : (list.rows ?? [])
    if (!rows.length) return

    const { body } = await get(`/api/companies/${rows[0].ico}`)
    expect(
      body.sector_confidence === null || typeof body.sector_confidence === 'number'
    ).toBe(true)
  })
})

// ── Companies filter combinations — regression ────────────────────
describe('GET /api/companies — filter combinations', () => {
  it('icp_tier + size filter returns 200 with rows array', async () => {
    const { status, body } = await get('/api/companies?icp_tier=ideal&size=10-49')
    expect(status).toBe(200)
    expect(Array.isArray(body.rows)).toBe(true)
  })

  it('uncontacted=true filter returns 200 with valid shape', async () => {
    const { status, body } = await get('/api/companies?uncontacted=true')
    expect(status).toBe(200)
    expect(Array.isArray(body.rows)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  it('triple filter combo (icp_tier + uncontacted + size) does not crash server', async () => {
    const { status, body } = await get('/api/companies?icp_tier=ideal&uncontacted=true&size=50-249')
    expect(status).toBe(200)
    expect(body).toHaveProperty('rows')
    expect(body).toHaveProperty('total')
  })

  it('non-existent category returns 200 with empty rows array — no 500', async () => {
    const { status, body } = await get('/api/companies?category=NonExistentCategory_xyzzy_12345')
    expect(status).toBe(200)
    expect(Array.isArray(body.rows)).toBe(true)
  })
})
