// BFF contract: GET /api/launch-readiness
//
// Pre-launch gate widget — validates campaign + segment readiness before
// operator dispatches a campaign. Exercises:
//   - 400 validation paths (missing/non-numeric/≤0 params)
//   - CRM coverage traffic light thresholds (>10% amber, >25% red)
//   - Dedup-guard migration column existence check
//   - Mailbox status aggregate section
//   - Sanity gates (mailboxes count, eligible contacts, template existence)
//   - Recent audit section
//   - Per-section error isolation (one section throws → others still populate)
//   - Verdict aggregation rules
//
// Reference: features/platform/outreach-dashboard/src/server-routes/health.js:489–693
// Issue: #823

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

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

// H4.1: mock node:fs/promises so template_drift gate doesn't hit filesystem
vi.mock('node:fs/promises', () => {
  const mod = { readFile: vi.fn() }
  return { default: mod, ...mod }
})

const RELAY_STUB_BASE = 'http://relay.stub.internal'

let baseUrl = ''
let server: import('http').Server
let mockReadFile: ReturnType<typeof vi.fn>
const savedEnv: Record<string, string | undefined> = {}
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

  // Selective fetch mock: relay stub URL → mock 200 idle; everything else → real fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.startsWith(RELAY_STUB_BASE)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ queue_depth: 0, oldest_pending_age_seconds: 0 }),
        text: async () => '{"queue_depth":0,"oldest_pending_age_seconds":0}',
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
  mockReadFile?.mockReset()
  // H4.1: default env so new gates pass in existing tests
  process.env.ANTI_TRACE_RELAY_URL = RELAY_STUB_BASE
  process.env.ANTI_TRACE_RELAY_TOKEN = 'stub-token'
  process.env.GIT_SHA = 'stub-sha-for-tests'
  // Default fs mock: ENOENT → DB-only mode → template_drift passes
  mockReadFile?.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
})

/** Enqueue a successful query result */
function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

/** Enqueue an error for the next pool.query() call */
function qErr(msg: string) {
  queryQueue.push(new Error(msg))
}

/** Enqueue a full happy-path set: crm_coverage, dedup_guard (2 queries),
 *  mailboxes, sanity_gates (3 queries + conditional template lookup +
 *  daemon_liveness query + conditional template_drift body query),
 *  recent_audit.
 *
 *  H4.1: adds 2 new queries — daemon_liveness (MAX created_at) and
 *  template_drift (body from email_templates, only when template present).
 *  Query count: 10 when no template key, 12 when template present.
 *
 *  NOTE: sequenceConfig must be the raw JS value (array or object), not a
 *  JSON string. The mock row is returned as-is; the handler reads
 *  camp.sequence_config directly and calls Array.isArray() on it. */
function qHappyPath({
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
  // Pass the parsed array so Array.isArray() returns true in the handler
  sequenceConfig = [{ template: 'default-template' }] as unknown,
  templateRows = [{ id: 1 }] as unknown[],
  includeTemplateQuery = true,
  // H4.1: daemon_liveness — recent activity (< 10 min ago by default)
  daemonLastActivity = new Date(Date.now() - 30_000) as Date | null,
  // H4.1: template_drift body row (null → no DB row → pass when no .tmpl file)
  driftBodyRow = { body: 'stub-body' } as { body: string } | null,
  auditRows = [] as unknown[],
} = {}) {
  // 1. CRM coverage
  q([{ total: crmTotal, blocked: crmBlocked, available: crmTotal - crmBlocked }])
  // 2a. Dedup guard — migration columns check (has inner .catch; fires always)
  q([{ dnt_col: dntCol, touches_col: touchesCol }])
  // 2b. Dedup guard — recent activity audit_log (has inner .catch; fires always)
  q([{ count: recentActivityCount }])
  // 3. Mailboxes aggregate
  q([{ active: mbActive, paused: mbPaused, bouncehold: mbBouncehold }])
  // 4a. Sanity gates — active mailbox count (separate SELECT COUNT)
  q([{ count: sanityMbCount }])
  // 4b. Sanity gates — campaign_contacts eligible count
  q([{ count: ccCount }])
  // 4c. Sanity gates — campaign sequence_config
  q([{ sequence_config: sequenceConfig }])
  // 4d. Sanity gates — email_templates lookup (only fires when seq[0].template truthy)
  if (includeTemplateQuery) {
    q(templateRows)
  }
  // 4e. H4.1: daemon_liveness — MAX(created_at) from operator_audit_log
  q([{ last_activity: daemonLastActivity }])
  // 4f. H4.1: template_drift body query (only fires when template present)
  if (includeTemplateQuery) {
    q(driftBodyRow ? [driftBodyRow] : [])
  }
  // 5. Recent audit events
  q(auditRows)
}

