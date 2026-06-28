// Contract tests for the create-time template gate on POST /api/campaigns.
// Since Sprint AH the authoritative template source is the DB (email_templates)
// — both the Go runner and the Node sender render from it; the legacy .tmpl
// disk files are tests-only. The gate therefore validates step templates
// against email_templates (not the filesystem) so the operator sees a 412 in
// the wizard if a step references a template that doesn't exist.

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
        on() {} end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  vi.resetModules()
  const mod = await import('../../server.js')
  delete process.env.GO_SERVER_URL // no Go → gate-pass falls through to 503, never 412
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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

beforeEach(() => { queryQueue.length = 0; calls.length = 0 })

// Queue the email_templates lookup result (rows of {name}). The gate issues
// exactly one such SELECT before reaching the Go-proxy / 503 path.
function queueTemplates(names: string[]) { queryQueue.push({ rows: names.map((name) => ({ name })) }) }

async function postCampaign(body: object) {
  return fetch(`${baseUrl}/api/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/campaigns — create-time template gate (DB-backed)', () => {
  it('1: 412 when a step references a template absent from email_templates', async () => {
    queueTemplates([]) // none present
    const res = await postCampaign({
      name: 'C1', category_paths: ['machinery'],
      steps: [{ step: 0, delay_days: 0, template: 'made-up-template' }],
    })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ code: string; missing_templates?: string[] }> }
    expect(body.blockers[0].code).toBe('T2_missing_template')
    expect(body.blockers[0].missing_templates).toContain('made-up-template')
  })

  it('2: 412 detail names the missing template', async () => {
    queueTemplates([])
    const res = await postCampaign({ name: 'C1', steps: [{ step: 0, template: 'no-such' }] })
    const body = await res.json() as { blockers: Array<{ detail: string }> }
    expect(body.blockers[0].detail).toMatch(/no-such/)
  })

  it('3: NOT 412 when the template exists in email_templates', async () => {
    queueTemplates(['initial'])
    const res = await postCampaign({
      name: 'C1', category_paths: ['machinery'],
      steps: [{ step: 0, delay_days: 0, template: 'initial' }],
    })
    expect(res.status).not.toBe(412)
  })

  it('4: NOT 412 for a real prod template name (intro_machinery)', async () => {
    queueTemplates(['intro_machinery'])
    const res = await postCampaign({
      name: 'C1', category_paths: ['machinery'],
      steps: [{ step: 0, template: 'intro_machinery' }],
    })
    expect(res.status).not.toBe(412)
  })

  it('5: 412 when ANY step in a multi-step sequence is missing', async () => {
    queueTemplates(['initial']) // followup missing
    const res = await postCampaign({
      name: 'C1',
      steps: [{ step: 0, template: 'initial' }, { step: 1, template: 'made-up-followup' }],
    })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ missing_templates?: string[] }> }
    expect(body.blockers[0].missing_templates).toEqual(['made-up-followup'])
  })

  it('6: missing_templates lists ALL missing names', async () => {
    queueTemplates([])
    const res = await postCampaign({
      name: 'C1',
      steps: [{ step: 0, template: 'fake-1' }, { step: 1, template: 'fake-2' }],
    })
    const body = await res.json() as { blockers: Array<{ missing_templates?: string[] }> }
    expect(body.blockers[0].missing_templates).toEqual(['fake-1', 'fake-2'])
  })

  it('7: duplicate template refs are de-duplicated in the lookup', async () => {
    queueTemplates([])
    const res = await postCampaign({
      name: 'C1',
      steps: [{ step: 0, template: 'dup' }, { step: 1, template: 'dup' }],
    })
    expect(res.status).toBe(412)
    const body = await res.json() as { blockers: Array<{ missing_templates?: string[] }> }
    expect(body.blockers[0].missing_templates).toEqual(['dup'])
  })

  it('8: empty steps[] → no gate (not 412)', async () => {
    const res = await postCampaign({ name: 'C1', steps: [] })
    expect(res.status).not.toBe(412)
  })

  it('9: missing steps field → no gate (not 412)', async () => {
    const res = await postCampaign({ name: 'C1' })
    expect(res.status).not.toBe(412)
  })

  it('10: 400 when name missing (validation precedes the gate)', async () => {
    const res = await postCampaign({ steps: [{ step: 0, template: 'made-up' }] })
    expect(res.status).toBe(400)
  })

  it('11: 412 hint references templates', async () => {
    queueTemplates([])
    const res = await postCampaign({ name: 'C1', steps: [{ step: 0, template: 'made-up' }] })
    const body = await res.json() as { hint: string }
    expect(body.hint).toMatch(/šablon/i)
  })
})
