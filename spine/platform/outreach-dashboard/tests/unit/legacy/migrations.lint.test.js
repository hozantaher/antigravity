// @linkage-allowed: discipline ratchet — scans files dynamically (not via static imports)
// Migration linter — structural checks against dangerous patterns.
// Goal: catch backwards-incompatible changes (DROP COLUMN, RENAME without
// shim) before they ship. Each migration must be idempotent and safe
// to re-run on a partially-migrated DB.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join } from 'path'

const MIG_DIR = join(import.meta.dirname, '../../internal/db/migrations')

const MIG_EXISTS = existsSync(MIG_DIR)
const files = MIG_EXISTS
  ? readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
  : []

// Per-file allowlist for known-safe historical migrations that intentionally
// break the rule (e.g. an old DROP COLUMN that's already in production).
const ALLOW = new Map([
  // GDPR removal is intentional per services/machinery-outreach/CLAUDE.md
  // ("compliance/consent framework ... is being fully removed").
  ['036_drop_gdpr.sql', ['drop-column', 'rename', 'idempotent']],
])

// Historical duplicate sequence numbers — both files are already applied
// in production. Document them; do not silently re-allow new duplicates.
// Historical duplicates already in production. Locked here so that any
// NEW duplicate (a fresh collision when two devs branch off the same
// number) still fails the test.
const ALLOWED_DUPLICATE_SEQUENCES = new Set(['001', '002', '042'])

function lintFile(name) {
  const src = readFileSync(join(MIG_DIR, name), 'utf8')
  // Strip comments + strings to avoid false positives in literals.
  const cleaned = src
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const issues = []
  const skip = new Set(ALLOW.get(name) || [])

  // 1. DROP COLUMN — backwards-incompatible.
  if (!skip.has('drop-column') && /\bDROP\s+COLUMN\b/i.test(cleaned)) {
    issues.push({ rule: 'drop-column', msg: 'DROP COLUMN is backwards-incompatible — deploy in two phases (stop writes, then drop in next migration).' })
  }
  // 2. ALTER COLUMN ... TYPE — can be expensive lock + may corrupt data.
  if (!skip.has('alter-type') && /\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i.test(cleaned)) {
    if (!/USING\s+/i.test(cleaned)) {
      issues.push({ rule: 'alter-type', msg: 'ALTER COLUMN TYPE without USING clause — ensure type cast is safe.' })
    }
  }
  // 3. RENAME COLUMN / TABLE — break running readers.
  if (!skip.has('rename') && /\bRENAME\s+(?:COLUMN|TO)\b/i.test(cleaned)) {
    issues.push({ rule: 'rename', msg: 'RENAME breaks live readers — use shim view or two-phase deploy.' })
  }
  // 4. CREATE INDEX without CONCURRENTLY on what looks like a hot table.
  const idxMatches = cleaned.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)([^\s(]+)\s+ON\s+(\w+)/gi) || []
  for (const m of idxMatches) {
    if (skip.has('index-concurrent')) break
    const tbl = m.match(/ON\s+(\w+)/i)?.[1]?.toLowerCase()
    if (['companies','contacts','send_events','reply_inbox','events'].includes(tbl)) {
      issues.push({ rule: 'index-concurrent', msg: `CREATE INDEX on hot table "${tbl}" should use CONCURRENTLY (avoids exclusive lock).` })
    }
  }
  // 5. CREATE TABLE / INDEX without IF NOT EXISTS — non-idempotent.
  const ddl = cleaned.match(/CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TABLE)\b/gi) || []
  const idempotent = cleaned.match(/CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TABLE)\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\b/gi) || []
  if (!skip.has('idempotent') && ddl.length > 0 && idempotent.length < ddl.length) {
    issues.push({ rule: 'idempotent', msg: `${ddl.length - idempotent.length} CREATE statement(s) without IF NOT EXISTS — re-running migration will fail.` })
  }
  // 6. ALTER TABLE ADD COLUMN with NOT NULL but no DEFAULT — locks + fails on existing rows.
  const addNotNull = cleaned.match(/ADD\s+COLUMN\s+\w+\s+[^,;]*\bNOT\s+NULL\b[^,;]*/gi) || []
  for (const m of addNotNull) {
    if (skip.has('add-notnull')) break
    if (!/DEFAULT/i.test(m)) {
      issues.push({ rule: 'add-notnull', msg: `ADD COLUMN ... NOT NULL without DEFAULT — fails on tables with existing rows.` })
    }
  }
  return issues
}

const descFn = MIG_EXISTS ? describe : describe.skip

descFn('migration files exist and are non-empty', () => {
  it(`finds at least 30 SQL migrations`, () => {
    expect(files.length).toBeGreaterThanOrEqual(30)
  })
  for (const f of files) {
    it(`${f} is non-empty`, () => {
      const sz = statSync(join(MIG_DIR, f)).size
      expect(sz).toBeGreaterThan(0)
    })
  }
})

descFn('migration sequence is strictly increasing', () => {
  it('every file starts with a unique zero-padded number', () => {
    const seen = new Set()
    for (const f of files) {
      const n = f.match(/^(\d+)/)?.[1]
      expect(n, `${f} missing leading number`).toBeTruthy()
      if (seen.has(n) && !ALLOWED_DUPLICATE_SEQUENCES.has(n)) {
        throw new Error(`${f}: duplicate sequence number ${n}`)
      }
      seen.add(n)
    }
  })
})

descFn('migration linter — per-file safety checks', () => {
  for (const f of files) {
    it(`${f} passes lint`, () => {
      const issues = lintFile(f)
      if (issues.length > 0) {
        const msg = issues.map(i => `[${i.rule}] ${i.msg}`).join('\n  ')
        throw new Error(`${f}:\n  ${msg}`)
      }
    })
  }
})
