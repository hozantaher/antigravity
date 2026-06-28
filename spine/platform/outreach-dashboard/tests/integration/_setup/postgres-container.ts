// ═══════════════════════════════════════════════════════════════════════════
//  testcontainers Postgres helper — Sprint S5 of Phase 1.
//
//  Standardizes how integration tests stand up a real Postgres against which
//  the dashboard's BFF + migration suite can be exercised.
//
//  Why this exists
//  ──────────────────
//  Most integration tests in this repo run against pg-mem (in-process,
//  pure-JS). pg-mem is fast (~100 ms cold start) and dep-light, but it
//  diverges from real Postgres in known ways:
//    - `COUNT(*) FILTER (WHERE …)` — parsed but not evaluated
//    - DO blocks and PL/pgSQL — not supported
//    - dollar-quoted strings (`$BODY$ … $BODY$`) — not parsed
//    - `length()`, several other builtins — missing
//
//  When a test needs real-Postgres behavior (FILTER, advisory locks,
//  triggers, JSONB, full migration apply), we boot a real container
//  via Docker. That's slow (~5–10 s start), so it's strictly opt-in:
//  pg-mem stays the primary engine, this helper is the fallback.
//
//  Skip-if-no-Docker
//  ─────────────────
//  Local dev machines without a running Docker daemon must still run
//  `pnpm test:integration` cleanly. `startPostgres()` returns `null`
//  when:
//    - the `testcontainers` package can't import (missing devDep, e.g.
//      production CI image)
//    - the Docker daemon isn't reachable
//    - container start times out
//  Tests use `describe.skipIf(!ctx)` to opt out cleanly — never silently
//  pass.
//
//  Per-suite caching
//  ─────────────────
//  Container start dominates wall time (~5 s). The helper caches a single
//  container per Node process (suite-scoped reuse). Tests that need a
//  fresh schema call `cleanup()` and re-`startPostgres()`. Vitest runs
//  each test file in its own worker by default, so the cache is per-file
//  unless callers explicitly share via module-scope.
//
//  Migration handling
//  ──────────────────
//  Real Postgres tolerates everything pg-mem can't. But our migrations
//  contain psql meta-commands (`\set`, `\echo`, `\if`/`\else`/`\endif`,
//  `\quit`) that the `pg` Node driver does **not** understand — they
//  must be stripped before sending to pool.query().
//
//  Several migrations also reference tables that don't exist on a fresh
//  database (`operator_audit_log`, `contacts`, `outreach_mailboxes`).
//  The helper:
//    1. Creates a permissive `operator_audit_log` shim first so audit
//       inserts in 001..008 don't blow up.
//    2. Strips psql meta-commands.
//    3. Applies each migration as a single multi-statement query.
//    4. Tracks failures per file and surfaces them in the return value.
//
//  Callers that need stricter ordering pass `{ stopOnFirstError: true }`.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

// `testcontainers` and `@testcontainers/postgresql` are devDeps. We import
// dynamically so a bare-metal `pnpm install --prod` still loads this module
// (the helper just resolves to a null context, tests skip).
type StartedPostgreSqlContainer =
  import('@testcontainers/postgresql').StartedPostgreSqlContainer

export interface PostgresContext {
  pool: pg.Pool
  container: StartedPostgreSqlContainer
  cleanup: () => Promise<void>
  /** Filenames that applied successfully (in order). */
  appliedMigrations: readonly string[]
  /** Per-file errors keyed by filename — empty when every migration applied. */
  failedMigrations: ReadonlyMap<string, string>
  /** Connection URI for tools that need a raw psql string. */
  uri: string
}

export interface StartPostgresOptions {
  /** Postgres image to pull (default `postgres:15-alpine`). */
  image?: string
  /** Container start timeout in ms (default 60_000). */
  startTimeoutMs?: number
  /**
   * Limit which migration files are applied. Receives the bare filename
   * (e.g. `005_contacts_status_sync.sql`) and returns true to apply.
   * Default: every file matching `NNN_*.sql` is applied in numeric order.
   */
  migrationFilter?: (filename: string) => boolean
  /**
   * If `true`, abort on the first migration that throws — leaves the
   * helper context populated with whatever applied so far. Default `false`
   * (continue, collect errors).
   */
  stopOnFirstError?: boolean
  /**
   * Override the migrations directory. Default points to the repo's
   * `scripts/migrations/` folder relative to this file.
   */
  migrationsDir?: string
  /**
   * If `true`, skip the operator_audit_log shim. Useful when the caller
   * wants to test audit-log-aware migrations against the real schema.
   */
  skipAuditShim?: boolean
}

const DEFAULT_MIGRATIONS_DIR = resolve(
  __dirname,
  '../../../../../scripts/migrations',
)

const DEFAULT_IMAGE = 'postgres:15-alpine'
const DEFAULT_START_TIMEOUT_MS = 60_000

// Shim table that mirrors enough of operator_audit_log to absorb the
// INSERTs scattered across 001/002/003/004/005/007/008. The real schema
// has more columns; this is just permissive enough so audit inserts pass.
const OPERATOR_AUDIT_LOG_SHIM = `
  CREATE TABLE IF NOT EXISTS operator_audit_log (
    id          SERIAL PRIMARY KEY,
    action      TEXT,
    actor       TEXT,
    entity_type TEXT,
    entity_id   TEXT,
    details     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`

