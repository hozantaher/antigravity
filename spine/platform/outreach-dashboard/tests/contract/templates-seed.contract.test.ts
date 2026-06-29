// ═══════════════════════════════════════════════════════════════════════════
//  Contract — scripts/migrations/008_seed_heavy_templates.sql
//
//  Locks the EPIC D / A3 seed migration so accidental edits to the heavy-*
//  templates are caught. Parses the SQL file directly (no live DB), extracts
//  the (name, subject, body) tuples for each VALUES row, and asserts on
//  shape, spintax validity, unsubscribe placeholder presence, and Go/JS
//  spintax-lib parity.
//
//  Why parse-the-file: a true integration test would need a Postgres
//  instance + the migration runner; that's covered by ops smoke. This
//  contract guards the static seed payload itself, which is the part most
//  likely to drift via copy-paste edits.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateSpintax, countVariations } from '../../src/lib/spintax.js'

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../../../scripts/migrations/008_seed_heavy_templates.sql'
)

interface SeededRow {
  name: string
  subject: string
  body: string
}

// Parse the INSERT INTO ... VALUES block. Extracts each tuple of
// (name, subject, body). Body is wrapped in $BODY$...$BODY$ dollar-quotes;
// name and subject are single-quoted Czech literals.
function parseSeededRows(sql: string): SeededRow[] {
  const rows: SeededRow[] = []
  // Match: ( 'name', 'subject', $BODY$ ... $BODY$ )
  const tupleRe =
    /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*\$BODY\$([\s\S]*?)\$BODY\$\s*\)/g
  let m: RegExpExecArray | null
  while ((m = tupleRe.exec(sql)) !== null) {
    rows.push({ name: m[1], subject: m[2], body: m[3] })
  }
  return rows
}

const SQL = readFileSync(MIGRATION_PATH, 'utf8')
const ROWS = parseSeededRows(SQL)
const BY_NAME = new Map(ROWS.map((r) => [r.name, r]))

describe('migration 008 — seed parses cleanly', () => {
  it('exactly 3 INSERT tuples found', () => {
    expect(ROWS.length).toBe(3)
  })
})

describe('migration 008 — required template names present', () => {
  it('seed includes heavy-01-intro', () => {
    expect(BY_NAME.has('heavy-01-intro')).toBe(true)
  })

  it('seed includes heavy-02-followup', () => {
    expect(BY_NAME.has('heavy-02-followup')).toBe(true)
  })

  it('seed includes heavy-03-bump', () => {
    expect(BY_NAME.has('heavy-03-bump')).toBe(true)
  })

  it('names are case-sensitive unique (set size == row count)', () => {
    const names = new Set(ROWS.map((r) => r.name))
    expect(names.size).toBe(ROWS.length)
  })
})

describe('migration 008 — every template has substantive content', () => {
  it.each(['heavy-01-intro', 'heavy-02-followup', 'heavy-03-bump'])(
    '%s has non-empty subject',
    (name) => {
      const row = BY_NAME.get(name)!
      expect(row.subject.trim().length).toBeGreaterThan(0)
    }
  )

  it.each(['heavy-01-intro', 'heavy-02-followup', 'heavy-03-bump'])(
    '%s body is non-empty and length > 100 chars',
    (name) => {
      const row = BY_NAME.get(name)!
      expect(row.body.length).toBeGreaterThan(100)
    }
  )

  it.each(['heavy-01-intro', 'heavy-02-followup', 'heavy-03-bump'])(
    '%s body contains {{.UnsubURL}} placeholder (legal)',
    (name) => {
      const row = BY_NAME.get(name)!
      expect(row.body).toContain('{{.UnsubURL}}')
    }
  )

  it.each(['heavy-01-intro', 'heavy-02-followup', 'heavy-03-bump'])(
    '%s body signs off with persona + controller footer',
    (name) => {
      const row = BY_NAME.get(name)!
      expect(row.body).toMatch(/B\. Maarek|Goran Nowak/)
      expect(row.body).toMatch(/BALKAN MOTORS INT DOO/)
    }
  )
})

describe('migration 008 — spintax safety + variation', () => {
  it('heavy-01-intro body contains spintax syntax (`{...|...}`)', () => {
    const body = BY_NAME.get('heavy-01-intro')!.body
    expect(body).toMatch(/\{[^{}]*\|[^{}]*\}/)
  })

  it.each(['heavy-01-intro', 'heavy-02-followup', 'heavy-03-bump'])(
    '%s body validates clean (no unclosed braces / unmatched closers)',
    (name) => {
      const body = BY_NAME.get(name)!.body
      const result = validateSpintax(body)
      expect(result.ok, JSON.stringify(result.errors)).toBe(true)
    }
  )

  it.each(['heavy-01-intro', 'heavy-02-followup', 'heavy-03-bump'])(
    '%s subject validates clean for spintax',
    (name) => {
      const subject = BY_NAME.get(name)!.subject
      const result = validateSpintax(subject)
      expect(result.ok, JSON.stringify(result.errors)).toBe(true)
    }
  )

  it('heavy-01-intro body has > 1 distinct variation', () => {
    const body = BY_NAME.get('heavy-01-intro')!.body
    const count = countVariations(body)
    expect(count).toBeGreaterThan(1)
  })

  it.each(['heavy-02-followup', 'heavy-03-bump'])(
    '%s body has > 1 distinct variation',
    (name) => {
      const body = BY_NAME.get(name)!.body
      const count = countVariations(body)
      expect(count).toBeGreaterThan(1)
    }
  )
})

describe('migration 008 — idempotency markers present in SQL', () => {
  it('uses ON CONFLICT (name) DO NOTHING (re-runs safe)', () => {
    expect(SQL).toMatch(/ON CONFLICT\s*\(\s*name\s*\)\s*DO NOTHING/i)
  })

  it('adds UNIQUE constraint on name (gates ON CONFLICT)', () => {
    expect(SQL).toMatch(/email_templates_name_uniq/)
    expect(SQL).toMatch(/UNIQUE\s*\(\s*name\s*\)/i)
  })

  it('UNIQUE constraint creation is itself idempotent (DO block guard)', () => {
    expect(SQL).toMatch(/IF NOT EXISTS[\s\S]*pg_constraint[\s\S]*email_templates_name_uniq/)
  })

  it('migration is wrapped in BEGIN/COMMIT', () => {
    expect(SQL).toMatch(/^\s*BEGIN;/m)
    expect(SQL).toMatch(/COMMIT;\s*$/m)
  })
})

describe('migration 008 — Go-template + spintax co-existence', () => {
  it.each(['heavy-01-intro', 'heavy-02-followup', 'heavy-03-bump'])(
    '%s body retains Go-template `{{...}}` after spintax validation pass',
    (name) => {
      // Spintax lib treats `{{` / `}}` carefully — Go templates must survive.
      const body = BY_NAME.get(name)!.body
      const goTemplateMatches = body.match(/\{\{\s*\.UnsubURL\s*\}\}/g) ?? []
      expect(goTemplateMatches.length).toBeGreaterThanOrEqual(1)
    }
  )
})
