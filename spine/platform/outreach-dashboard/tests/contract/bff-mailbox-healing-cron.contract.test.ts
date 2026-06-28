// ═══════════════════════════════════════════════════════════════════════════
//  Unit tests — runMailboxHealingCron (S5: auto-unpause po proxy recovery)
//
//  Testuje logiku cronové funkce přímo. Mockuje pool.query a globalThis.fetch
//  aby testy byly fast a deterministické — žádné síťové volání.
//
//  Scénáře (≥10 dle zadání):
//  1.  Žádné pauzované schránky → 0 healed, žádné fetch volání
//  2.  1 schránka, full-check ok=true smtp.ok=true → UPDATE na active
//  3.  1 schránka, full-check ok=false → žádný UPDATE
//  4.  1 schránka, smtp.ok=false (i když ok=true) → žádný UPDATE
//  5.  2 schránky, 1 projde + 1 neprojde → healed=1, 1 UPDATE
//  6.  DB query selže → catch, žádný crash
//  7.  fetch selže (network error) → catch per-mailbox, ostatní pokračují
//  8.  Manuálně pauzovaná schránka (status_reason NULL) → přeskočena filtrem
//  9.  Schránka pauzovaná před méně než 10 min → přeskočena filtrem (cooldown)
//  10. MONKEY: náhodné check shapes → žádný crash
//  11. fetch vrátí !r.ok (např. 500) → žádný UPDATE pro tuto schránku
//  12. UPDATE DB selže → catch per-mailbox, ostatní pokračují
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ── pg stub ─────────────────────────────────────────────────────────────────
type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error

// We use a per-test queue to feed pool.query responses in order.
const queryQueue: QueryOutcome[] = []
const queryCalls: Array<{ sql: string; params?: unknown[] }> = []

// Save env so afterAll can restore — prevents cross-test-file env leak
// (docs/audits/2026-04-30-blind-spot-audit.md § A).
const savedEnv: Record<string, string | undefined> = {}

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      queryCalls.push({ sql, params })
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

// Stub out sidecar imports so the module loads without real deps.
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

// ── fetch stub ───────────────────────────────────────────────────────────────
// We replace globalThis.fetch so we can control what each per-mailbox check returns.
type FetchOutcome = { ok: boolean; json: () => Promise<unknown> } | Error
const fetchQueue: FetchOutcome[] = []
const fetchCalls: string[] = []

vi.stubGlobal('fetch', async (input: string | URL | Request) => {
  // Cross-scope: in TEST_SCOPE=all another file's msw-style middleware may
  // wrap our string URL in Request. Extract URL string from any of those
  // shapes so assertions stay stable regardless of upstream wrapping.
  let url: string
  if (typeof input === 'string') url = input
  else if (input instanceof URL) url = input.toString()
  else if (typeof Request !== 'undefined' && input instanceof Request) url = input.url
  else url = String(input)
  fetchCalls.push(url)
  if (!fetchQueue.length) return { ok: true, json: async () => ({ ok: true, checks: { smtp: { ok: true } } }) }
  const next = fetchQueue.shift()!
  if (next instanceof Error) throw next
  return next
})

// ── import server (import-only mode, no cron loop) ───────────────────────────
let runMailboxHealingCron: () => Promise<void>

// Lazy import so mocks are set up before server.js runs
async function loadCron() {
  if (runMailboxHealingCron) return
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'PORT', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.PORT = '18001'
  process.env.OUTREACH_API_KEY = 'test-key'
  const mod = await import('../../server.js')
  runMailboxHealingCron = (mod as { runMailboxHealingCron: () => Promise<void> }).runMailboxHealingCron
}

beforeEach(() => {
  queryQueue.length = 0
  fetchQueue.length = 0
  fetchCalls.length = 0
})

