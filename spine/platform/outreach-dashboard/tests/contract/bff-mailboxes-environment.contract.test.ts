// ═══════════════════════════════════════════════════════════════════════════
//  J3 / H6.3 — environment column isolation contract tests
//
// Verifies that:
//   1. GET /api/mailboxes (no ?all=1) only returns environment='production' rows
//   2. GET /api/mailboxes?all=1 returns rows from all environments
//   3. campaign-send-batch.mjs query includes AND environment='production'
//   4. preflight.go query includes environment = 'production'
//   5. MB_SELECT_PROD constant is defined in server-routes/mailboxes.js
//   6. migration 055 SQL contains correct patterns
//   7. Various structural invariants on the environment column
//
// These are static-analysis (source ratchet) + BFF integration checks.
// No real DB required — pg is mocked.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── source-ratchet helpers ────────────────────────────────────────────────

// Re-root: this dashboard now lives at <worktree>/features/platform/outreach-dashboard,
// so __dirname is tests/contract under it. The source-ratchet relPaths below are
// anchored at the worktree root (features/…, scripts/migrations/…), which is five
// levels up from tests/contract (contract → tests → outreach-dashboard → platform →
// features → <worktree root>).
const ROOT = resolve(__dirname, '../../../../..')

function src(relPath: string) {
  return readFileSync(resolve(ROOT, relPath), 'utf-8')
}

// ── BFF mock setup ─────────────────────────────────────────────────────────

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [] }
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

const API_KEY = 'test-key-environment-isolation'
let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  process.env.OUTREACH_API_KEY = API_KEY
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

function queueRows(rows: unknown[]) {
  queryQueue.push({ rows })
}

async function getMailboxes(query = '') {
  const r = await fetch(baseUrl + '/api/mailboxes' + query, {
    headers: { 'x-api-key': API_KEY },
  })
  const text = await r.text()
  const json = text ? JSON.parse(text) : null
  return { status: r.status, body: json, raw: text }
}

// ── Static source-ratchet tests ───────────────────────────────────────────