async function get(path: string) {
  // Use originalFetch so the test HTTP call bypasses the relay stub mock
  const r = await originalFetch(baseUrl + path, { method: 'GET', headers: { 'content-type': 'application/json' } })
  const text = await r.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

// ── 400 validation: campaign_id ───────────────────────────────────────────────

describe('GET /api/launch-readiness — 400 invalid campaign_id', () => {
  it('returns 400 when campaign_id is missing', async () => {
    const { status, body } = await get('/api/launch-readiness?segment_id=1')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/campaign_id/i)
  })

  it('returns 400 when campaign_id is non-numeric string', async () => {
    const { status, body } = await get('/api/launch-readiness?campaign_id=abc&segment_id=1')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/campaign_id/i)
  })

  it('returns 400 when campaign_id is zero', async () => {
    const { status, body } = await get('/api/launch-readiness?campaign_id=0&segment_id=1')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/campaign_id/i)
  })

  it('returns 400 when campaign_id is negative', async () => {
    const { status, body } = await get('/api/launch-readiness?campaign_id=-5&segment_id=1')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/campaign_id/i)
  })
})

// ── 400 validation: segment_id ────────────────────────────────────────────────

describe('GET /api/launch-readiness — 400 invalid segment_id', () => {
  it('returns 400 when segment_id is missing', async () => {
    const { status, body } = await get('/api/launch-readiness?campaign_id=1')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/segment_id/i)
  })

  it('returns 400 when segment_id is non-numeric string', async () => {
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=xyz')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/segment_id/i)
  })

  it('returns 400 when segment_id is zero', async () => {
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=0')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/segment_id/i)
  })
})

// ── CRM coverage traffic light ────────────────────────────────────────────────

describe('GET /api/launch-readiness — crm_coverage traffic light', () => {
  it('green: ≤10% blocked → traffic_light=green, no action_item for coverage', async () => {
    // 5/100 = 5% blocked → green
    qHappyPath({ crmTotal: 100, crmBlocked: 5 })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { crm_coverage: { traffic_light: string; blocked_pct: number } }; action_items: string[] }
    expect(b.sections.crm_coverage.traffic_light).toBe('green')
    expect(b.sections.crm_coverage.blocked_pct).toBe(5)
    // No action_item for CRM coverage when green
    const crmItems = b.action_items.filter((a) => a.startsWith('CRM coverage'))
    expect(crmItems).toHaveLength(0)
  })

  it('amber: 10-25% blocked → traffic_light=amber, action_item present', async () => {
    // 15/100 = 15% blocked → amber
    qHappyPath({ crmTotal: 100, crmBlocked: 15 })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { crm_coverage: { traffic_light: string } }; action_items: string[] }
    expect(b.sections.crm_coverage.traffic_light).toBe('amber')
    const crmItems = b.action_items.filter((a) => a.startsWith('CRM coverage'))
    expect(crmItems).toHaveLength(1)
  })

  it('red: >25% blocked → traffic_light=red, verdict=red', async () => {
    // 30/100 = 30% blocked → red
    qHappyPath({ crmTotal: 100, crmBlocked: 30 })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { verdict: string; sections: { crm_coverage: { traffic_light: string } }; action_items: string[] }
    expect(b.sections.crm_coverage.traffic_light).toBe('red')
    expect(b.verdict).toBe('red')
    const crmItems = b.action_items.filter((a) => a.startsWith('CRM coverage'))
    expect(crmItems).toHaveLength(1)
  })

  it('crm_coverage error path: pool throws → section gets {error:...}, other sections still populate', async () => {
    // Override: first query (CRM) throws, rest happy-path
    qErr('crm db error')
    // dedup_guard
    q([{ dnt_col: true, touches_col: true }])
    q([{ count: 3 }])
    // mailboxes
    q([{ active: 4, paused: 0, bouncehold: 0 }])
    // sanity gates
    q([{ count: 4 }])
    q([{ count: 10 }])
    q([{ sequence_config: [{ template: 'default-template' }] }])
    q([{ id: 1 }])
    // recent_audit
    q([])

    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as {
      sections: {
        crm_coverage: { error: string }
        dedup_guard: { migration_applied: boolean }
        mailboxes: { active: number }
      }
    }
    expect(b.sections.crm_coverage.error).toBeTruthy()
    // Other sections should be populated — not errored
    expect(b.sections.dedup_guard.migration_applied).toBeDefined()
    expect(b.sections.mailboxes.active).toBeDefined()
  })
})

