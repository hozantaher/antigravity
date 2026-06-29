import '@testing-library/jest-dom'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

const MAILBOXES = [
  {
    id: '3', email: 'a.mazher@email.cz', display_name: 'Test Name',
    host: 'smtp.seznam.cz', port: 465, smtp_username: 'a.mazher@email.cz',
    imap_host: 'imap.seznam.cz', imap_port: 993, imap_username: 'a.mazher@email.cz',
    daily_limit: 100, status: 'active', status_reason: null,
    total_sent: 382, total_bounced: 8, consecutive_bounces: 0,
    proxy_url: null, warmup_day: 7, warmup_paused: false,
    last_send_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    anti_trace_enabled: true,
  },
  {
    id: '1', email: 'mazher.a@email.cz', display_name: null,
    host: 'smtp.seznam.cz', port: 587, smtp_username: 'mazher.a@email.cz',
    imap_host: null, imap_port: null, imap_username: null,
    daily_limit: 50, status: 'paused', status_reason: null,
    total_sent: 0, total_bounced: 0, consecutive_bounces: 0,
    proxy_url: null, warmup_day: null, warmup_paused: false,
    last_send_at: null, anti_trace_enabled: true,
  },
]

const CAMPAIGNS = [
  { id: 1, name: 'Testovací kampaň', status: 'active', description: null,
    sequence_config: [], category_paths: [], category_match: 'prefix',
    created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    stats: { sent: 120, replied: 8, opened: 30, bounced: 2, queued: 45 } },
  { id: 2, name: 'Druhá kampaň', status: 'draft', description: 'Popis kampaně',
    sequence_config: [], category_paths: ['Stavebnictví'], category_match: 'prefix',
    created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    stats: { sent: 0, replied: 0, opened: 0, bounced: 0, queued: 0 } },
]

const TEMPLATES = [
  { id: 1, name: 'Úvodní šablona', subject: 'Naše nabídka pro {{firma}}',
    body: 'Dobrý den {{jmeno}},\n\npíšu Vám ohledně…', created_at: new Date().toISOString() },
]

const SEGMENTS = [
  { id: 1, name: 'Stavební firmy', description: null, query: {}, company_count: 1250,
    created_at: new Date().toISOString() },
]

export const REPLY_ROWS = [
  { id: 1, send_event_id: 1, campaign_id: 1, contact_id: 1, mailbox_id: 3,
    from_email: 'jan@firma.cz', subject: 'RE: Naše nabídka', classification: 'positive',
    received_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    handled: false, handled_at: null,
    campaign_name: 'Testovací kampaň', contact_name: 'Jan Novák' },
  { id: 2, send_event_id: 2, campaign_id: 1, contact_id: 2, mailbox_id: 3,
    from_email: 'petr@firma.cz', subject: 'Odhlaste mě', classification: 'negative',
    received_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    handled: true, handled_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    campaign_name: 'Testovací kampaň', contact_name: 'Petr Dvořák' },
]

export const ANALYTICS_OVERVIEW = {
  total_sent: 1234, total_replied: 62, total_opened: 310,
  total_bounced: 18, sent_7d: 234, replied_7d: 12,
  active_campaigns: 1,
}

export const ANALYTICS_TIMELINE = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(); d.setDate(d.getDate() - (29 - i))
  return { day: d.toISOString().slice(0, 10), sent: i * 2 + 1, replied: i % 3, opened: i % 7 }
})

export const ANALYTICS_CAMPAIGNS = [
  { id: 1, name: 'Testovací kampaň', status: 'active', sent: 120, replied: 8, opened: 30, bounced: 2 },
  { id: 2, name: 'Druhá kampaň',     status: 'draft',  sent: 0,   replied: 0, opened: 0,  bounced: 0 },
]

