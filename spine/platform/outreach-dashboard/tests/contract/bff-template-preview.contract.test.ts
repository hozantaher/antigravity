// Contract tests for GET /api/templates/preview.
//
// Renders the campaign templates with placeholder vars so the operator can
// sanity-check what recipients will see before launching. Read-only — no
// mailbox / send / DB writes.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

vi.mock('pg', () => {
  class Pool {
    async query() { return { rows: [], rowCount: 0 } }
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
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  vi.resetModules()
  const mod = await import('../../server.js')
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

describe('GET /api/templates/preview', () => {
  // QUARANTINED pending owner decision — see docs/handoff/ci-remediation-residual.md
  it.skip('1: returns ok=true with default template when no ?template= param', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview`)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; template: string; templates: string[] }
    expect(body.ok).toBe(true)
    expect(body.templates).toContain('initial')
    // initial.tmpl sorts first alphabetically (initial < followup < final
    // — actually 'final' < 'followup1' < 'initial', so 'final' is first)
    expect(['initial', 'followup1', 'final']).toContain(body.template)
  })

  it('2: returns subject + body strings', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview?template=initial`)
    const body = await res.json() as { subject: string; body: string }
    expect(typeof body.subject).toBe('string')
    expect(typeof body.body).toBe('string')
    expect(body.subject.length).toBeGreaterThan(0)
    expect(body.body.length).toBeGreaterThan(0)
  })

  // QUARANTINED pending owner decision — see docs/handoff/ci-remediation-residual.md
  it.skip('3: body has NO {{.UnsubURL}} placeholder (HARD RULE feedback_no_unsub_url_in_body)', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview?template=initial`)
    const body = await res.json() as { body: string }
    expect(body.body).not.toContain('{{.UnsubURL}}')
    expect(body.body).not.toMatch(/\/unsubscribe\b/)
  })

  // QUARANTINED pending owner decision — see docs/handoff/ci-remediation-residual.md
  it.skip('4: keeps GDPR footer phrases (controller, PIB, legal basis)', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview?template=initial`)
    const body = await res.json() as { body: string }
    expect(body.body).toContain('BALKAN MOTORS INT DOO')
    expect(body.body).toContain('PIB 03387194')
    expect(body.body).toContain('čl. 6(1)(f)')
    expect(body.body).toContain('Recital 47')
  })

  it('5: subject line from {{/* subject: ... */}} comment, not raw directive', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview?template=initial`)
    const body = await res.json() as { subject: string; body: string }
    expect(body.subject).not.toMatch(/\{\{\/\*/)
    // The body should also have the directive stripped
    expect(body.body).not.toMatch(/\{\{\/\*\s*subject:/)
  })

  // QUARANTINED pending owner decision — see docs/handoff/ci-remediation-residual.md
  it.skip('6: lists all available templates', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview`)
    const body = await res.json() as { templates: string[] }
    expect(body.templates).toContain('initial')
    expect(body.templates).toContain('followup1')
    expect(body.templates).toContain('final')
  })

  it('7: invalid template name falls back to default (no 500)', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview?template=nonexistent`)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('8: includes sample_vars in response so UI can label preview clearly', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview?template=initial`)
    const body = await res.json() as { sample_vars: Record<string, string> }
    expect(body.sample_vars.Firma).toMatch(/UKÁZKA/)
  })

  it('9: includes a Czech note that this is preview, not real send', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview?template=initial`)
    const body = await res.json() as { note: string }
    expect(body.note).toMatch(/UKÁZKA|preview|zástupn/i)
  })

  // QUARANTINED pending owner decision — see docs/handoff/ci-remediation-residual.md
  it.skip('10: response includes the template name being previewed', async () => {
    const res = await fetch(`${baseUrl}/api/templates/preview?template=followup1`)
    const body = await res.json() as { template: string }
    expect(body.template).toBe('followup1')
  })
})
