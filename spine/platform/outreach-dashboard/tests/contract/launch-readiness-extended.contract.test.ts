// BFF contract: GET /api/launch-readiness — extended gates (H4.1)
//
// Exercises the 4 new sanity gates added in Sprint H4.1:
//   - relay_queue_health: anti-trace relay queue not stuck (>600s = fail)
//   - daemon_liveness: campaign daemon active in audit_log < 10 min
//   - deploy_sha: GIT_SHA / RAILWAY_GIT_COMMIT_SHA env var present
//   - template_drift: DB email_templates body matches .tmpl file
//
// Also verifies that the overall verdict incorporates the new gates and
// that the total gate count increases from 3 to 7.
//
// Reference: features/platform/outreach-dashboard/src/server-routes/health.js (H4.1)
// Issue: #976 (sub-issue of umbrella #975)

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── Mock pg pool ─────────────────────────────────────────────────────────────

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    async connect() {
      const self = this
      return {
        async query(s, p) {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(typeof s === 'string' ? s : '')) return { rows: [], rowCount: 0 }
          return self.query(s, p)
        },
        release() {},
      }
    }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})

vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

// ── Mock node:fs/promises for template drift checks ──────────────────────────

let mockReadFile: ReturnType<typeof vi.fn>

vi.mock('node:fs/promises', () => {
  const mod = { readFile: vi.fn() }
  return { default: mod, ...mod }
})

// ── Relay mock state ─────────────────────────────────────────────────────────
// We intercept fetch only for the relay URL (http://relay.internal/*) and
// let requests to the BFF (http://127.0.0.1:PORT/*) pass through to the
// real globalThis.fetch.

interface RelayResponse {
  ok: boolean
  status?: number
  data?: Record<string, unknown>
}

let relayMockResponse: RelayResponse | null = null
const RELAY_BASE = 'http://relay.internal'

// ── Server setup ─────────────────────────────────────────────────────────────

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}
// Store original fetch before any mocking
const originalFetch = globalThis.fetch

beforeAll(async () => {
  for (const k of [
    'BFF_IMPORT_ONLY', 'DATABASE_URL',
    'ANTI_TRACE_RELAY_URL', 'ANTI_TRACE_RELAY_TOKEN',
    'ANTI_TRACE_URL', 'ANTI_TRACE_TOKEN',
    'GIT_SHA', 'RAILWAY_GIT_COMMIT_SHA', 'SOURCE_COMMIT',
  ]) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })

  const fsMod = await import('node:fs/promises')
  mockReadFile = fsMod.readFile as ReturnType<typeof vi.fn>

  // Install selective fetch mock: relay URL → mock, everything else → real fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.startsWith(RELAY_BASE)) {
      if (!relayMockResponse) throw new Error('relay fetch called but no relayMockResponse set')
      const { ok, status = 200, data = {} } = relayMockResponse
      return {
        ok,
        status: ok ? status : (status || 503),
        json: async () => data,
        text: async () => JSON.stringify(data),
      } as Response
    }
    return originalFetch(input, init)
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.unstubAllGlobals()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
  relayMockResponse = null
  mockReadFile?.mockReset()
  // Clear relay + sha env by default so each test starts clean
  delete process.env.ANTI_TRACE_RELAY_URL
  delete process.env.ANTI_TRACE_RELAY_TOKEN
  delete process.env.ANTI_TRACE_URL
  delete process.env.ANTI_TRACE_TOKEN
  delete process.env.GIT_SHA
  delete process.env.RAILWAY_GIT_COMMIT_SHA
  delete process.env.SOURCE_COMMIT
})

/** Enqueue a successful query result */
function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

/** Enqueue an error for the next pool.query() call */
function qErr(msg: string) {
  queryQueue.push(new Error(msg))
}

/** Enqueue full happy-path set:
 *  - crm_coverage (1 query)
 *  - dedup_guard (2 queries)
 *  - mailboxes (1 query)
 *  - sanity_gates preamble (active mb count + cc count + sequence_config + template lookup)
 *  - daemon_liveness (1 query: MAX created_at)
 *  - template_drift (1 query: body from email_templates — only if includeDriftQuery)
 *  - recent_audit (1 query)
 *
 *  Relay / sha / fs are set by test cases individually via process.env and
 *  relayMockResponse / mockReadFile.
 */
