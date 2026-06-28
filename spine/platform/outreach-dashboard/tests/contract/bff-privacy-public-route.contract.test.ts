// Contract: GET /privacy is public, returns rendered docs/legal/privacy-notice.md as HTML.
// CRITICAL: this route MUST stay reachable without auth — recipients of B2B outreach
// must be able to read the privacy policy. If this route ever returns 401/403, every
// campaign email footer is GDPR-violating.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

vi.mock('pg', () => {
  class Pool {
    async query() { return { rows: [] } }
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

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  delete process.env.OUTREACH_API_KEY
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
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('GET /privacy — public privacy notice', () => {
  it('returns 200 OK', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    expect(r.status).toBe(200)
  })

  it('returns text/html content type', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    expect(r.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('renders <h1> with privacy notice title', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    const html = await r.text()
    expect(html).toMatch(/<h1>.*Zásady zpracování osobních údajů.*<\/h1>/)
  })

  it('contains controller identity (Garaaage s.r.o.)', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    const html = await r.text()
    expect(html).toContain('Garaaage s.r.o.')
  })

  it('contains IČO 23219700', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    const html = await r.text()
    expect(html).toContain('23219700')
  })

  it('contains GDPR contact email privacy@garaaage.cz', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    const html = await r.text()
    expect(html).toContain('privacy@garaaage.cz')
  })

  it('returns Cache-Control public', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    expect(r.headers.get('cache-control')).toMatch(/public/)
  })

  it('does NOT require API key (no X-API-Key header sent)', async () => {
    const r = await fetch(`${baseUrl}/privacy`, { headers: {} })
    expect(r.status).toBe(200)
    expect(r.status).not.toBe(401)
    expect(r.status).not.toBe(403)
  })

  it('includes <ul> for processed data categories list', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    const html = await r.text()
    expect(html).toMatch(/<ul>[\s\S]*<\/ul>/)
  })

  it('returns valid HTML (has lang attribute + viewport meta)', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    const html = await r.text()
    expect(html).toContain('<html lang="cs">')
    expect(html).toContain('viewport')
  })

  it('has charset declared as utf-8', async () => {
    const r = await fetch(`${baseUrl}/privacy`)
    expect(r.headers.get('content-type')).toMatch(/charset=utf-8/i)
  })
})