// ── Dedup guard ───────────────────────────────────────────────────────────────

describe('GET /api/launch-readiness — dedup_guard', () => {
  it('migration_applied=true when both dnt + lifetime_touches columns present', async () => {
    qHappyPath({ dntCol: true, touchesCol: true })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { dedup_guard: { migration_applied: boolean; operational: boolean } } }
    expect(b.sections.dedup_guard.migration_applied).toBe(true)
  })

  it('migration_applied=false when columns missing → action_item added', async () => {
    qHappyPath({ dntCol: false, touchesCol: false })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { dedup_guard: { migration_applied: boolean } }; action_items: string[] }
    expect(b.sections.dedup_guard.migration_applied).toBe(false)
    const dedupItems = b.action_items.filter((a) => a.includes('Dedup-guard'))
    expect(dedupItems.length).toBeGreaterThanOrEqual(1)
    expect(dedupItems[0]).toMatch(/migration 049 not applied/i)
  })

  it('migration_applied=false when only one column present', async () => {
    qHappyPath({ dntCol: true, touchesCol: false })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { dedup_guard: { migration_applied: boolean } }; action_items: string[] }
    expect(b.sections.dedup_guard.migration_applied).toBe(false)
  })
})

// ── Mailboxes section ─────────────────────────────────────────────────────────

describe('GET /api/launch-readiness — mailboxes', () => {
  it('returns aggregate counts for active / paused / bouncehold', async () => {
    qHappyPath({ mbActive: 4, mbPaused: 1, mbBouncehold: 2 })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { mailboxes: { active: number; paused: number; bouncehold: number } } }
    expect(b.sections.mailboxes.active).toBe(4)
    expect(b.sections.mailboxes.paused).toBe(1)
    expect(b.sections.mailboxes.bouncehold).toBe(2)
  })

  it('0 active mailboxes → action_item added and sanity gate fails', async () => {
    qHappyPath({ mbActive: 0, mbPaused: 2, mbBouncehold: 0, sanityMbCount: 0 })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { mailboxes: { active: number } }; action_items: string[] }
    expect(b.sections.mailboxes.active).toBe(0)
    const mbItems = b.action_items.filter((a) => a.includes('mailbox'))
    expect(mbItems.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Sanity gates section ──────────────────────────────────────────────────────

describe('GET /api/launch-readiness — sanity_gates', () => {
  it('all gates pass: 4+ active mailboxes, eligible contacts, valid template', async () => {
    qHappyPath({ sanityMbCount: 4, ccCount: 20, templateRows: [{ id: 1 }] })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { total: number; pass_count: number; gates: Array<{ id: string; pass: boolean }> } } }
    expect(b.sections.sanity_gates.pass_count).toBe(b.sections.sanity_gates.total)
    const allPassed = b.sections.sanity_gates.gates.every((g) => g.pass)
    expect(allPassed).toBe(true)
  })

  it('eligible contacts gate: ccCount > 0 → contacts gate passes', async () => {
    qHappyPath({ ccCount: 15 })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean }> } } }
    const contactsGate = b.sections.sanity_gates.gates.find((g) => g.id === 'contacts')
    expect(contactsGate?.pass).toBe(true)
  })

  it('eligible contacts gate: ccCount === 0 → contacts gate fails', async () => {
    qHappyPath({ ccCount: 0 })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean }> } }; action_items: string[] }
    const contactsGate = b.sections.sanity_gates.gates.find((g) => g.id === 'contacts')
    expect(contactsGate?.pass).toBe(false)
    const contactsItems = b.action_items.filter((a) => a.includes('contacts') || a.includes('Contacts'))
    expect(contactsItems.length).toBeGreaterThanOrEqual(1)
  })

  it('template gate passes when email_templates row found', async () => {
    qHappyPath({ templateRows: [{ id: 42 }] })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean }> } } }
    const templateGate = b.sections.sanity_gates.gates.find((g) => g.id === 'template')
    expect(templateGate?.pass).toBe(true)
  })

  it('template gate fails when template name missing from sequence_config', async () => {
    // No 'template' key in seq[0] → templateName is undefined → lookup never fires
    qHappyPath({
      sequenceConfig: [{ subject: 'Hello' }],
      includeTemplateQuery: false,
    })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean }> } } }
    const templateGate = b.sections.sanity_gates.gates.find((g) => g.id === 'template')
    expect(templateGate?.pass).toBe(false)
  })

  it('template gate fails when template name not found in email_templates', async () => {
    qHappyPath({
      sequenceConfig: [{ template: 'nonexistent-template' }],
      templateRows: [],
    })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean }> } } }
    const templateGate = b.sections.sanity_gates.gates.find((g) => g.id === 'template')
    expect(templateGate?.pass).toBe(false)
  })

  it('mailboxes gate: <4 active → pass=false for mailboxes gate', async () => {
    qHappyPath({ sanityMbCount: 2 })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { sanity_gates: { gates: Array<{ id: string; pass: boolean }> } } }
    const mbGate = b.sections.sanity_gates.gates.find((g) => g.id === 'mailboxes')
    expect(mbGate?.pass).toBe(false)
  })
})

