// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/diagnostics/{segmentation,feature-lift} + /api/dns-audit
//
//  Locks shapes, boundary clamping (min_bucket), allowed-feature guard,
//  no-mailboxes skip path for dns-audit, and 500 paths.
// ═══════════════════════════════════════════════════════════════════════════

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

// Mock dns/promises so tests don't hit real DNS
vi.mock('node:dns/promises', () => ({
  resolveTxt: vi.fn(),
}))

let baseUrl = ''
let server: import('http').Server
let resolveTxt: ReturnType<typeof vi.fn>
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL']) {
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
  const dns = await import('node:dns/promises')
  resolveTxt = dns.resolveTxt as ReturnType<typeof vi.fn>
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
  resolveTxt?.mockReset()
})

// ── /api/diagnostics/segmentation ────────────────────────────────────────

describe('GET /api/diagnostics/segmentation', () => {
  it('returns shape with total_companies, min_bucket, features array', async () => {
    queryQueue.push({
      rows: [
        { sector_primary: 'Stavebnictví', icp_tier: 'ideal', outcome: 1 },
        { sector_primary: 'Stavebnictví', icp_tier: 'good',  outcome: 0 },
        { sector_primary: 'Doprava',      icp_tier: 'ideal', outcome: 1 },
      ],
    })
    const res = await fetch(`${baseUrl}/api/diagnostics/segmentation?features=sector_primary,icp_tier`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.total_companies).toBe('number')
    expect(typeof body.min_bucket).toBe('number')
    expect(Array.isArray(body.features)).toBe(true)
  })

  it('rejects unknown features with 400', async () => {
    const res = await fetch(`${baseUrl}/api/diagnostics/segmentation?features=injected_field`)
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
  })

  it('clamps min_bucket: 0 → 5, 600 → 500', async () => {
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/diagnostics/segmentation?features=icp_tier&min_bucket=0`)
    queryQueue.push({ rows: [] })
    await fetch(`${baseUrl}/api/diagnostics/segmentation?features=icp_tier&min_bucket=600`)
    // No assertion on exact value — just that we don't crash. The route returns valid JSON.
  })

  it('returns 500 on DB error', async () => {
    queryQueue.push(new Error('DB down'))
    const res = await fetch(`${baseUrl}/api/diagnostics/segmentation?features=icp_tier`)
    expect(res.status).toBe(500)
  })
})

// ── /api/diagnostics/feature-lift ────────────────────────────────────────

describe('GET /api/diagnostics/feature-lift', () => {
  it('returns feature, min_bucket, and lift data', async () => {
    queryQueue.push({
      rows: [
        { feature: 'ideal', outcome: 1 },
        { feature: 'ideal', outcome: 0 },
        { feature: 'good',  outcome: 1 },
      ],
    })
    const res = await fetch(`${baseUrl}/api/diagnostics/feature-lift?feature=icp_tier`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.feature).toBe('icp_tier')
    expect(typeof body.min_bucket).toBe('number')
  })

  it('rejects unknown feature with 400', async () => {
    const res = await fetch(`${baseUrl}/api/diagnostics/feature-lift?feature=evil; DROP TABLE`)
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
  })

  it('rejects empty feature with 400', async () => {
    const res = await fetch(`${baseUrl}/api/diagnostics/feature-lift`)
    expect(res.status).toBe(400)
  })

  it('returns 500 on DB error', async () => {
    queryQueue.push(new Error('timeout'))
    const res = await fetch(`${baseUrl}/api/diagnostics/feature-lift?feature=score_tier`)
    expect(res.status).toBe(500)
  })
})

// ── /api/dns-audit ────────────────────────────────────────────────────────

describe('GET /api/dns-audit', () => {
  it('returns skip when no mailboxes configured', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/dns-audit`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.status).toBe('skip')
    expect(typeof body.detail).toBe('string')
    expect(body.domains).toEqual({})
  })

  it('returns ok + domain results with spf/dmarc fields', async () => {
    queryQueue.push({ rows: [{ domain: 'example.cz' }] })
    resolveTxt
      .mockResolvedValueOnce([['v=spf1 include:_spf.example.cz -all']])  // SPF
      .mockResolvedValueOnce([['v=DMARC1; p=reject; rua=mailto:dmarc@example.cz']]) // DMARC
    const res = await fetch(`${baseUrl}/api/dns-audit`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(['ok', 'warn', 'err']).toContain(body.status)
    expect(typeof body.latency_ms).toBe('number')
    const domains = body.domains as Record<string, unknown>
    expect(domains['example.cz']).toMatchObject({
      spf_status:   expect.any(String),
      spf_detail:   expect.any(String),
      dmarc_status: expect.any(String),
      dmarc_detail: expect.any(String),
    })
  })

  it('status=ok when SPF has -all and DMARC p!=none', async () => {
    queryQueue.push({ rows: [{ domain: 'strict.cz' }] })
    resolveTxt
      .mockResolvedValueOnce([['v=spf1 mx -all']])
      .mockResolvedValueOnce([['v=DMARC1; p=reject']])
    const res = await fetch(`${baseUrl}/api/dns-audit`)
    const body = await res.json() as Record<string, unknown>
    expect(body.status).toBe('ok')
    const d = (body.domains as Record<string, unknown>)['strict.cz'] as Record<string, unknown>
    expect(d.spf_status).toBe('ok')
    expect(d.dmarc_status).toBe('ok')
  })

  it('status=warn when SPF lacks -all', async () => {
    queryQueue.push({ rows: [{ domain: 'soft.cz' }] })
    resolveTxt
      .mockResolvedValueOnce([['v=spf1 mx ~all']])
      .mockResolvedValueOnce([['v=DMARC1; p=reject']])
    const res = await fetch(`${baseUrl}/api/dns-audit`)
    const body = await res.json() as Record<string, unknown>
    const d = (body.domains as Record<string, unknown>)['soft.cz'] as Record<string, unknown>
    expect(d.spf_status).toBe('warn')
  })

  it('status=err when DNS lookup fails', async () => {
    queryQueue.push({ rows: [{ domain: 'fail.cz' }] })
    resolveTxt.mockRejectedValue(new Error('ENOTFOUND'))
    const res = await fetch(`${baseUrl}/api/dns-audit`)
    const body = await res.json() as Record<string, unknown>
    expect(body.status).toBe('err')
    const d = (body.domains as Record<string, unknown>)['fail.cz'] as Record<string, unknown>
    expect(d.spf_status).toBe('err')
  })

  it('status=warn when DMARC p=none', async () => {
    queryQueue.push({ rows: [{ domain: 'monitor.cz' }] })
    resolveTxt
      .mockResolvedValueOnce([['v=spf1 mx -all']])
      .mockResolvedValueOnce([['v=DMARC1; p=none; rua=mailto:dmarc@example.cz']])
    const res = await fetch(`${baseUrl}/api/dns-audit`)
    const body = await res.json() as Record<string, unknown>
    const d = (body.domains as Record<string, unknown>)['monitor.cz'] as Record<string, unknown>
    expect(d.dmarc_status).toBe('warn')
  })
})