// Strip psql meta-commands. The Node `pg` driver speaks the wire protocol
// directly, with no notion of psql backslash commands. We match a leading
// backslash command at the start of a line plus everything to end-of-line.
//   \set ON_ERROR_STOP on
//   \echo '── …'
//   \if :{?secret}
//   \else
//   \endif
//   \quit
// We keep matching conservative — if the regex misses an obscure psql
// directive, the migration will fail and the failure will surface in
// `failedMigrations`, which is the safer outcome than silently mangling
// SQL.
const PSQL_META_LINE = /^\s*\\(?:set|echo|if|elif|else|endif|quit|cd|i|ir|gset)\b[^\n]*$/gim

function stripPsqlMeta(sql: string): string {
  return sql.replace(PSQL_META_LINE, '')
}

interface MigrationFile {
  id: string
  filename: string
  fullPath: string
  sql: string
}

function listMigrations(dir: string): readonly MigrationFile[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: MigrationFile[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/^\d{3}_.+\.sql$/.test(entry.name)) continue
    const fullPath = resolve(dir, entry.name)
    const sql = readFileSync(fullPath, 'utf8')
    files.push({
      id: entry.name.slice(0, 3),
      filename: entry.name,
      fullPath,
      sql,
    })
  }
  // Numeric prefix sort. Lexicographic works because we enforce 3 digits.
  files.sort((a, b) => a.id.localeCompare(b.id))
  return files
}

async function applyMigrations(
  pool: pg.Pool,
  files: readonly MigrationFile[],
  stopOnFirstError: boolean,
): Promise<{ applied: string[]; failed: Map<string, string> }> {
  const applied: string[] = []
  const failed = new Map<string, string>()
  for (const file of files) {
    const stripped = stripPsqlMeta(file.sql)
    try {
      await pool.query(stripped)
      applied.push(file.filename)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? 'unknown error')
      failed.set(file.filename, message)
      if (stopOnFirstError) break
    }
  }
  return { applied, failed }
}

let cached: PostgresContext | null = null
let cachedFingerprint: string | null = null
let pendingStart: Promise<PostgresContext | null> | null = null

function fingerprint(opts: StartPostgresOptions): string {
  return JSON.stringify({
    image: opts.image ?? DEFAULT_IMAGE,
    dir: opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR,
    skipAuditShim: opts.skipAuditShim ?? false,
    stopOnFirstError: opts.stopOnFirstError ?? false,
    // migrationFilter is a function — fingerprint by `name` so callers
    // can opt into shared cache by naming their filter consistently.
    filterName: opts.migrationFilter?.name ?? '',
  })
}

/**
 * Boot a Postgres container, apply migrations, return a connected pool.
 *
 * Returns `null` when Docker is unreachable or the testcontainers package
 * is missing — callers must guard with `describe.skipIf(!ctx)`.
 *
 * Per-suite reuse: subsequent calls within the same Node process and
 * matching options return the cached context. Mutations to `pool` persist
 * across calls. Use `cleanup()` to tear down the container for the next
 * suite.
 */
export async function startPostgres(
  options: StartPostgresOptions = {},
): Promise<PostgresContext | null> {
  const fp = fingerprint(options)
  if (cached && cachedFingerprint === fp) {
    return cached
  }
  if (pendingStart) {
    return pendingStart
  }

  pendingStart = (async (): Promise<PostgresContext | null> => {
    let mod: typeof import('@testcontainers/postgresql') | null = null
    try {
      mod = await import('@testcontainers/postgresql')
    } catch {
      return null
    }

    const image = options.image ?? DEFAULT_IMAGE
    const startTimeout = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS

    let container: StartedPostgreSqlContainer
    try {
      const builder = new mod.PostgreSqlContainer(image)
        .withStartupTimeout(startTimeout)
      container = await builder.start()
    } catch {
      // Docker daemon not running, image pull failure, port allocation
      // failure — every "I don't have Docker" path lands here. Return
      // null so describe.skipIf can take over.
      return null
    }

    const pool = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 8,
      idleTimeoutMillis: 5_000,
    })

    if (!options.skipAuditShim) {
      // Best-effort. If shim setup itself fails, propagate so callers
      // see the real cause rather than a confusing migration error.
      await pool.query(OPERATOR_AUDIT_LOG_SHIM)
    }

    const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR
    const all = listMigrations(dir)
    const filtered = options.migrationFilter
      ? all.filter(f => options.migrationFilter!(f.filename))
      : all

    const { applied, failed } = await applyMigrations(
      pool,
      filtered,
      options.stopOnFirstError ?? false,
    )

    let cleanedUp = false
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) return
      cleanedUp = true
      try {
        await pool.end()
      } catch {
        // pool.end is idempotent in practice; swallow secondary failures.
      }
      try {
        await container.stop()
      } catch {
        // container.stop double-call is fine.
      }
      if (cached === ctx) {
        cached = null
        cachedFingerprint = null
      }
    }

    const ctx: PostgresContext = {
      pool,
      container,
      cleanup,
      appliedMigrations: applied,
      failedMigrations: failed,
      uri: container.getConnectionUri(),
    }
    cached = ctx
    cachedFingerprint = fp
    return ctx
  })()

  try {
    return await pendingStart
  } finally {
    pendingStart = null
  }
}

/**
 * Force a fresh container on next `startPostgres()` call.
 *
 * Tests that mutate global state (DROP TABLE, schema changes) should call
 * this in `afterAll` to avoid leaking dirty state into the next suite.
 */
export async function resetPostgresCache(): Promise<void> {
  if (cached) {
    await cached.cleanup()
  }
  cached = null
  cachedFingerprint = null
}

/**
 * Exported strictly for unit tests of the helper itself.
 * Don't rely on this in production tests.
 */
export const __internals = {
  stripPsqlMeta,
  listMigrations,
  OPERATOR_AUDIT_LOG_SHIM,
  DEFAULT_MIGRATIONS_DIR,
}