// ── Recent audit section ──────────────────────────────────────────────────────

describe('GET /api/launch-readiness — recent_audit', () => {
  it('empty: no rows in last 24h → events=[], count_24h=0', async () => {
    qHappyPath({ auditRows: [] })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { recent_audit: { events: unknown[]; count_24h: number } } }
    expect(b.sections.recent_audit.events).toEqual([])
    expect(b.sections.recent_audit.count_24h).toBe(0)
  })

  it('returns mapped events with action + timestamp from audit log rows', async () => {
    const now = new Date().toISOString()
    qHappyPath({
      auditRows: [
        { action: 'crm_import', created_at: now, actor: 'tomas' },
        { action: 'campaign_activate', created_at: now, actor: 'tomas' },
      ],
    })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { sections: { recent_audit: { events: Array<{ action: string; timestamp: string }>; count_24h: number } } }
    expect(b.sections.recent_audit.count_24h).toBe(2)
    expect(b.sections.recent_audit.events[0].action).toBe('crm_import')
  })
})

// ── Verdict aggregation ───────────────────────────────────────────────────────

describe('GET /api/launch-readiness — verdict aggregation', () => {
  it('verdict=green: all sections clean, no action_items', async () => {
    qHappyPath({
      crmTotal: 100,
      crmBlocked: 0,
      dntCol: true,
      touchesCol: true,
      recentActivityCount: 2,
      mbActive: 4,
      sanityMbCount: 4,
      ccCount: 10,
      templateRows: [{ id: 1 }],
    })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { verdict: string; action_items: string[] }
    expect(b.verdict).toBe('green')
    expect(b.action_items).toHaveLength(0)
  })

  it('verdict=amber: only amber-level CRM issue (>10% blocked), no gate failures', async () => {
    // 15% blocked → amber CRM but gates all pass
    qHappyPath({ crmTotal: 100, crmBlocked: 15, sanityMbCount: 4, ccCount: 5, templateRows: [{ id: 1 }] })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { verdict: string }
    expect(b.verdict).toBe('amber')
  })

  it('verdict=red: crm_coverage traffic_light=red triggers red verdict', async () => {
    // 30% blocked → red CRM
    qHappyPath({ crmTotal: 100, crmBlocked: 30, sanityMbCount: 4, ccCount: 5, templateRows: [{ id: 1 }] })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { verdict: string }
    expect(b.verdict).toBe('red')
  })

  it('verdict=red: sanity gate failure (0 contacts) escalates to red', async () => {
    qHappyPath({ crmTotal: 100, crmBlocked: 0, sanityMbCount: 4, ccCount: 0, templateRows: [{ id: 1 }] })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { verdict: string }
    expect(b.verdict).toBe('red')
  })
})