// Restore globalThis.fetch + clear mocks so sister test files don't see
// our stubbed fetch (per docs/audits/2026-04-30-blind-spot-audit.md cross-
// suite pollution). Without this, send-test relay-config tests get the
// healing-cron stub and assert wrong status.
afterAll(() => {
  vi.unstubAllGlobals()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// Helper: run the cron and return only the queryCalls made during this invocation
async function runCron() {
  const snapBefore = queryCalls.length
  await runMailboxHealingCron()
  return queryCalls.slice(snapBefore)
}

// ────────────────────────────────────────────────────────────────────────────

describe('runMailboxHealingCron', () => {
  it('0. module exports runMailboxHealingCron as a function', async () => {
    await loadCron()
    expect(typeof runMailboxHealingCron).toBe('function')
  })

  it('1. žádné pauzované schránky → 0 fetch volání, žádný UPDATE', async () => {
    await loadCron()
    queryQueue.push({ rows: [] })

    const calls = await runCron()

    expect(fetchCalls.length).toBe(0)
    // Alespoň jeden SELECT byl proveden
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0].sql).toMatch(/status.*=.*'paused'/i)
    // Žádný UPDATE nesmí být proveden
    expect(calls.filter(c => c.sql.includes('active')).length).toBe(0)
  })

  it('2. 1 schránka, full-check ok=true smtp.ok=true → UPDATE na active', async () => {
    await loadCron()
    queryQueue.push({ rows: [{ id: 42 }] }) // paused mailboxes
    fetchQueue.push({
      ok: true,
      json: async () => ({ ok: true, checks: { smtp: { ok: true } } }),
    })
    queryQueue.push({ rows: [], rowCount: 1 }) // UPDATE result

    const calls = await runCron()

    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]).toContain('/api/mailboxes/42/full-check?force=1')
    const updateCall = calls.find(c => c.sql.includes('active'))
    expect(updateCall).toBeDefined()
    expect(updateCall?.params?.[0]).toBe(42)
  })

  it('3. 1 schránka, full-check ok=false → žádný UPDATE', async () => {
    await loadCron()
    queryQueue.push({ rows: [{ id: 7 }] })
    fetchQueue.push({
      ok: true,
      json: async () => ({ ok: false, checks: { smtp: { ok: true } } }),
    })

    const calls = await runCron()

    expect(calls.filter(c => c.sql.includes('active')).length).toBe(0)
  })

  it('4. smtp.ok=false (i když overall ok=true) → žádný UPDATE', async () => {
    await loadCron()
    queryQueue.push({ rows: [{ id: 99 }] })
    fetchQueue.push({
      ok: true,
      json: async () => ({ ok: true, checks: { smtp: { ok: false } } }),
    })

    const calls = await runCron()

    expect(calls.filter(c => c.sql.includes('active')).length).toBe(0)
  })

  it('5. 2 schránky, 1 projde + 1 neprojde → healed=1, 1 UPDATE', async () => {
    await loadCron()
    queryQueue.push({ rows: [{ id: 10 }, { id: 20 }] })
    // schránka 10: projde
    fetchQueue.push({
      ok: true,
      json: async () => ({ ok: true, checks: { smtp: { ok: true } } }),
    })
    queryQueue.push({ rows: [], rowCount: 1 }) // UPDATE for id=10
    // schránka 20: neprojde (smtp fail)
    fetchQueue.push({
      ok: true,
      json: async () => ({ ok: false, checks: { smtp: { ok: false } } }),
    })

    const calls = await runCron()

    expect(fetchCalls.length).toBe(2)
    const updateCalls = calls.filter(c => c.sql.includes('active'))
    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].params?.[0]).toBe(10)
  })

  it('6. DB query selže → catch, žádný crash', async () => {
    await loadCron()
    queryQueue.push(new Error('DB connection lost'))

    await expect(runMailboxHealingCron()).resolves.toBeUndefined()
    expect(fetchCalls.length).toBe(0)
  })

  it('7. fetch selže pro jednu schránku → ostatní pokračují dál', async () => {
    await loadCron()
    queryQueue.push({ rows: [{ id: 1 }, { id: 2 }] })
    // schránka 1: network error
    fetchQueue.push(new Error('ECONNREFUSED'))
    // schránka 2: projde
    fetchQueue.push({
      ok: true,
      json: async () => ({ ok: true, checks: { smtp: { ok: true } } }),
    })
    queryQueue.push({ rows: [], rowCount: 1 }) // UPDATE for id=2

    const calls = await runCron()

    expect(fetchCalls.length).toBe(2)
    const updateCalls = calls.filter(c => c.sql.includes('active'))
    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].params?.[0]).toBe(2)
  })

  it('8. manuálně pauzovaná schránka (bez auto: prefix) → přeskočena SQL filtrem', async () => {
    await loadCron()
    // Filtr "status_reason LIKE 'auto:%'" je v SQL — DB vrátí prázdné pole,
    // protože manuálně pauzované schránky do filtru nespadají.
    queryQueue.push({ rows: [] })

    const calls = await runCron()

    // Ověříme, že SQL obsahuje LIKE 'auto:%' podmínku
    expect(calls[0].sql).toMatch(/status_reason\s+LIKE\s+'auto:%'/i)
    expect(fetchCalls.length).toBe(0)
  })

  it('9. schránka pauzovaná před méně než 10 min → přeskočena SQL filtrem (cooldown)', async () => {
    await loadCron()
    // Filtr "updated_at < now() - interval '10 minutes'" je v SQL — DB vrátí
    // prázdné pole pro čerstvě pauzované schránky.
    queryQueue.push({ rows: [] })

    const calls = await runCron()

    expect(calls[0].sql).toMatch(/interval\s+'10 minutes'/i)
    expect(fetchCalls.length).toBe(0)
  })

  it('10. MONKEY: náhodné check shapes → žádný crash', async () => {
    await loadCron()
    const monkeyShapes = [
      null,
      undefined,
      {},
      { ok: true },
      { ok: false, checks: null },
      { ok: true, checks: {} },
      { ok: true, checks: { smtp: null } },
      { ok: 'yes', checks: { smtp: { ok: 'true' } } },
      { ok: true, checks: { smtp: { ok: 1 } } },
      42,
      'string-response',
    ]

    for (const shape of monkeyShapes) {
      queryQueue.push({ rows: [{ id: 55 }] })
      fetchQueue.push({
        ok: true,
        json: async () => shape,
      })

      await expect(runMailboxHealingCron()).resolves.toBeUndefined()
    }
  })

  it('11. fetch vrátí !r.ok (500 od serveru) → žádný UPDATE', async () => {
    await loadCron()
    queryQueue.push({ rows: [{ id: 33 }] })
    fetchQueue.push({
      ok: false,
      json: async () => ({ ok: true, checks: { smtp: { ok: true } } }),
    })

    const calls = await runCron()

    expect(calls.filter(c => c.sql.includes('active')).length).toBe(0)
  })

  it('12. UPDATE DB selže pro jednu schránku → catch per-mailbox, ostatní pokračují', async () => {
    await loadCron()
    queryQueue.push({ rows: [{ id: 11 }, { id: 22 }] })
    // schránka 11: full-check ok, ale UPDATE selže
    fetchQueue.push({
      ok: true,
      json: async () => ({ ok: true, checks: { smtp: { ok: true } } }),
    })
    queryQueue.push(new Error('UPDATE failed — deadlock')) // UPDATE for id=11 throws
    // schránka 22: full-check ok, UPDATE ok
    fetchQueue.push({
      ok: true,
      json: async () => ({ ok: true, checks: { smtp: { ok: true } } }),
    })
    queryQueue.push({ rows: [], rowCount: 1 }) // UPDATE for id=22 succeeds

    const calls = await runCron()

    expect(fetchCalls.length).toBe(2)
    // Both UPDATEs were attempted
    const updateCalls = calls.filter(c => c.sql.includes('active'))
    expect(updateCalls.length).toBe(2)
  })
})
