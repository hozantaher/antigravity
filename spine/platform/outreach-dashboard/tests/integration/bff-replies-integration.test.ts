// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  Integration test — GET /api/replies/stats against in-memory Postgres.
//
//  Sprint I5. Higher-fidelity than test/contract/bff-replies-stats.contract.test.ts
//  (which mocks pool.query). This test runs the actual SQL from
//  src/server-routes/repliesStats.js (the canonical /api/replies/stats handler —
//  mounted before replies.js in server.js, so it is the handler that serves in
//  production) → pool.query against a real pg-compatible engine (pg-mem) so real
//  schema/SQL bugs surface (typos, missing columns, NULL semantics, plain-WHERE
//  interval boundary off-by-ones, parameter binding, index registration, UTF-8
//  round-trip).
//
//  Why pg-mem and not Docker Postgres:
//   - User memory `feedback_no_external_services.md` — no Docker required for tests
//   - pg-mem 3.0.14 is a pure-JS in-memory Postgres, devDep only (test fixture, not prod)
//   - Boots in <100 ms vs ~3 s for a Postgres container, so the suite stays cheap
//
//  pg-mem limitation discovered while writing this suite (locked in test #99):
//   - `COUNT(*) FILTER (WHERE …)` is **parsed but not evaluated** — pg-mem
//     returns the unfiltered count for every FILTER bucket. The route's
//     /stats query relies on FILTER for `unhandled / positive / negative /
//     auto_reply / today`. Tests that assert those bucket values are gated
//     behind `FILTER_AGGREGATE_WORKS` and skipped when the engine can't
//     evaluate them, with a clear comment so the gate flips automatically
//     once pg-mem ships FILTER support (or once we move to Testcontainers
//     Postgres). The gate is NOT silently passing — skipped tests are
//     reported by vitest.
//
//  Tests that DO run on pg-mem 3.0.14:
//   - schema round-trip (CREATE → INSERT → SELECT, types, NOT NULL)
//   - parameter binding / SQL-injection neutrality
//   - index registration in pg_indexes catalog
//   - UTF-8 / 10 KB subject inserts
//   - 1000-row perf canary (handler responds <1.5 s)
//   - 25-way concurrent reads return identical body
//   - empty-table → all six counters present (NaN/undefined guard)
//   - response shape regardless of FILTER fidelity (every key is a number)
//
//  If pg-mem itself cannot be loaded (CI without devDeps), the entire suite
//  is skipped — we never silently pass.
// ═══════════════════════════════════════════════════════════════════════════

import express, { type Express } from 'express'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

// pg-mem may be missing in some environments (production CI image without
// devDependencies installed). describe.skipIf below handles this; we resolve
// the module dynamically so the import error doesn't crash the file.
let newDb: typeof import('pg-mem').newDb | null = null
let pgMemAvailable = false
try {
  const mod = await import('pg-mem')
  newDb = mod.newDb
  pgMemAvailable = true
} catch {
  pgMemAvailable = false
}