function qBaseHappyPath({
  crmTotal = 100,
  crmBlocked = 0,
  dntCol = true,
  touchesCol = true,
  recentActivityCount = 5,
  mbActive = 4,
  mbPaused = 0,
  mbBouncehold = 0,
  sanityMbCount = 4,
  ccCount = 50,
  sequenceConfig = [{ template: 'default-template' }] as unknown,
  templateRows = [{ id: 1 }] as unknown[],
  includeTemplateQuery = true,
  daemonLastActivity = null as Date | null,
  driftBodyRow = null as { body: string } | null,
  includeDriftQuery = false,
  auditRows = [] as unknown[],
} = {}) {
  // 1. CRM coverage
  q([{ total: crmTotal, blocked: crmBlocked, available: crmTotal - crmBlocked }])
  // 2a. Dedup guard — migration columns
  q([{ dnt_col: dntCol, touches_col: touchesCol }])
  // 2b. Dedup guard — recent activity
  q([{ count: recentActivityCount }])
  // 3. Mailboxes aggregate
  q([{ active: mbActive, paused: mbPaused, bouncehold: mbBouncehold }])
  // 4a. Sanity gates — active mailbox count
  q([{ count: sanityMbCount }])
  // 4b. Sanity gates — campaign_contacts eligible count
  q([{ count: ccCount }])
  // 4c. Sanity gates — campaign sequence_config
  q([{ sequence_config: sequenceConfig }])
  // 4d. Sanity gates — original template existence lookup
  if (includeTemplateQuery) {
    q(templateRows)
  }
  // 4e. Daemon liveness query (MAX created_at from operator_audit_log)
  q([{ last_activity: daemonLastActivity }])
  // 4f. Template drift query (body from email_templates)
  if (includeDriftQuery) {
    q(driftBodyRow ? [driftBodyRow] : [])
  }
  // 5. Recent audit events
  q(auditRows)
}

async function get(path: string) {
  const r = await originalFetch(baseUrl + path, { method: 'GET', headers: { 'content-type': 'application/json' } })
  const text = await r.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

// ── Gate: relay_queue_health ──────────────────────────────────────────────────

describe('GET /api/launch-readiness — gate relay_queue_health', () => {
  it('pass when relay returns queue_depth=0, oldest_pending_age=-1 (idle)', async () => {
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: -1 } }
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'relay_queue_health')
    expect(gate).toBeDefined()
    expect(gate!.pass).toBe(true)
  })

  it('fail when oldest_pending_age_seconds >= 600 (queue stuck)', async () => {
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 5, oldest_pending_age_seconds: 601 } }
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'relay_queue_health')
    expect(gate!.pass).toBe(false)
    expect(gate!.details).toMatch(/601/)
  })

  it('fail when relay returns 5xx status (treat as not-ready)', async () => {
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: false, status: 503, data: {} }
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'relay_queue_health')
    expect(gate!.pass).toBe(false)
    expect(gate!.details).toMatch(/503/)
  })

  it('fail when relay URL not configured (no env var)', async () => {
    // No ANTI_TRACE_RELAY_URL set
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'relay_queue_health')
    expect(gate!.pass).toBe(false)
    expect(gate!.details).toMatch(/not configured/i)
  })
})

// ── Gate: daemon_liveness ─────────────────────────────────────────────────────

describe('GET /api/launch-readiness — gate daemon_liveness', () => {
  it('pass when audit_log has recent campaign_* entry (< 10 min ago)', async () => {
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: -1 } }
    const recentTime = new Date(Date.now() - 60_000) // 1 min ago
    qBaseHappyPath({ daemonLastActivity: recentTime, includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'daemon_liveness')
    expect(gate!.pass).toBe(true)
  })

  it('fail when no audit entry in last 10 min (daemon may be dead)', async () => {
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    const staleTime = new Date(Date.now() - 20 * 60_000) // 20 min ago → stale
    qBaseHappyPath({ daemonLastActivity: staleTime, includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'daemon_liveness')
    expect(gate!.pass).toBe(false)
  })

  it('fail when daemon last_activity is null (no rows ever)', async () => {
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    qBaseHappyPath({ daemonLastActivity: null, includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'daemon_liveness')
    expect(gate!.pass).toBe(false)
    expect(gate!.details).toMatch(/no recent activity/i)
  })
})

// ── Gate: deploy_sha ──────────────────────────────────────────────────────────

describe('GET /api/launch-readiness — gate deploy_sha', () => {
  it('pass and includes SHA prefix when GIT_SHA is set', async () => {
    process.env.GIT_SHA = 'abc1234567890def'
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'deploy_sha')
    expect(gate!.pass).toBe(true)
    expect(gate!.details).toMatch(/sha=abc1234567/)
  })

  it('pass when RAILWAY_GIT_COMMIT_SHA set (Railway env)', async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'railway123456789'
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'deploy_sha')
    expect(gate!.pass).toBe(true)
    expect(gate!.details).toMatch(/railway/)
  })

  it('fail with details "not set" when no SHA env var defined', async () => {
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: null })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'deploy_sha')
    expect(gate!.pass).toBe(false)
    expect(gate!.details).toMatch(/not set/i)
  })
})

