// ═══════════════════════════════════════════════════════════════════════════
//  S-H3 — BFF security headers (CSP + cross-origin isolation)
//
//  Defense-in-depth hardening for /unsubscribe (HTML), /api/* (JSON),
//  and /sentry-tunnel (envelope) endpoints. CSP blocks all scripts and
//  inline resources except styles. Cross-Origin-Opener-Policy mitigates
//  Spectre-class window-leak attacks.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'UNSUBSCRIBE_SECRET']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.UNSUBSCRIBE_SECRET = 'test-unsub-secret'

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

describe('Security headers', () => {
  it('1: X-Content-Type-Options: nosniff set', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('2: X-Frame-Options: DENY set', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('3: Referrer-Policy: strict-origin-when-cross-origin set', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  it('4: Permissions-Policy restricts camera, microphone, geolocation', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    const pp = res.headers.get('Permissions-Policy')
    expect(pp).toContain('camera=()')
    expect(pp).toContain('microphone=()')
    expect(pp).toContain('geolocation=()')
  })

  it('5: Strict-Transport-Security set', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    const sts = res.headers.get('Strict-Transport-Security')
    expect(sts).toBe('max-age=31536000; includeSubDomains')
  })

  it('6: Content-Security-Policy set with strict defaults', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    const csp = res.headers.get('Content-Security-Policy')
    expect(csp).toBeDefined()
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("style-src 'unsafe-inline'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'self'")
  })

  it('7: CSP allows only inline styles, no scripts', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    const csp = res.headers.get('Content-Security-Policy') || ''
    expect(csp).not.toContain("script-src")
    expect(csp).toContain("default-src 'none'")
  })

  it('8: Cross-Origin-Opener-Policy: same-origin', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
  })

  it('9: Cross-Origin-Resource-Policy: same-origin', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
  })

  it('10: CSP applies to /api/* endpoints', async () => {
    const res = await fetch(`${baseUrl}/api/companies/facets`)
    const csp = res.headers.get('Content-Security-Policy')
    expect(csp).toBeDefined()
    expect(csp).toContain("default-src 'none'")
  })

  it('11: CSP applies to /unsubscribe', async () => {
    const res = await fetch(`${baseUrl}/unsubscribe?t=invalid`)
    const csp = res.headers.get('Content-Security-Policy')
    expect(csp).toBeDefined()
    expect(csp).toContain("style-src 'unsafe-inline'")
  })

  it('12: CSP applies to /sentry-tunnel', async () => {
    const res = await fetch(`${baseUrl}/sentry-tunnel`, { method: 'POST', body: '' })
    const csp = res.headers.get('Content-Security-Policy')
    expect(csp).toBeDefined()
  })

  it('13: COOP header on all responses', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
  })

  it('14: CORP header on all responses', async () => {
    const res = await fetch(`${baseUrl}/api/companies/stats`)
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
  })

  it('15: Headers on 4xx errors', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`)
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Content-Security-Policy')).toBeDefined()
  })
})