// ── Section error isolation ───────────────────────────────────────────────────

describe('GET /api/launch-readiness — per-section error isolation', () => {
  it('mailboxes section error does not cascade: other sections still populate', async () => {
    // CRM ok
    q([{ total: 100, blocked: 0, available: 100 }])
    // dedup_guard ok
    q([{ dnt_col: true, touches_col: true }])
    q([{ count: 2 }])
    // mailboxes throws
    qErr('mailboxes db error')
    // sanity gates — pool keeps flowing; mailbox count check
    q([{ count: 4 }])
    q([{ count: 10 }])
    // NOTE: sequence_config is a JSON string so Array.isArray→false, seq=[], no template lookup fires
    q([{ sequence_config: JSON.stringify([{ template: 'default-template' }]) }])
    // q([{id:1}]) would be for template lookup, but it doesn't fire (JSON string sequence_config)
    // H4.1: daemon_liveness query — consumes this slot instead
    q([{ last_activity: null }])
    // H4.1: drift check also skips (seq=[]) — no extra query
    // recent audit
    q([])

    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as {
      sections: {
        crm_coverage: { traffic_light: string }
        mailboxes: { error: string }
        dedup_guard: { migration_applied: boolean }
      }
    }
    expect(b.sections.mailboxes.error).toBeTruthy()
    // Other sections populated
    expect(b.sections.crm_coverage.traffic_light).toBe('green')
    expect(b.sections.dedup_guard.migration_applied).toBe(true)
  })

  it('sanity_gates section error does not cascade: crm/mailboxes/audit still populate', async () => {
    // CRM ok
    q([{ total: 100, blocked: 2, available: 98 }])
    // dedup_guard ok
    q([{ dnt_col: true, touches_col: true }])
    q([{ count: 1 }])
    // mailboxes ok
    q([{ active: 4, paused: 0, bouncehold: 0 }])
    // sanity_gates first query throws
    qErr('sanity db error')
    // recent audit ok
    q([{ action: 'crm_import', created_at: new Date().toISOString(), actor: 'tomas' }])

    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as {
      sections: {
        crm_coverage: { traffic_light: string }
        mailboxes: { active: number }
        sanity_gates: { error: string }
        recent_audit: { count_24h: number }
      }
    }
    expect(b.sections.sanity_gates.error).toBeTruthy()
    expect(b.sections.crm_coverage.traffic_light).toBe('green')
    expect(b.sections.mailboxes.active).toBe(4)
    expect(b.sections.recent_audit.count_24h).toBe(1)
  })
})

// ── Response shape invariants ─────────────────────────────────────────────────

describe('GET /api/launch-readiness — response shape invariants', () => {
  it('always includes campaign_id, segment_id, verdict, sections, action_items, timestamp', async () => {
    qHappyPath()
    const { status, body } = await get('/api/launch-readiness?campaign_id=7&segment_id=3')
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.campaign_id).toBe(7)
    expect(b.segment_id).toBe(3)
    expect(typeof b.verdict).toBe('string')
    expect(b.sections).toBeDefined()
    expect(Array.isArray(b.action_items)).toBe(true)
    expect(typeof b.timestamp).toBe('string')
    // timestamp is valid ISO
    expect(() => new Date(b.timestamp as string).toISOString()).not.toThrow()
  })

  it('multiple action_items accumulate when multiple sections degrade', async () => {
    // CRM: 30% blocked → red + action item
    // dedup guard: missing → action item
    // 0 active mailboxes → action item
    // sanity_gates: mailboxes < 4 + 0 contacts → 2 action items
    qHappyPath({
      crmTotal: 100,
      crmBlocked: 30,
      dntCol: false,
      touchesCol: false,
      recentActivityCount: 0,
      mbActive: 0,
      sanityMbCount: 0,
      ccCount: 0,
      templateRows: [],
    })
    const { status, body } = await get('/api/launch-readiness?campaign_id=1&segment_id=1')
    expect(status).toBe(200)
    const b = body as { action_items: string[] }
    // At least: CRM, dedup guard, sender mailboxes, gate: mailboxes, gate: contacts, gate: template
    expect(b.action_items.length).toBeGreaterThanOrEqual(4)
  })
})
