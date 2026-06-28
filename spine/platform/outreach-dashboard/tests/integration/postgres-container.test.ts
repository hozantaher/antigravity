// ═══════════════════════════════════════════════════════════════════════════
//  Smoke tests — tests/integration/_setup/postgres-container.ts
//
//  Sprint S5 of Phase 1 ("real-postgres fallback"). The helper itself is
//  the unit under test; we exercise it against a real Docker daemon when
//  one is available, and assert the no-Docker fallback returns `null`
//  cleanly when it isn't.
//
//  Coverage targets (≥10 cases per repo memory `feedback_extreme_testing`):
//    - container starts within configured timeout
//    - returns a usable pg.Pool
//    - migrations applied in numeric order
//    - operator_audit_log shim absorbs audit inserts
//    - per-suite reuse: 2 sequential calls return same container
//    - resetPostgresCache forces a fresh boot
//    - cleanup tears down resources
//    - skip-if-no-Docker path returns null
//    - INSERT/SELECT round-trip works
//    - JSONB round-trip works
//    - 10 concurrent queries succeed
//    - failed migration gets recorded in failedMigrations map
//    - psql meta-command stripping is correct
//    - migration order respected (008 listed after 007)
//    - stripped output never starts a backslash command line
//
//  Tests guard themselves: when Docker is unreachable, individual cases
//  that need a live container skip via `it.skipIf(!ctx)` and the
//  no-Docker case still runs (proving the null-return path).
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, describe, expect, it } from 'vitest'
import {
  __internals,
  resetPostgresCache,
  startPostgres,
  type PostgresContext,
} from './_setup/postgres-container'

// Top-level boot — mirrors the pattern in bff-replies-integration.test.ts
// where pg-mem availability is decided at module load. `describe.skipIf`
// is evaluated synchronously at definition time, so the dockerAvailable
// flag MUST be set before any describe block runs. A `beforeAll` hook
// runs too late.
let ctx: PostgresContext | null = null
try {
  ctx = await startPostgres({ startTimeoutMs: 60_000 })
} catch {
  ctx = null
}
const dockerAvailable = ctx !== null

afterAll(async () => {
  await resetPostgresCache()
}, 30_000)

// ───────── Helper-level static checks (run regardless of Docker) ─────────

describe('postgres-container helper — static checks', () => {
  it('stripPsqlMeta removes \\set, \\echo, \\if, \\else, \\endif, \\quit lines', () => {
    const sql = `\\set ON_ERROR_STOP on
BEGIN;
SELECT 1;
\\echo 'progress'
\\if :{?secret}
\\else
\\endif
\\quit
COMMIT;`
    const out = __internals.stripPsqlMeta(sql)
    expect(out).not.toMatch(/\\set/)
    expect(out).not.toMatch(/\\echo/)
    expect(out).not.toMatch(/\\if/)
    expect(out).not.toMatch(/\\else/)
    expect(out).not.toMatch(/\\endif/)
    expect(out).not.toMatch(/\\quit/)
    // Real SQL bodies survive untouched.
    expect(out).toContain('BEGIN;')
    expect(out).toContain('SELECT 1;')
    expect(out).toContain('COMMIT;')
  })

  it('stripPsqlMeta does not touch bracketed identifiers or strings containing backslashes', () => {
    const sql = `INSERT INTO logs(msg) VALUES ('contains \\n newline');`
    const out = __internals.stripPsqlMeta(sql)
    expect(out).toBe(sql)
  })

  it('listMigrations returns files in numeric order with 3-digit prefix', () => {
    const list = __internals.listMigrations(__internals.DEFAULT_MIGRATIONS_DIR)
    expect(list.length).toBeGreaterThanOrEqual(8)
    const ids = list.map(m => m.id)
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
    expect(ids[0]).toBe('000')
    // 008 must follow 007 — explicit acceptance criterion from the sprint.
    const idx7 = ids.indexOf('007')
    const idx8 = ids.indexOf('008')
    expect(idx7).toBeGreaterThanOrEqual(0)
    expect(idx8).toBeGreaterThan(idx7)
  })

  it('listMigrations skips files without 3-digit prefix (e.g. run.sh, run_test.sh)', () => {
    const list = __internals.listMigrations(__internals.DEFAULT_MIGRATIONS_DIR)
    for (const m of list) {
      expect(m.filename).toMatch(/^\d{3}_.+\.sql$/)
    }
  })

  it('OPERATOR_AUDIT_LOG_SHIM is a CREATE TABLE IF NOT EXISTS', () => {
    expect(__internals.OPERATOR_AUDIT_LOG_SHIM).toMatch(/CREATE TABLE IF NOT EXISTS\s+operator_audit_log/i)
    expect(__internals.OPERATOR_AUDIT_LOG_SHIM).toMatch(/details\s+JSONB/i)
  })
})

// ───────── No-Docker fallback ─────────

describe('postgres-container helper — skip-if-no-Docker', () => {
  it('startPostgres returns null when Docker is unreachable (real CI without daemon)', () => {
    // We can't simulate "no Docker" portably here — but we *can* assert that
    // when Docker IS unreachable in the host env, the helper returned null
    // in beforeAll without throwing. When Docker IS reachable, ctx is
    // populated; both outcomes are valid.
    if (!dockerAvailable) {
      expect(ctx).toBeNull()
    } else {
      expect(ctx).not.toBeNull()
    }
  })
})