export const handlers = [
  http.get('/api/mailboxes', () => HttpResponse.json(MAILBOXES)),
  http.get('/api/campaigns', () => HttpResponse.json(CAMPAIGNS)),
  http.get('/api/campaigns/:id', ({ params }) => {
    const c = CAMPAIGNS.find(x => String(x.id) === params.id)
    if (!c) return HttpResponse.json({ error: 'not found' }, { status: 404 })
    return HttpResponse.json({ campaign: c, stats: c.stats })
  }),
  http.get('/api/campaigns/:id/sends', () => HttpResponse.json([])),
  http.get('/api/campaigns/:id/estimate', () => HttpResponse.json({ count: 250 })),
  http.get('/api/campaigns/:id/email-quality', () => HttpResponse.json({
    total: 100, with_email: 85, without_email: 15, stale: 5,
    valid: 60, risky: 5, catch_all: 8, role_only: 2, invalid: 3, spamtrap: 1, unverified: 6,
  })),
  http.get('/api/campaigns/:id/capacity', () => HttpResponse.json({
    daily_capacity: 150, active_mailboxes: 2, estimate: 600, days_to_complete: 4,
  })),
  http.get('/api/campaigns/:id/preflight', () => HttpResponse.json({
    campaign_id: 1, campaign_name: 'Test', campaign_status: 'draft',
    ok: true,
    checks: [
      { name: 'proxy_assignments',     ok: true,  reason: null },
      { name: 'full_check_fresh',      ok: true,  reason: null },
      { name: 'suppression_populated', ok: true,  reason: null },
      { name: 'daily_capacity',        ok: true,  reason: null },
      { name: 'templates_valid',       ok: true,  reason: null },
    ],
  })),
  http.post('/api/campaigns/:id/run',   () => HttpResponse.json({ ok: true })),
  http.post('/api/campaigns/:id/pause', () => HttpResponse.json({ ok: true })),
  // B4 — extended preflight gate sources. Default to all-green so existing
  // CampaignDetail tests don't regress when the wider gate fetches them.
  http.get('/api/dns-audit', () => HttpResponse.json({ status: 'ok', latency_ms: 12, domains: {} })),
  http.get('/api/diagnostics/bottleneck-status', () => HttpResponse.json({
    smtpFailures: [],
    antiTraceHealth: { status: 'up' },
    engineBootStatus: { status: 'ok' },
    sloBreaches: [],
    generatedAt: new Date().toISOString(),
  })),
  http.post('/api/campaigns', async ({ request }) => {
    const body = await request.json()
    return HttpResponse.json({ id: 99, ...body, status: 'draft', created_at: new Date().toISOString() })
  }),
  http.get('/api/templates', () => HttpResponse.json(TEMPLATES)),
  http.post('/api/templates', async ({ request }) => {
    const body = await request.json()
    return HttpResponse.json({ id: 99, ...body, created_at: new Date().toISOString() })
  }),
  http.put('/api/templates/:id', async ({ request }) => {
    const body = await request.json()
    return HttpResponse.json({ id: 1, ...body })
  }),
  http.delete('/api/templates/:id', () => HttpResponse.json({ ok: true })),
  http.get('/api/segments', () => HttpResponse.json(SEGMENTS)),
  http.get('/api/companies/stats', () => HttpResponse.json({ total: 48320 })),

  // Replies
  http.get('/api/replies', ({ request }) => {
    const url = new URL(request.url)
    const handled = url.searchParams.get('handled')
    const cls     = url.searchParams.get('classification')
    let rows = REPLY_ROWS
    if (handled === 'false') rows = rows.filter(r => !r.handled)
    if (handled === 'true')  rows = rows.filter(r =>  r.handled)
    if (cls)                 rows = rows.filter(r => r.classification === cls)
    return HttpResponse.json({ rows, total: rows.length })
  }),
  http.get('/api/replies/stats', () => HttpResponse.json({
    total: 2, unhandled: 1, positive: 1, negative: 1, auto_reply: 0, today: 1,
  })),
  http.patch('/api/replies/:id', async ({ params, request }) => {
    const body = await request.json()
    const row = REPLY_ROWS.find(r => String(r.id) === params.id)
    if (!row) return HttpResponse.json({ error: 'not found' }, { status: 404 })
    return HttpResponse.json({ ...row, ...body, handled_at: body.handled ? new Date().toISOString() : null })
  }),

  // Analytics
  http.get('/api/analytics/overview',  () => HttpResponse.json(ANALYTICS_OVERVIEW)),
  http.get('/api/analytics/timeline',  () => HttpResponse.json(ANALYTICS_TIMELINE)),
  http.get('/api/analytics/campaigns', () => HttpResponse.json(ANALYTICS_CAMPAIGNS)),

  // Healing
  http.get('/api/healing/log', () => HttpResponse.json({
    events: [
      { id: 1, entity_type: 'mailbox', entity_id: 3, entity_label: 'a.mazher@email.cz',
        action: 'auto_pause', reason: '3 consecutive SMTP failures',
        resolved_at: null, created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
    ],
    total: 1,
  })),
  http.get('/api/healing/stats', () => HttpResponse.json({
    by_action: [{ action: 'auto_pause', cnt: 1, last_at: new Date().toISOString() }],
    today: 1,
  })),

  http.get('/api/anti-trace/health', () => HttpResponse.json({ ok: true, url: 'http://localhost:8090', ms: 2 })),
  http.get('/api/proxy-pool', () => HttpResponse.json({ total_candidates: 50, probed: 10, working: [], cached_at: new Date().toISOString() })),

  // T-0005: mailboxes health summary
  http.get('/api/mailboxes/health-summary', () => HttpResponse.json({
    total: 2, healthy: 1, degraded: 1, critical: 0,
    mailboxes: [
      { id: '3', email: 'a.mazher@email.cz', score: 85, critical: [] },
      { id: '1', email: 'mazher.a@email.cz', score: 50, critical: ['no_imap'] },
    ],
  })),

  // T-0006: mailboxes send trends
  http.get('/api/mailboxes/send-trends', () => HttpResponse.json(
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i))
      return { day: d.toISOString().slice(0, 10), sent: i * 5, bounced: i % 2 }
    })
  )),

  // T-0007: health system
  http.get('/api/health/system', () => HttpResponse.json({
    ok: true, db: 'ok', go_backend: 'ok', uptime: 3600,
  })),

  // T-0008: health watchdog — default 500 so widget is absent; override per-test with server.use()
  http.get('/api/health/watchdog', () => new HttpResponse(null, { status: 500 })),

  // T-0009: health drift
  http.get('/api/health/drift', () => HttpResponse.json({
    ok: true, drift: false, checks: [], last_checked: new Date().toISOString(),
  })),

  // T-0010: health guards
  http.get('/api/health/guards', () => HttpResponse.json({
    ok: true, stale: false, guards: [],
  })),

  // T-0011: contacts
  http.get('/api/contacts', () => HttpResponse.json({
    rows: [
      { id: 1, email: 'jan@firma.cz', name: 'Jan Novák', company_name: 'Firma s.r.o.', status: 'active' },
    ],
    total: 1,
  })),

  // T-0012: version
  http.get('/api/version', () => HttpResponse.json({ sha: 'abc1234', version: '1.0.0', built_at: new Date().toISOString() })),

  // KT-A11: dashboard live metrics. Polling fallback returns a static snapshot
  // so any page mounting useDashboardMetrics gets deterministic data without
  // an SSE backend. EventSource is undefined in jsdom by default → hook drops
  // straight to polling, hits this handler.
  http.get('/api/dashboard/metrics', () => HttpResponse.json({
    generated_at: new Date().toISOString(),
    globals: {
      send_rate_60m: 0, send_rate_6h_avg: 0, open_rate_24h: null,
      sends_24h: 0, opens_24h: 0, active_campaigns: 0,
    },
    campaigns: [],
    meta: { last_tick_at: null, tick_interval_ms: 10_000, source: 'polling' },
  })),

  // additional handlers for hooks/components
  http.get('/api/companies/facets', () => HttpResponse.json({
    sectors: [{ value: 'Stavebnictví', count: 120 }],
    regions: [{ value: 'Praha', count: 45 }],
    employee_bands: [{ value: '10-49', count: 80 }],
  })),
  http.get('/api/mailboxes/:id/full-check', () => HttpResponse.json({
    score: 85, ok: true, checks: {}, critical: [], warnings: [], cached_at: new Date().toISOString(),
  })),
  http.get('/api/mailboxes/:id/check-history', () => HttpResponse.json([])),
  http.get('/api/mailboxes/:id/imap-inbox', () => HttpResponse.json({ ok: true, messages: [] })),
  http.get('/api/mailboxes/:id/watchdog-events', () => HttpResponse.json({ events: [], total: 0 })),
  http.get('/api/mailboxes/:id/campaigns', () => HttpResponse.json({ total: 0, campaigns: [] })),
]

export const server = setupServer(...handlers)

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'warn' })
  // Patch relative URLs AFTER MSW has installed its interceptor so our
  // wrapper sits on top and delegates to MSW-patched fetch.
  // Use location.origin so the prefix matches whatever jsdom resolves handlers against.
  const base = (typeof location !== 'undefined' && location.origin) || 'http://localhost'
  const mswFetch = globalThis.fetch
  if (typeof mswFetch === 'function') {
    globalThis.fetch = (input, init) => {
      if (typeof input === 'string' && input.startsWith('/')) {
        input = base + input
      }
      return mswFetch(input, init)
    }
  }
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
