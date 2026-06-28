// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/__schema-check  (Phase 1 / S2 of UI-D-E-F)
//
//  Endpoint proxies Go's /schema and diffs it against a frozen baseline file
//  on disk. Tests cover:
//
//    1.  hash match               → ok=true, no drift body
//    2.  added column             → ok=false, drift.modifiedTables non-empty
//    3.  removed table            → ok=false, drift.removedTables present
//    4.  type change (text→varchar) → ok=false, drift.typeChanges present
//    5.  Go unreachable (network) → 503 + error='go_unreachable'
//    6.  baseline file missing    → ok=true + warning='no_baseline'
//    7.  cache hit                → 2 calls within 60s, only 1 Go fetch
//    8.  cache miss (bypass)      → fresh Go fetch each call
//    9.  malformed Go response    → 500 + error='malformed_response'
//   10.  diffManifests symmetric  → property check on the helper
//   11.  empty manifest both sides → ok=true
//   12.  reordered keys           → ok=true (canonical compare)
//   13.  added table              → drift.addedTables present
//   14.  Go HTTP 500              → 503 (treated as unreachable)
//   15.  GO_SERVER_URL unset      → 503 + error='go_unreachable'
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── pg stub (unused by this endpoint but required by server.js boot) ────────
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
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

// ── fetch stub (intercept the Go /schema call) ──────────────────────────────
type FetchOutcome = { ok: boolean; status?: number; json: () => Promise<unknown> } | Error
const fetchQueue: FetchOutcome[] = []
const fetchCalls: string[] = []
let realFetch: typeof fetch

// We only intercept fetches to Go's /schema; everything else (including the
// supertest fetches from the test runner against the local Express server)
// must pass through to the real fetch.
function installFetchStub() {
  realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/schema') && (u.startsWith('http://go-stub.local') || u.startsWith('https://go-stub.local'))) {
      fetchCalls.push(u)
      const next = fetchQueue.shift()
      if (!next) return { ok: true, status: 200, json: async () => ({ manifest_hash: 'unset', tables: {} }) } as Response
      if (next instanceof Error) throw next
      return { ok: next.ok, status: next.status ?? (next.ok ? 200 : 500), json: next.json } as Response
    }
    return realFetch(url as RequestInfo, init)
  }) as typeof fetch
}

let baseUrl = ''
let server: import('http').Server
let tmpDir = ''
let baselinePath = ''
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY', 'SCHEMA_BASELINE_PATH', 'SCHEMA_CHECK_BYPASS_CACHE', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.OUTREACH_API_KEY = 'test-key'
  // Point baseline path at a temp file we control per-test.
  tmpDir = mkdtempSync(join(tmpdir(), 'bff-schema-check-'))
  baselinePath = join(tmpDir, 'schema-manifest.json')
  process.env.SCHEMA_BASELINE_PATH = baselinePath
  process.env.SCHEMA_CHECK_BYPASS_CACHE = '1'
  process.env.GO_SERVER_URL = 'http://go-stub.local'

  installFetchStub()

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
  globalThis.fetch = realFetch
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  fetchQueue.length = 0
  fetchCalls.length = 0
  // Default: bypass cache. Tests that exercise cache flip this off.
  process.env.SCHEMA_CHECK_BYPASS_CACHE = '1'
  // Default: Go reachable.
  process.env.GO_SERVER_URL = 'http://go-stub.local'
  // Default: baseline file removed (each test writes its own).
  try { unlinkSync(baselinePath) } catch { /* swallow */ }
})

function writeBaseline(obj: unknown) {
  writeFileSync(baselinePath, JSON.stringify(obj), 'utf8')
}

function queueGoResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  fetchQueue.push({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  })
}

function queueGoError(msg: string) {
  fetchQueue.push(new Error(msg))
}

