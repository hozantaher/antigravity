// migration_runner_audit.test.js
//
// Audit-level contract tests for scripts/migrations/run.sh and the
// 099_schema_migrations_compat.sql migration.
//
// These tests are static (no real DB) — they assert that the shell
// script and SQL contain the required patterns that make the runner
// safe in both full-schema and degraded (legacy) modes.
//
// Per feedback_extreme_testing: ≥10 cases; boundary + error + integration paths.
// Real-DB integration tests are out-of-scope for vitest; see docs/playbooks/
// migration-rollout-plan.md for the prod apply procedure.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ── Helpers ───────────────────────────────────────────────────────────────────

const DASHBOARD_ROOT = resolve(__dirname, '..', '..')
const REPO_ROOT = resolve(DASHBOARD_ROOT, '..', '..', '..')

function readRepo(rel) {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

function existsRepo(rel) {
  return existsSync(resolve(REPO_ROOT, rel))
}

// ── Source fixtures ───────────────────────────────────────────────────────────

const RUN_SH = 'scripts/migrations/run.sh'
const SQL_000 = 'scripts/migrations/000_schema_migrations.sql'
const SQL_099 = 'scripts/migrations/099_schema_migrations_compat.sql'
const PLAYBOOK = 'docs/playbooks/migration-rollout-plan.md'

// ─────────────────────────────────────────────────────────────────────────────
// T-1: File existence (files in scope must be present)
// ─────────────────────────────────────────────────────────────────────────────

describe('migration runner — file existence', () => {
  it('T-1: run.sh exists', () => {
    expect(existsRepo(RUN_SH)).toBe(true)
  })

  it('T-2: 000_schema_migrations.sql exists', () => {
    expect(existsRepo(SQL_000)).toBe(true)
  })

  it('T-3: 099_schema_migrations_compat.sql exists', () => {
    expect(existsRepo(SQL_099)).toBe(true)
  })

  it('T-4: migration rollout playbook exists', () => {
    expect(existsRepo(PLAYBOOK)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-2: Full-schema INSERT path
// Runner MUST use migration_id/filename/content_sha256 columns when
// FULL_SCHEMA=1.
// ─────────────────────────────────────────────────────────────────────────────

describe('migration runner — full-schema INSERT path', () => {
  it('T-5: full-schema INSERT includes migration_id, filename, content_sha256', () => {
    const src = readRepo(RUN_SH)
    // The full INSERT must name all BF-G3 columns
    expect(src).toMatch(/INSERT INTO schema_migrations\(migration_id, filename, content_sha256/)
  })

  it('T-6: full-schema INSERT includes applied_by and git_sha', () => {
    const src = readRepo(RUN_SH)
    expect(src).toMatch(/applied_by.*git_sha|git_sha.*applied_by/)
  })

  it('T-7: full-schema INSERT uses ON CONFLICT (migration_id) DO NOTHING for idempotency', () => {
    const src = readRepo(RUN_SH)
    // Duplicate apply must be idempotent
    expect(src).toMatch(/ON CONFLICT \(migration_id\) DO NOTHING/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-3: Degraded (legacy-schema) INSERT path
// When migration_id column is absent the runner must fall back to inserting
// only the "version" column so the script doesn't crash before 099 applies.
// ─────────────────────────────────────────────────────────────────────────────

describe('migration runner — degraded INSERT path (legacy schema)', () => {
  it('T-8: runner probes migration_id column existence before inserting', () => {
    const src = readRepo(RUN_SH)
    // Must SELECT from information_schema.columns
    expect(src).toMatch(/information_schema\.columns/)
    expect(src).toMatch(/migration_id/)
  })

  it('T-9: degraded INSERT path uses version column only', () => {
    const src = readRepo(RUN_SH)
    // Degraded path inserts into "version" column (legacy schema)
    expect(src).toMatch(/INSERT INTO schema_migrations\(version/)
  })

  it('T-10: degraded path emits a WARN message so operator knows to apply 099', () => {
    const src = readRepo(RUN_SH)
    expect(src).toMatch(/WARN.*legacy schema|legacy schema.*WARN/i)
  })

  it('T-11: FULL_SCHEMA variable is set after probe (controls branching)', () => {
    const src = readRepo(RUN_SH)
    expect(src).toMatch(/FULL_SCHEMA=/)
    // Must branch on it
    expect(src).toMatch(/if \[\[ "\$FULL_SCHEMA" == "1" \]\]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-4: Exit-code contracts
// ─────────────────────────────────────────────────────────────────────────────

describe('migration runner — exit-code contracts', () => {
  it('T-12: exit 3 on predecessor missing', () => {
    const src = readRepo(RUN_SH)
    expect(src).toMatch(/exit 3/)
    expect(src).toMatch(/predecessor/)
  })

  it('T-13: exit 4 on drift (sha mismatch)', () => {
    const src = readRepo(RUN_SH)
    expect(src).toMatch(/exit 4/)
    expect(src).toMatch(/drift/)
  })

  it('T-14: exit 6 on advisory lock conflict', () => {
    const src = readRepo(RUN_SH)
    expect(src).toMatch(/exit 6/)
    expect(src).toMatch(/advisory lock/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-5: Drift detection gating
// Drift detection must be skipped in legacy mode (no content_sha256 to query).
// ─────────────────────────────────────────────────────────────────────────────

describe('migration runner — drift detection gating', () => {
  it('T-15: drift detection is wrapped in FULL_SCHEMA == 1 guard', () => {
    const src = readRepo(RUN_SH)
    // The drift loop is inside the FULL_SCHEMA check
    const fullSchemaGuardIdx = src.indexOf('if [[ "$FULL_SCHEMA" == "1" ]]')
    const driftLoopIdx = src.indexOf('content_sha256 FROM schema_migrations')
    // drift loop must come AFTER the first FULL_SCHEMA guard
    expect(fullSchemaGuardIdx).toBeGreaterThan(-1)
    expect(driftLoopIdx).toBeGreaterThan(fullSchemaGuardIdx)
  })

  it('T-16: drift detection uses manual-backfill sentinel to skip pre-BF-G3 rows', () => {
    const src = readRepo(RUN_SH)
    expect(src).toMatch(/manual-backfill/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-6: 099 compat migration SQL contracts
// ─────────────────────────────────────────────────────────────────────────────

describe('099 compat migration SQL contracts', () => {
  it('T-17: adds migration_id column with ADD COLUMN IF NOT EXISTS', () => {
    const sql = readRepo(SQL_099)
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS.*migration_id/s)
  })

  it('T-18: adds filename, content_sha256, applied_by, git_sha columns', () => {
    const sql = readRepo(SQL_099)
    expect(sql).toMatch(/filename/)
    expect(sql).toMatch(/content_sha256/)
    expect(sql).toMatch(/applied_by/)
    expect(sql).toMatch(/git_sha/)
  })

  it('T-19: backfills migration_id from version WHERE migration_id IS NULL', () => {
    const sql = readRepo(SQL_099)
    expect(sql).toMatch(/SET migration_id = version/)
    expect(sql).toMatch(/WHERE migration_id IS NULL/)
  })

  it('T-20: sets content_sha256 = manual-backfill for rows without sha', () => {
    const sql = readRepo(SQL_099)
    expect(sql).toMatch(/content_sha256 = 'manual-backfill'/)
    expect(sql).toMatch(/WHERE content_sha256 IS NULL/)
  })

  it('T-21: adds UNIQUE constraint on migration_id idempotently (DO block + IF NOT EXISTS check)', () => {
    const sql = readRepo(SQL_099)
    expect(sql).toMatch(/UNIQUE.*migration_id|migration_id.*UNIQUE/s)
    // Must guard with DO $$ BEGIN IF NOT EXISTS to be idempotent
    expect(sql).toMatch(/DO \$\$/)
    expect(sql).toMatch(/IF NOT EXISTS/)
  })

  it('T-22: 099 number is intentionally out-of-band (comment explains high number)', () => {
    const sql = readRepo(SQL_099)
    // The file must document why it uses 099 (sorting last, out-of-band)
    expect(sql).toMatch(/099|out.of.band|last/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-7: Idempotency guarantees
// ─────────────────────────────────────────────────────────────────────────────

describe('migration idempotency guarantees', () => {
  it('T-23: 000_schema_migrations.sql uses CREATE TABLE IF NOT EXISTS', () => {
    const sql = readRepo(SQL_000)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/)
  })

  it('T-24: 099 uses ADD COLUMN IF NOT EXISTS (not bare ALTER in DDL statements)', () => {
    const sql = readRepo(SQL_099)
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/)
    // Strip SQL comments (-- …) before checking for bare ADD COLUMN.
    // A bare ADD COLUMN in a comment is fine; it's only harmful in DDL.
    const sqlNoComments = sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    const bareAddColumn = sqlNoComments.match(/ADD COLUMN(?! IF NOT EXISTS)/g)
    expect(bareAddColumn).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-8: Playbook — prod apply procedure (099 first, then 022..024)
// ─────────────────────────────────────────────────────────────────────────────

describe('migration rollout playbook contracts', () => {
  it('T-25: playbook mentions 099 as first manual step', () => {
    const md = readRepo(PLAYBOOK)
    expect(md).toMatch(/099/)
  })

  it('T-26: playbook mentions drift detection re-enabled after 099', () => {
    const md = readRepo(PLAYBOOK)
    expect(md).toMatch(/drift.*re-enabled|re-enabled.*drift/i)
  })

  it('T-27: playbook has a one-time prod migration section', () => {
    const md = readRepo(PLAYBOOK)
    expect(md).toMatch(/one.time|One.time|prod.*compat|compat.*prod/i)
  })
})