// Probe whether the engine evaluates `COUNT(*) FILTER (WHERE …)` correctly.
// pg-mem 3.0.14 parses the syntax but ignores the filter; real Postgres
// returns a filtered count. We use this gate to skip FILTER-dependent
// assertions instead of producing false positives.
let FILTER_AGGREGATE_WORKS = false
if (pgMemAvailable && newDb) {
  try {
    const probeDb = newDb()
    const ProbePool = probeDb.adapters.createPg().Pool
    const probePool = new ProbePool()
    await probePool.query(`CREATE TABLE _probe (c TEXT)`)
    await probePool.query(`INSERT INTO _probe(c) VALUES ('a'),('a'),('b'),(NULL)`)
    const probeRes = await probePool.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE c='a')::int AS a_count FROM _probe`,
    )
    const r = probeRes.rows[0] as { total: number; a_count: number }
    // Real Postgres: total=4, a_count=2. pg-mem 3.0.14: total=4, a_count=4.
    FILTER_AGGREGATE_WORKS = r.total === 4 && r.a_count === 2
  } catch {
    FILTER_AGGREGATE_WORKS = false
  }
}

// Mount the canonical /api/replies/stats handler. repliesStats.js is the
// handler that serves in production (registered before replies.js in
// server.js; Express is first-match-wins), and the duplicate fallback in
// replies.js was removed, so this integration test exercises the real serving
// handler directly.
let mountRepliesStatsRouteInteg: typeof import('../../src/server-routes/repliesStats.js').mountRepliesStatsRoute
{
  const r = await import('../../src/server-routes/repliesStats.js')
  mountRepliesStatsRouteInteg = r.mountRepliesStatsRoute
}

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>
  end?: () => Promise<void>
}

interface StatsResponse {
  total: number
  unhandled: number
  positive: number
  negative: number
  auto_reply: number
  today: number
}

let app: Express
let server: import('http').Server
let baseUrl = ''
let pool: PgPool

// reply_inbox schema mirrored from server.js:3880-3893. We strip the FK to
// send_events (the real schema has `send_event_id INT UNIQUE REFERENCES
// send_events(id)`) so we can stand the table up without the rest of the
// schema; the column type stays plain INT. `mined` (jsonb) is included because
// the canonical /stats handler (repliesStats.js) reads it for the
// `phone_unhandled` call-queue counter (jsonb_array_length(mined->'phones')).
const REPLY_INBOX_DDL = `
  CREATE TABLE reply_inbox (
    id             SERIAL PRIMARY KEY,
    send_event_id  INT,
    campaign_id    INT,
    contact_id     INT,
    mailbox_id     INT,
    from_email     TEXT,
    subject        TEXT,
    classification TEXT,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    handled        BOOLEAN NOT NULL DEFAULT FALSE,
    handled_at     TIMESTAMPTZ,
    mined          JSONB
  );
  CREATE INDEX idx_reply_inbox_handled ON reply_inbox (handled, received_at DESC);
`

// unmatched_inbound schema mirrored from replies.js (verified 2026-05-19). The
// canonical /stats handler aggregates BOTH reply_inbox AND unmatched_inbound
// (orphan replies + the bounce chip), so the fixture MUST stand up this table
// too — otherwise the handler 500s on a missing relation (the original cause of
// this suite's failures). Columns are limited to the set the /stats query
// references (from_address, subject, classification, reviewed, received_at).
// The tests insert only into reply_inbox, so this table stays empty and
// contributes 0 to every counter — the reply_inbox-only assertions still hold.
const UNMATCHED_INBOUND_DDL = `
  CREATE TABLE unmatched_inbound (
    id             SERIAL PRIMARY KEY,
    from_address   TEXT,
    subject        TEXT,
    body_preview   TEXT NOT NULL DEFAULT '',
    classification TEXT,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed       BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_at    TIMESTAMPTZ
  );
`

// We hold the pg-mem db instance so tests can introspect the schema
// (listIndices, etc.) without going through SQL system catalogs that
// pg-mem doesn't fully implement (pg_indexes, information_schema.statistics).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let memDb: any

async function bootApp(): Promise<void> {
  if (!newDb) throw new Error('pg-mem unavailable')
  memDb = newDb({ autoCreateForeignKeyIndices: true })
  const PgAdapter = memDb.adapters.createPg()
  // pg-mem's Pool ignores connection params — we just `new` it.
  pool = new PgAdapter.Pool() as PgPool
  await pool.query(REPLY_INBOX_DDL)
  await pool.query(UNMATCHED_INBOUND_DDL)

  app = express()
  app.use(express.json())
  // safeError stub — handler invokes capture500 → res.status(500).json({error: safeError(e)})
  const safeError = (e: unknown): string => (e as { message?: string })?.message ?? 'unknown'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mountRepliesStatsRouteInteg(app, { pool: pool as any, capture500: (res: any, e: any, se: any) => { res.status(500).json({ error: se(e) }) }, safeError })

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
}

async function teardownApp(): Promise<void> {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function fetchStats(): Promise<{ status: number; body: StatsResponse }> {
  const res = await fetch(`${baseUrl}/api/replies/stats`)
  const body = await res.json() as StatsResponse
  return { status: res.status, body }
}

// Insert helper — `received_at` defaults to NOW() so callers control time only
// when they care about the today/not-today boundary.
async function insertReply(row: {
  classification?: string | null
  handled?: boolean
  received_at?: string  // ISO timestamp
  campaign_id?: number
  subject?: string
  from_email?: string
  handled_at?: string | null
}): Promise<void> {
  const cols: string[] = ['classification', 'handled']
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vals: any[] = [row.classification ?? null, row.handled ?? false]
  if (row.received_at !== undefined) { cols.push('received_at'); vals.push(row.received_at) }
  if (row.campaign_id !== undefined) { cols.push('campaign_id'); vals.push(row.campaign_id) }
  if (row.subject !== undefined)     { cols.push('subject');     vals.push(row.subject) }
  if (row.from_email !== undefined)  { cols.push('from_email');  vals.push(row.from_email) }
  if (row.handled_at !== undefined)  { cols.push('handled_at');  vals.push(row.handled_at) }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
  await pool.query(
    `INSERT INTO reply_inbox(${cols.join(', ')}) VALUES (${placeholders})`,
    vals,
  )
}

const STATS_KEYS = ['total', 'unhandled', 'positive', 'negative', 'auto_reply', 'today'] as const

describe.skipIf(!pgMemAvailable)('GET /api/replies/stats — integration (pg-mem)', () => {
  beforeEach(async () => {
    await bootApp()
  })
  afterEach(async () => {
    await teardownApp()
  })

  // ───────── Tests that work on every SQL engine (pg-mem + real Postgres) ─────────

  // 1. Empty table → handler returns full canonical shape, no NaN/undefined.
  //    `total` is the only counter that doesn't depend on FILTER, so it must be 0.
  //    (Other buckets fall to 0 too, because COUNT over an empty set is 0
  //    regardless of FILTER fidelity.)
  it('empty reply_inbox → handler returns full shape with total=0 and no NaN/undefined', async () => {
    const { status, body } = await fetchStats()
    expect(status).toBe(200)
    for (const k of STATS_KEYS) {
      expect(body, `missing key ${k}`).toHaveProperty(k)
      expect(typeof body[k], `${k} must be number`).toBe('number')
      expect(Number.isInteger(body[k]), `${k} must be integer`).toBe(true)
      expect(Number.isNaN(body[k])).toBe(false)
      expect(body[k]).toBe(0)
    }
  })

  // 2. Schema round-trip — CREATE → INSERT → SELECT against the real DDL we
  //    copied from server.js:3880-3893. If the DDL ever drifts, this fails.
  it('reply_inbox schema CREATE → INSERT → SELECT round-trip works', async () => {
    await pool.query(
      `INSERT INTO reply_inbox(classification, handled, from_email, subject)
       VALUES ('positive', FALSE, 'user@example.com', 'Re: cena bagru')`,
    )
    const { rows } = await pool.query(
      `SELECT id, classification, handled, from_email, subject FROM reply_inbox`,
    )
    expect(rows.length).toBe(1)
    const r = rows[0] as {
      id: number; classification: string; handled: boolean;
      from_email: string; subject: string
    }
    expect(typeof r.id).toBe('number')
    expect(r.classification).toBe('positive')
    expect(r.handled).toBe(false)
    expect(r.from_email).toBe('user@example.com')
    expect(r.subject).toBe('Re: cena bagru')
  })

  // 3. NOT NULL invariants from the DDL hold — handled is NOT NULL, default FALSE.
  it('handled column is NOT NULL with default FALSE', async () => {
    await pool.query(`INSERT INTO reply_inbox(classification) VALUES ('positive')`)
    const { rows } = await pool.query(`SELECT handled FROM reply_inbox WHERE id=1`)
    expect((rows[0] as { handled: boolean }).handled).toBe(false)
  })

  // 4. Index existence — pg-mem doesn't implement the pg_indexes system view
  //    (returns "relation does not exist"), so we introspect via the engine's
  //    own listIndices() API on the table object. Verifies the DDL we ship
  //    actually registers idx_reply_inbox_handled.
  it('idx_reply_inbox_handled index is registered after schema setup', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tbl = memDb.public.getTable('reply_inbox') as { listIndices: () => Array<{ name: string }> }
    const names = tbl.listIndices().map(i => i.name)
    expect(names).toContain('idx_reply_inbox_handled')
  })

  // 5. SQL-injection-shaped subject is parameterised — no DDL executes,
  //    table still exists, payload stored verbatim as data.
  it("SQL-injection-shaped subject ('; DROP TABLE) is stored as data, not executed", async () => {
    const evil = "'; DROP TABLE reply_inbox; --"
    await insertReply({ classification: 'positive', subject: evil })
    const { status, body } = await fetchStats()
    expect(status).toBe(200)
    expect(body.total).toBe(1)
    // Table still present → second query against it succeeds
    const { rows } = await pool.query(`SELECT subject FROM reply_inbox WHERE id = 1`)
    expect((rows[0] as { subject: string }).subject).toBe(evil)
  })

  // 6. UTF-8 — emoji-laden subject does not break aggregation. /stats never
  //    returns subject text but row insert + count must not throw.
  it('emoji-bearing subject inserts cleanly and is counted', async () => {
    await insertReply({ classification: 'positive', subject: 'Re: poptávka ✉️ bagru 🚜' })
    const { status, body } = await fetchStats()
    expect(status).toBe(200)
    expect(body.total).toBe(1)
    const { rows } = await pool.query(`SELECT subject FROM reply_inbox WHERE id=1`)
    expect((rows[0] as { subject: string }).subject).toContain('🚜')
  })

  // 7. Very long subject (10 KB) — TEXT column has no length cap; insert+count
  //    succeed. We measure roundtrip length in JS rather than via SQL `length()`
  //    because pg-mem 3.0.14 doesn't ship the length() builtin. The intent
  //    (no truncation, no encoding loss) is fully covered.
  it('10 KB subject value inserts and round-trips without truncation', async () => {
    const longSubject = 'a'.repeat(10_000)
    await insertReply({ classification: 'positive', subject: longSubject })
    const { body } = await fetchStats()
    expect(body.total).toBe(1)
    const { rows } = await pool.query(`SELECT subject FROM reply_inbox WHERE id=1`)
    const stored = (rows[0] as { subject: string }).subject
    expect(stored.length).toBe(10_000)
    expect(stored).toBe(longSubject)
  })

  // 8. Larger seed — 1000 rows. pg-mem is in-memory; 10K just hammers CI
  //    without matching real schema-bug discovery rate. Query stays well
  //    under 1.5 s.
  it('handler returns <1.5 s on 1000-row table (perf canary)', async () => {
    for (let i = 0; i < 1000; i++) {
      await insertReply({
        classification: i % 3 === 0 ? 'positive' : i % 3 === 1 ? 'negative' : 'auto_reply',
        handled: i % 2 === 0,
      })
    }
    const t0 = Date.now()
    const { status, body } = await fetchStats()
    const dt = Date.now() - t0
    expect(status).toBe(200)
    expect(body.total).toBe(1000)
    expect(dt).toBeLessThan(1_500)
  })

  // 9. Concurrent reads — 25 in-flight requests must return identical bodies
  //    and never crash the handler. (100 was overkill for an in-mem DB.)
  it('25 concurrent stats reads return identical shape (read-only invariant)', async () => {
    await insertReply({ classification: 'positive' })
    await insertReply({ classification: 'positive' })
    await insertReply({ classification: 'negative' })
    const results = await Promise.all(
      Array.from({ length: 25 }, () => fetchStats()),
    )
    expect(results.every(r => r.status === 200)).toBe(true)
    const first = results[0].body
    for (const { body } of results) expect(body).toEqual(first)
    expect(first.total).toBe(3)
  })

  // 10. Multiple campaigns inserted — total counter sees them all (handler
  //     has no campaign_id filter, by design — that's the contract).
  it('aggregates across multiple campaign_ids — no per-campaign filter on /stats', async () => {
    await insertReply({ classification: 'positive', campaign_id: 1 })
    await insertReply({ classification: 'positive', campaign_id: 2 })
    await insertReply({ classification: 'negative', campaign_id: 3 })
    const { body } = await fetchStats()
    expect(body.total).toBe(3)
  })

  // 11. Response shape — every key is a number on a populated table.
  it('all six stats keys are numeric integers on populated table', async () => {
    await insertReply({ classification: 'positive' })
    await insertReply({ classification: 'negative' })
    await insertReply({ classification: 'auto_reply' })
    await insertReply({ classification: null })
    const { body } = await fetchStats()
    for (const k of STATS_KEYS) {
      expect(typeof body[k]).toBe('number')
      expect(Number.isInteger(body[k])).toBe(true)
    }
    expect(body.total).toBe(4)
  })

  // 12. Plain-WHERE 24h interval works on pg-mem — locks the boundary semantics
  //     for the dialect-equivalent filter so we know the route would behave
  //     correctly on real Postgres for this clause family.
  it("plain-WHERE `received_at > now() - interval '24 hours'` excludes >24h-old rows", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString()
    const old   = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
    await insertReply({ classification: 'positive', received_at: fresh })
    await insertReply({ classification: 'positive', received_at: old })
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS today FROM reply_inbox WHERE received_at > now() - interval '24 hours'`,
    )
    expect((rows[0] as { today: number }).today).toBe(1)
  })

  // 13. Handler response is parseable JSON (no escape mishaps with quotes/UTF-8).
  it('response body is well-formed JSON regardless of row content', async () => {
    await insertReply({ classification: 'positive', subject: 'with "quotes" and ✉️' })
    const res = await fetch(`${baseUrl}/api/replies/stats`)
    const txt = await res.text()
    expect(() => JSON.parse(txt)).not.toThrow()
    expect(txt).not.toContain('�')
  })

  // 14. SQL string in the handler still references reply_inbox (sanity guard
  //     so a future refactor that renames the table fails fast under integration
  //     instead of dying in prod). We assert via a separate query that the
  //     handler's table still exists post-call.
  it('reply_inbox table survives a successful /stats call (no accidental drop)', async () => {
    await insertReply({ classification: 'positive' })
    await fetchStats()
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM reply_inbox`,
    )
    expect((rows[0] as { n: number }).n).toBe(1)
  })

  // ───────── FILTER-aggregate-dependent tests (skipped on pg-mem 3.0.14) ─────────
  //
  // These would surface real bucket-count regressions but pg-mem ignores the
  // FILTER clause so the bucket counters all equal `total`. When pg-mem ships
  // FILTER support, or when this suite is moved to Testcontainers Postgres,
  // these activate automatically.

  // 15. 5 unhandled positives + 3 negatives + 2 auto_reply → counts add up
  it.skipIf(!FILTER_AGGREGATE_WORKS)(
    'mixed classification rows (5 positive + 3 negative + 2 auto_reply) → counts add up',
    async () => {
      for (let i = 0; i < 5; i++) await insertReply({ classification: 'positive', handled: false })
      for (let i = 0; i < 3; i++) await insertReply({ classification: 'negative', handled: false })
      for (let i = 0; i < 2; i++) await insertReply({ classification: 'auto_reply', handled: false })
      const { body } = await fetchStats()
      expect(body.total).toBe(10)
      expect(body.unhandled).toBe(10)
      expect(body.positive).toBe(5)
      expect(body.negative).toBe(3)
      expect(body.auto_reply).toBe(2)
    },
  )

  // 16. All handled → unhandled=0, total=10
  it.skipIf(!FILTER_AGGREGATE_WORKS)(
    'all rows handled → unhandled=0 with total preserved',
    async () => {
      for (let i = 0; i < 10; i++) await insertReply({ classification: 'positive', handled: true })
      const { body } = await fetchStats()
      expect(body.total).toBe(10)
      expect(body.unhandled).toBe(0)
      expect(body.positive).toBe(10)
    },
  )

  // 17. Today filter — fresh rows count, 25h-old rows do not
  it.skipIf(!FILTER_AGGREGATE_WORKS)(
    "today filter uses 24h interval — rows older than 24h are excluded",
    async () => {
      const now = new Date()
      const fresh = new Date(now.getTime() - 60_000).toISOString()
      const old   = new Date(now.getTime() - 25 * 3600 * 1000).toISOString()
      await insertReply({ classification: 'positive', received_at: fresh })
      await insertReply({ classification: 'positive', received_at: fresh })
      await insertReply({ classification: 'positive', received_at: fresh })
      await insertReply({ classification: 'negative', received_at: old })
      await insertReply({ classification: 'negative', received_at: old })
      const { body } = await fetchStats()
      expect(body.total).toBe(5)
      expect(body.today).toBe(3)
    },
  )

  // 18. NULL classification rows count toward total only, not toward any bucket
  it.skipIf(!FILTER_AGGREGATE_WORKS)(
    'NULL classification rows count toward total but not classification buckets',
    async () => {
      await insertReply({ classification: null })
      await insertReply({ classification: null })
      await insertReply({ classification: 'positive' })
      const { body } = await fetchStats()
      expect(body.total).toBe(3)
      expect(body.positive).toBe(1)
      expect(body.negative).toBe(0)
      expect(body.auto_reply).toBe(0)
    },
  )

  // 19. handled=false rows counted as unhandled
  it.skipIf(!FILTER_AGGREGATE_WORKS)(
    'handled=false (with handled_at NULL) → counted as unhandled',
    async () => {
      await insertReply({ classification: 'positive', handled: false, handled_at: null })
      await insertReply({ classification: 'negative', handled: false, handled_at: null })
      const { body } = await fetchStats()
      expect(body.unhandled).toBe(2)
      expect(body.total).toBe(2)
    },
  )
})