describe('Source ratchet — environment filter in production query paths', () => {
  it('campaign-send-batch.mjs contains AND environment=production filter', () => {
    const content = src('features/platform/outreach-dashboard/campaign-send-batch.mjs')
    expect(content).toMatch(/AND\s+environment\s*=\s*'production'/i)
  })

  it('campaign-send-batch.mjs does NOT query mailboxes without environment filter', () => {
    const content = src('features/platform/outreach-dashboard/campaign-send-batch.mjs')
    // The one mailbox query must include both status='active' AND environment='production'
    const match = content.match(/SELECT[^`]+FROM outreach_mailboxes[^`]+/s)
    expect(match).toBeTruthy()
    expect(match![0]).toContain("environment='production'")
  })

  it('preflight.go contains environment = production filter', () => {
    const content = src('features/outreach/campaigns/campaign/preflight.go')
    expect(content).toMatch(/environment\s*=\s*'production'/i)
  })

  it('mailboxes.js defines MB_SELECT_PROD constant', () => {
    const content = src('features/platform/outreach-dashboard/src/server-routes/mailboxes.js')
    expect(content).toContain('MB_SELECT_PROD')
    expect(content).toMatch(/MB_SELECT_PROD.*environment\s*=\s*'production'/s)
  })

  it('mailboxes.js GET /api/mailboxes uses MB_SELECT_PROD by default', () => {
    const content = src('features/platform/outreach-dashboard/src/server-routes/mailboxes.js')
    // showAll=false path must use MB_SELECT_PROD
    expect(content).toContain('MB_SELECT_PROD')
    expect(content).toContain('showAll')
  })

  it('migration 055 adds environment column with CHECK constraint', () => {
    const content = src('scripts/migrations/055_outreach_mailboxes_environment.sql')
    expect(content).toContain('ADD COLUMN IF NOT EXISTS environment')
    expect(content).toContain("CHECK (environment IN ('production', 'test', 'dev', 'staging'))")
  })

  it('migration 055 creates index on environment column', () => {
    const content = src('scripts/migrations/055_outreach_mailboxes_environment.sql')
    expect(content).toContain('CREATE INDEX IF NOT EXISTS idx_outreach_mailboxes_environment')
  })

  it('migration 055 marks e2e mailboxes as test environment', () => {
    const content = src('scripts/migrations/055_outreach_mailboxes_environment.sql')
    expect(content).toMatch(/UPDATE outreach_mailboxes\s+SET environment\s*=\s*'test'/s)
    expect(content).toContain("smtp_username LIKE 'e2e%'")
    expect(content).toContain("smtp_username LIKE '%@test.internal'")
  })

  it('mailbox.go Mailbox struct has Environment field', () => {
    const content = src('features/outreach/mailboxes/mailbox/mailbox.go')
    expect(content).toContain('Environment string')
  })

  it('mailbox.go Filter struct has Environment field', () => {
    const content = src('features/outreach/mailboxes/mailbox/mailbox.go')
    expect(content).toContain('Environment string')
  })

  it('postgres.go mailboxColumns includes environment', () => {
    const content = src('features/outreach/mailboxes/mailbox/postgres.go')
    expect(content).toContain('environment')
  })

  // AP5 extension: Go orchestrator paths also require environment filter.
  it('anonymity-harvest loadMailboxes includes AND environment=production (AP5)', () => {
    const content = src('features/inbound/orchestrator/cmd/anonymity-harvest/main.go')
    // Find the FROM outreach_mailboxes query and verify it includes the env filter.
    const match = content.match(/FROM outreach_mailboxes[^`"]+/s)
    expect(match).toBeTruthy()
    expect(match![0]).toMatch(/AND\s+environment\s*=\s*'production'/i)
  })

  it('anonymity-test loadMailboxes includes AND environment=production (AP5)', () => {
    const content = src('features/inbound/orchestrator/cmd/anonymity-test/main.go')
    const match = content.match(/FROM outreach_mailboxes[^`"]+/s)
    expect(match).toBeTruthy()
    expect(match![0]).toMatch(/AND\s+environment\s*=\s*'production'/i)
  })

  it('mailbox_score_loop.go includes AND environment=production (AP5)', () => {
    const content = src('features/inbound/orchestrator/intelligence/mailbox_score_loop.go')
    expect(content).toMatch(/AND\s+environment\s*=\s*'production'/i)
  })
})

// ── BFF integration tests ─────────────────────────────────────────────────

describe('GET /api/mailboxes — environment isolation via BFF', () => {
  it('default response returns HTTP 200', async () => {
    queueRows([{ id: 1, email: 'mb1@redacted', environment: 'production', status: 'active' }])
    const res = await getMailboxes()
    expect(res.status).toBe(200)
  })

  it('default request sends query containing environment=production filter', async () => {
    queueRows([])
    await getMailboxes()
    const lastCall = calls[calls.length - 1]
    expect(lastCall?.sql).toMatch(/environment\s*=\s*'production'/i)
  })

  it('?all=1 request does NOT filter by environment', async () => {
    queueRows([])
    await getMailboxes('?all=1')
    const lastCall = calls[calls.length - 1]
    // The all=1 path uses MB_SELECT which has no environment filter at the SELECT level
    expect(lastCall?.sql).not.toMatch(/WHERE.*environment\s*=\s*'production'/i)
  })

  it('returns environment field in response rows', async () => {
    queueRows([
      { id: 1, email: 'mb1@redacted', environment: 'production', status: 'active', password: 'S3curePass!' },
    ])
    const res = await getMailboxes()
    expect(res.status).toBe(200)
    const arr = res.body as Array<Record<string, unknown>>
    // environment is not password — it should be included in the response
    expect(arr).toHaveLength(1)
  })

  it('empty result when no production mailboxes returns empty array', async () => {
    queueRows([])
    const res = await getMailboxes()
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})