async function get(path: string) {
  const r = await realFetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  Endpoint behaviour
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/__schema-check', () => {
  it('1. happy path: current hash == baseline hash → ok=true', async () => {
    const manifest = { manifest_hash: 'h-stable', tables: { contacts: { columns: [{ name: 'id', type: 'integer', nullable: false }] } } }
    writeBaseline(manifest)
    queueGoResponse(manifest)

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; current_hash: string; baseline_hash: string; last_check_at: string; drift?: unknown }
    expect(body.ok).toBe(true)
    expect(body.current_hash).toBe('h-stable')
    expect(body.baseline_hash).toBe('h-stable')
    expect(body.last_check_at).toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(body.drift).toBeUndefined()
  })

  it('2. drift: current adds new column → ok=false, drift.modifiedTables non-empty', async () => {
    const baseline = {
      manifest_hash: 'b-1',
      tables: { contacts: { columns: [{ name: 'id', type: 'integer', nullable: false }] } },
    }
    const current = {
      manifest_hash: 'c-2',
      tables: { contacts: { columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'email', type: 'text', nullable: true },
      ] } },
    }
    writeBaseline(baseline)
    queueGoResponse(current)

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; drift: { modifiedTables: Array<{ name: string; addedCols: string[] }> } }
    expect(body.ok).toBe(false)
    expect(body.drift.modifiedTables).toHaveLength(1)
    expect(body.drift.modifiedTables[0].name).toBe('contacts')
    expect(body.drift.modifiedTables[0].addedCols).toEqual(['email'])
  })

  it('3. drift: removed table → drift.removedTables present', async () => {
    const baseline = {
      manifest_hash: 'b-1',
      tables: {
        contacts: { columns: [{ name: 'id', type: 'integer', nullable: false }] },
        old_table: { columns: [{ name: 'x', type: 'text', nullable: true }] },
      },
    }
    const current = {
      manifest_hash: 'c-2',
      tables: { contacts: { columns: [{ name: 'id', type: 'integer', nullable: false }] } },
    }
    writeBaseline(baseline)
    queueGoResponse(current)

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; drift: { removedTables: string[] } }
    expect(body.ok).toBe(false)
    expect(body.drift.removedTables).toEqual(['old_table'])
  })

  it('4. drift: type changed (text → varchar) → drift detected', async () => {
    const baseline = {
      manifest_hash: 'b-1',
      tables: { contacts: { columns: [{ name: 'email', type: 'text', nullable: true }] } },
    }
    const current = {
      manifest_hash: 'c-2',
      tables: { contacts: { columns: [{ name: 'email', type: 'varchar', nullable: true }] } },
    }
    writeBaseline(baseline)
    queueGoResponse(current)

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; drift: { modifiedTables: Array<{ name: string; typeChanges: Array<{ name: string; baseline: string; current: string }> }> } }
    expect(body.ok).toBe(false)
    expect(body.drift.modifiedTables).toHaveLength(1)
    const tc = body.drift.modifiedTables[0].typeChanges
    expect(tc).toHaveLength(1)
    expect(tc[0].name).toBe('email')
    expect(tc[0].baseline).toContain('text')
    expect(tc[0].current).toContain('varchar')
  })

  it('5. Go unreachable (network error) → 503 + error="go_unreachable"', async () => {
    writeBaseline({ manifest_hash: 'b', tables: {} })
    queueGoError('ECONNREFUSED')

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(503)
    const body = res.body as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('go_unreachable')
  })

  it('6. baseline file missing → 200 + ok=true + warning="no_baseline"', async () => {
    // baseline already removed in beforeEach
    queueGoResponse({ manifest_hash: 'whatever', tables: {} })

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; warning: string; baseline_hash: null; current_hash: string }
    expect(body.ok).toBe(true)
    expect(body.warning).toBe('no_baseline')
    expect(body.baseline_hash).toBeNull()
    expect(body.current_hash).toBe('whatever')
  })

  it('7. cache hit: 2 calls within 60s → only 1 Go fetch', async () => {
    process.env.SCHEMA_CHECK_BYPASS_CACHE = '0'
    const manifest = { manifest_hash: 'cached', tables: {} }
    writeBaseline(manifest)
    queueGoResponse(manifest)
    queueGoResponse(manifest) // second one shouldn't be consumed

    const a = await get('/api/__schema-check')
    const b = await get('/api/__schema-check')

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(fetchCalls.length).toBe(1)
  })

  it('8. cache miss (bypass enabled) → fresh Go fetch on every call', async () => {
    process.env.SCHEMA_CHECK_BYPASS_CACHE = '1'
    const manifest = { manifest_hash: 'h', tables: {} }
    writeBaseline(manifest)
    queueGoResponse(manifest)
    queueGoResponse(manifest)

    await get('/api/__schema-check')
    await get('/api/__schema-check')

    expect(fetchCalls.length).toBe(2)
  })

  it('9. malformed Go response (missing manifest_hash) → 500 + error="malformed_response"', async () => {
    writeBaseline({ manifest_hash: 'b', tables: {} })
    queueGoResponse({ tables: {} }) // missing manifest_hash

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(500)
    const body = res.body as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('malformed_response')
  })

  it('11. empty manifest both sides → ok=true', async () => {
    const empty = { manifest_hash: 'e', tables: {} }
    writeBaseline(empty)
    queueGoResponse(empty)

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('12. identical manifests with reordered keys → ok=true (canonical compare)', async () => {
    // Different hash on purpose to force fall-through to structural diff;
    // canonicalization should still resolve to ok=true.
    const baseline = {
      manifest_hash: 'b-hash',
      tables: {
        zeta: { columns: [
          { name: 'b', type: 'text', nullable: true },
          { name: 'a', type: 'integer', nullable: false },
        ] },
        alpha: { columns: [{ name: 'id', type: 'integer', nullable: false }] },
      },
    }
    const current = {
      manifest_hash: 'c-hash',
      tables: {
        alpha: { columns: [{ name: 'id', type: 'integer', nullable: false }] },
        zeta: { columns: [
          { name: 'a', type: 'integer', nullable: false },
          { name: 'b', type: 'text', nullable: true },
        ] },
      },
    }
    writeBaseline(baseline)
    queueGoResponse(current)

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; drift: { addedTables: string[]; removedTables: string[]; modifiedTables: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.drift.addedTables).toEqual([])
    expect(body.drift.removedTables).toEqual([])
    expect(body.drift.modifiedTables).toEqual([])
  })

  it('13. drift: added table → drift.addedTables present', async () => {
    const baseline = {
      manifest_hash: 'b-1',
      tables: { contacts: { columns: [{ name: 'id', type: 'integer', nullable: false }] } },
    }
    const current = {
      manifest_hash: 'c-2',
      tables: {
        contacts: { columns: [{ name: 'id', type: 'integer', nullable: false }] },
        new_table: { columns: [{ name: 'id', type: 'integer', nullable: false }] },
      },
    }
    writeBaseline(baseline)
    queueGoResponse(current)

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; drift: { addedTables: string[] } }
    expect(body.ok).toBe(false)
    expect(body.drift.addedTables).toEqual(['new_table'])
  })

  it('14. Go HTTP 500 → 503 (treated as unreachable)', async () => {
    writeBaseline({ manifest_hash: 'b', tables: {} })
    queueGoResponse({}, { ok: false, status: 500 })

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(503)
    const body = res.body as { ok: boolean; error: string; http_status?: number }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('go_unreachable')
    expect(body.http_status).toBe(500)
  })

  it('15. GO_SERVER_URL unset → 503 + error="go_unreachable"', async () => {
    delete process.env.GO_SERVER_URL
    writeBaseline({ manifest_hash: 'b', tables: {} })

    const res = await get('/api/__schema-check')

    expect(res.status).toBe(503)
    const body = res.body as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('go_unreachable')
    expect(fetchCalls.length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Pure helper properties (test #10)
// ═══════════════════════════════════════════════════════════════════════

describe('diffManifests pure helper', () => {
  it('10. symmetric: addedTables(A,B) === removedTables(B,A) and vice versa', async () => {
    const { diffManifests } = await import('../../src/lib/schema-diff.js')

    const A = {
      manifest_hash: 'a',
      tables: {
        contacts: { columns: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'extra', type: 'text', nullable: true },
        ] },
        only_in_a: { columns: [{ name: 'x', type: 'text', nullable: true }] },
      },
    }
    const B = {
      manifest_hash: 'b',
      tables: {
        contacts: { columns: [
          { name: 'id', type: 'varchar', nullable: false },
        ] },
        only_in_b: { columns: [{ name: 'y', type: 'text', nullable: true }] },
      },
    }

    const ab = diffManifests(A, B)
    const ba = diffManifests(B, A)

    // Tables added in (A vs B) are tables removed in (B vs A).
    expect(ab.drift.addedTables).toEqual(ba.drift.removedTables)
    expect(ab.drift.removedTables).toEqual(ba.drift.addedTables)

    // For tables present in both, addedCols(A,B) === removedCols(B,A).
    const abMod = ab.drift.modifiedTables.find((t) => t.name === 'contacts')!
    const baMod = ba.drift.modifiedTables.find((t) => t.name === 'contacts')!
    expect(abMod.addedCols).toEqual(baMod.removedCols)
    expect(abMod.removedCols).toEqual(baMod.addedCols)

    // Type changes flip baseline ↔ current.
    const abId = abMod.typeChanges.find((c) => c.name === 'id')!
    const baId = baMod.typeChanges.find((c) => c.name === 'id')!
    expect(abId.baseline).toBe(baId.current)
    expect(abId.current).toBe(baId.baseline)
  })

  it('quickCheck: matching hashes → true', async () => {
    const { quickCheck } = await import('../../src/lib/schema-diff.js')
    expect(quickCheck({ manifest_hash: 'x', tables: {} }, { manifest_hash: 'x', tables: {} })).toBe(true)
  })

  it('quickCheck: missing hash on either side → false', async () => {
    const { quickCheck } = await import('../../src/lib/schema-diff.js')
    expect(quickCheck({ tables: {} } as unknown as { manifest_hash: string }, { manifest_hash: 'x', tables: {} })).toBe(false)
    expect(quickCheck({ manifest_hash: 'x', tables: {} }, null)).toBe(false)
  })

  it('diffManifests: empty inputs → ok=true with empty arrays', async () => {
    const { diffManifests } = await import('../../src/lib/schema-diff.js')
    const r = diffManifests({ manifest_hash: 'h', tables: {} }, { manifest_hash: 'h', tables: {} })
    expect(r.ok).toBe(true)
    expect(r.drift.addedTables).toEqual([])
    expect(r.drift.removedTables).toEqual([])
    expect(r.drift.modifiedTables).toEqual([])
    expect(r.drift.hashMatch).toBe(true)
  })

  it('diffManifests: nullable change on same type registers as a typeChange', async () => {
    const { diffManifests } = await import('../../src/lib/schema-diff.js')
    const baseline = { manifest_hash: 'b', tables: { t: { columns: [{ name: 'c', type: 'text', nullable: true }] } } }
    const current  = { manifest_hash: 'c', tables: { t: { columns: [{ name: 'c', type: 'text', nullable: false }] } } }
    const r = diffManifests(current, baseline)
    expect(r.ok).toBe(false)
    expect(r.drift.modifiedTables[0].typeChanges).toHaveLength(1)
    expect(r.drift.modifiedTables[0].typeChanges[0].baseline).toContain('NULL')
    expect(r.drift.modifiedTables[0].typeChanges[0].current).toContain('NOT NULL')
  })
})