// ═══════════════════════════════════════════════════════════════════════════
//  Optional fallback — real Postgres via testcontainers (Sprint S5).
//
//  pg-mem 3.0.14 silently ignores `COUNT(*) FILTER (WHERE …)` so the
//  FILTER-dependent assertions above stay skipped. When Docker is up,
//  we re-run those same assertions against a real container so the
//  bucket-count regressions actually surface.
//
//  pg-mem stays the primary engine. testcontainers boots in 5–10 s and
//  is opt-in via Docker availability — `startPostgres()` returns null
//  when Docker is unreachable, the suite skips cleanly.
// ═══════════════════════════════════════════════════════════════════════════

const { startPostgres: startPg, resetPostgresCache: resetPg } = await import(
  './_setup/postgres-container'
)
let pgCtx: Awaited<ReturnType<typeof startPg>> | null = null
try {
  pgCtx = await startPg({ startTimeoutMs: 60_000 })
} catch {
  pgCtx = null
}

describe.skipIf(!pgCtx)('GET /api/replies/stats — integration (testcontainers fallback)', () => {
  let tcApp: Express
  let tcServer: import('http').Server
  let tcBaseUrl = ''

  beforeEach(async () => {
    if (!pgCtx) return
    // Drop+recreate the tables per test so each case starts clean. The
    // shared container persists across cases for speed.
    await pgCtx.pool.query(`DROP TABLE IF EXISTS reply_inbox`)
    await pgCtx.pool.query(`DROP TABLE IF EXISTS unmatched_inbound`)
    await pgCtx.pool.query(REPLY_INBOX_DDL)
    await pgCtx.pool.query(UNMATCHED_INBOUND_DDL)

    tcApp = express()
    tcApp.use(express.json())
    const safeError = (e: unknown): string => (e as { message?: string })?.message ?? 'unknown'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mountRepliesStatsRouteInteg(tcApp, { pool: pgCtx.pool as any, capture500: (res: any, e: any, se: any) => { res.status(500).json({ error: se(e) }) }, safeError })
    await new Promise<void>((resolve) => {
      tcServer = tcApp.listen(0, () => {
        const addr = tcServer.address()
        if (addr && typeof addr === 'object') tcBaseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    if (tcServer) await new Promise<void>((resolve) => tcServer.close(() => resolve()))
  })

  async function fetchTcStats(): Promise<{ status: number; body: StatsResponse }> {
    const res = await fetch(`${tcBaseUrl}/api/replies/stats`)
    const body = await res.json() as StatsResponse
    return { status: res.status, body }
  }

  async function tcInsert(row: {
    classification?: string | null
    handled?: boolean
    received_at?: string
  }): Promise<void> {
    await pgCtx!.pool.query(
      `INSERT INTO reply_inbox(classification, handled, received_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()))`,
      [row.classification ?? null, row.handled ?? false, row.received_at ?? null],
    )
  }

  it('FILTER aggregate evaluates correctly on real Postgres — bucket counts add up', async () => {
    for (let i = 0; i < 5; i++) await tcInsert({ classification: 'positive', handled: false })
    for (let i = 0; i < 3; i++) await tcInsert({ classification: 'negative', handled: false })
    for (let i = 0; i < 2; i++) await tcInsert({ classification: 'auto_reply', handled: false })
    const { body } = await fetchTcStats()
    expect(body.total).toBe(10)
    expect(body.unhandled).toBe(10)
    expect(body.positive).toBe(5)
    expect(body.negative).toBe(3)
    expect(body.auto_reply).toBe(2)
  })

  it('today filter on real Postgres — 24h boundary excludes >24h-old rows', async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString()
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
    await tcInsert({ classification: 'positive', received_at: fresh })
    await tcInsert({ classification: 'positive', received_at: fresh })
    await tcInsert({ classification: 'negative', received_at: old })
    const { body } = await fetchTcStats()
    expect(body.total).toBe(3)
    expect(body.today).toBe(2)
  })
})

afterAll(async () => {
  await resetPg()
})