// ── Gate: template_drift ──────────────────────────────────────────────────────

describe('GET /api/launch-readiness — gate template_drift', () => {
  it('pass when DB body matches .tmpl file content', async () => {
    process.env.GIT_SHA = 'sha-for-drift-match'
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    const bodyContent = 'Hello {{.FirstName}}, test email.'
    mockReadFile.mockResolvedValueOnce(bodyContent)
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: { body: bodyContent } })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'template_drift')
    expect(gate!.pass).toBe(true)
    expect(gate!.details).toMatch(/matches/i)
  })

  it('fail when DB body differs from .tmpl file', async () => {
    process.env.GIT_SHA = 'sha-drift-fail'
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    mockReadFile.mockResolvedValueOnce('DIFFERENT FILE CONTENT')
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: { body: 'DB CONTENT IS DIFFERENT' } })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'template_drift')
    expect(gate!.pass).toBe(false)
    expect(gate!.details).toMatch(/drift/i)
  })

  it('pass when .tmpl file absent (DB-only mode)', async () => {
    process.env.GIT_SHA = 'sha-db-only'
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    qBaseHappyPath({ includeDriftQuery: true, driftBodyRow: { body: 'some body' } })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'template_drift')
    expect(gate!.pass).toBe(true)
    expect(gate!.details).toMatch(/DB-only/i)
  })

  it('pass when sequence has no template key (details: no template in sequence)', async () => {
    process.env.GIT_SHA = 'sha-no-tmpl'
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    qBaseHappyPath({
      sequenceConfig: [{ subject: 'Hello' }],
      includeTemplateQuery: false,
      includeDriftQuery: false,
    })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean; details?: string }> } } }
    const gate = b.sections.sanity_gates.gates.find((g) => g.id === 'template_drift')
    expect(gate!.pass).toBe(true)
    expect(gate!.details).toMatch(/no template in sequence/i)
  })
})

// ── Verdict aggregation with 7 gates ─────────────────────────────────────────

describe('GET /api/launch-readiness — verdict incorporates 4 new gates', () => {
  it('total gate count is 7 (3 original + 4 new)', async () => {
    process.env.GIT_SHA = 'sha-count-test'
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    const recentTime = new Date(Date.now() - 30_000)
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    qBaseHappyPath({ daemonLastActivity: recentTime, includeDriftQuery: true, driftBodyRow: { body: 'body' } })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { total: number } } }
    expect(b.sections.sanity_gates.total).toBe(7)
  })

  it('verdict=green when all 7 gates pass', async () => {
    process.env.GIT_SHA = 'sha-all-green'
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 0, oldest_pending_age_seconds: 0 } }
    const recentTime = new Date(Date.now() - 30_000)
    const bodyContent = 'template body'
    mockReadFile.mockResolvedValueOnce(bodyContent)
    qBaseHappyPath({ daemonLastActivity: recentTime, includeDriftQuery: true, driftBodyRow: { body: bodyContent } })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { verdict: string; sections: { sanity_gates: { pass_count: number; total: number } } }
    expect(b.sections.sanity_gates.pass_count).toBe(b.sections.sanity_gates.total)
    expect(b.verdict).toBe('green')
  })

  it('verdict=red when relay_queue_health gate fails (queue stuck)', async () => {
    process.env.GIT_SHA = 'sha-relay-fail'
    process.env.ANTI_TRACE_RELAY_URL = RELAY_BASE
    process.env.ANTI_TRACE_RELAY_TOKEN = 'tok'
    relayMockResponse = { ok: true, data: { queue_depth: 3, oldest_pending_age_seconds: 700 } }
    const recentTime = new Date(Date.now() - 30_000)
    const bodyContent = 'template body'
    mockReadFile.mockResolvedValueOnce(bodyContent)
    qBaseHappyPath({ daemonLastActivity: recentTime, includeDriftQuery: true, driftBodyRow: { body: bodyContent } })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { verdict: string }
    expect(b.verdict).toBe('red')
  })
})