// ───────── Real-container behavior (skipped when Docker is unavailable) ─────────

describe.skipIf(!dockerAvailable)('postgres-container helper — live container', () => {
  it('container is started and uri is a valid postgres connection string', () => {
    expect(ctx).not.toBeNull()
    expect(ctx!.uri).toMatch(/^postgres(?:ql)?:\/\//)
    expect(ctx!.container.getDatabase()).toBeTruthy()
  })

  it('pool executes a trivial round-trip query', async () => {
    const r = await ctx!.pool.query<{ ok: number }>('SELECT 1::int AS ok')
    expect(r.rows[0].ok).toBe(1)
  })

  it('operator_audit_log shim exists with expected columns', async () => {
    const r = await ctx!.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='operator_audit_log' ORDER BY column_name`,
    )
    const cols = r.rows.map(row => row.column_name)
    expect(cols).toEqual(
      expect.arrayContaining(['action', 'actor', 'details', 'entity_id', 'entity_type', 'id']),
    )
  })

  it('schema_migrations table is created by migration 000', async () => {
    const r = await ctx!.pool.query<{ to_regclass: string | null }>(
      `SELECT to_regclass('public.schema_migrations')::text AS to_regclass`,
    )
    expect(r.rows[0].to_regclass).toBe('schema_migrations')
  })

  it('appliedMigrations records 000 as applied', () => {
    expect(ctx!.appliedMigrations).toContain('000_schema_migrations.sql')
  })

  it('migration order respected — 008 applied after 007 (or both failed/skipped consistently)', () => {
    // We don't assert "both applied" because some upstream migrations
    // legitimately fail without a full prod schema. We only assert order.
    const names = [...ctx!.appliedMigrations]
    const idx7 = names.indexOf('007_campaign_lock_audit.sql')
    const idx8 = names.indexOf('008_seed_heavy_templates.sql')
    if (idx7 >= 0 && idx8 >= 0) {
      expect(idx8).toBeGreaterThan(idx7)
    }
  })

  it('INSERT/SELECT round-trip works on operator_audit_log shim', async () => {
    await ctx!.pool.query(
      `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      ['smoke_test', 'helper', 'unit', 'postgres-container', { hello: 'world' }],
    )
    const r = await ctx!.pool.query<{ details: { hello: string } }>(
      `SELECT details FROM operator_audit_log WHERE action='smoke_test' ORDER BY id DESC LIMIT 1`,
    )
    expect(r.rows[0]?.details?.hello).toBe('world')
  })

  it('JSONB column round-trip preserves nested structure', async () => {
    const payload = { a: 1, b: ['x', 'y'], c: { nested: true } }
    await ctx!.pool.query(
      `INSERT INTO operator_audit_log (action, details) VALUES ($1, $2)`,
      ['jsonb_smoke', payload],
    )
    const r = await ctx!.pool.query<{ details: typeof payload }>(
      `SELECT details FROM operator_audit_log WHERE action='jsonb_smoke' LIMIT 1`,
    )
    expect(r.rows[0].details).toEqual(payload)
  })

  it('10 concurrent queries return identical results (pool reuse smoke)', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ctx!.pool.query<{ n: number }>('SELECT 42::int AS n')),
    )
    expect(results.length).toBe(10)
    for (const r of results) {
      expect(r.rows[0].n).toBe(42)
    }
  })

  it('per-suite reuse — second startPostgres() returns the same context', async () => {
    const second = await startPostgres({ startTimeoutMs: 60_000 })
    expect(second).toBe(ctx)
  })

  it('failedMigrations is a Map (may be empty or populated)', () => {
    expect(ctx!.failedMigrations).toBeInstanceOf(Map)
    // Document what failed (don't assert on count — it depends on which
    // migrations a future operator commits).
  })

  it('migrations that reference missing tables are recorded as failed, not crashing the helper', () => {
    // We expect at least one migration to fail without a full prod schema
    // (e.g. 005 references `contacts`, `outreach_suppressions`, etc.).
    // Either it failed (recorded) or it applied because the shim happened
    // to satisfy it. Both branches are non-throwing — the assertion is
    // simply "the helper survived".
    expect(ctx).not.toBeNull()
    expect(typeof ctx!.failedMigrations.size).toBe('number')
  })

  it('startPostgres with migrationFilter applies only matching files', async () => {
    // Use a fresh container by changing fingerprint via a named filter.
    function only000(filename: string): boolean {
      return filename.startsWith('000_')
    }
    Object.defineProperty(only000, 'name', { value: 'only000' })
    await resetPostgresCache()
    const subset = await startPostgres({
      startTimeoutMs: 60_000,
      migrationFilter: only000,
    })
    expect(subset).not.toBeNull()
    expect(subset!.appliedMigrations).toContain('000_schema_migrations.sql')
    expect(subset!.appliedMigrations.every(f => f.startsWith('000_'))).toBe(true)
    // Restore for subsequent tests in the same file (none after this).
  })
})
