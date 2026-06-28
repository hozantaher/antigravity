// Tests for the canonical JS-side suppression UNION SQL fragment.
// Mirrors features/platform/common/sqlsuppression/sql_test.go on the Go side.
//
// Two suppression tables exist (memory: project_two_suppression_tables.md):
//   - outreach_suppressions — Go-side writers
//   - suppression_list      — JS/BFF writers
//
// Any read site that drops one side leaks suppressed addresses through
// the gate. These tests are the JS-side ratchet against accidental
// regression during refactor.

import { describe, test, expect } from 'vitest'
import {
  SUPPRESSION_UNION_SELECT_SQL,
  SUPPRESSION_COUNT_UNION_SQL,
  notInUnionWhere,
} from '../../../src/lib/suppressionUnionSql.js'

describe('SUPPRESSION_UNION_SELECT_SQL', () => {
  test('references both suppression tables', () => {
    expect(SUPPRESSION_UNION_SELECT_SQL).toMatch(/outreach_suppressions/)
    expect(SUPPRESSION_UNION_SELECT_SQL).toMatch(/suppression_list/)
  })

  test('contains UNION between the two SELECTs', () => {
    expect(SUPPRESSION_UNION_SELECT_SQL).toMatch(/UNION/)
  })

  test('normalizes both sides via lower(trim(email))', () => {
    const matches = SUPPRESSION_UNION_SELECT_SQL.match(/lower\(trim\(email\)\)/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  test('filters NULL emails on both sides', () => {
    const matches = SUPPRESSION_UNION_SELECT_SQL.match(/email IS NOT NULL/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  test('does not contain template placeholders', () => {
    expect(SUPPRESSION_UNION_SELECT_SQL).not.toContain('{')
    expect(SUPPRESSION_UNION_SELECT_SQL).not.toContain('}')
  })

  test('does not contain bind parameters — pure SELECT, parameterless', () => {
    // The inner SELECT is just the data source; bind sites belong to
    // outer wrappers (NOT IN with the candidate, EXISTS with the bind).
    expect(SUPPRESSION_UNION_SELECT_SQL).not.toMatch(/\$\d/)
  })
})

describe('SUPPRESSION_COUNT_UNION_SQL', () => {
  test('contains COUNT(*) aggregator', () => {
    expect(SUPPRESSION_COUNT_UNION_SQL).toMatch(/COUNT\(\*\)/)
  })

  test('inlines the UNION fragment so both tables are unioned', () => {
    expect(SUPPRESSION_COUNT_UNION_SQL).toMatch(/outreach_suppressions/)
    expect(SUPPRESSION_COUNT_UNION_SQL).toMatch(/suppression_list/)
    expect(SUPPRESSION_COUNT_UNION_SQL).toMatch(/UNION/)
  })

  test('aliases the count as `n` so callers can read row.n consistently', () => {
    // campaignPreflight.js consumes r.rows[0].n — preserving that name
    // means the canonical refactor stays drop-in.
    expect(SUPPRESSION_COUNT_UNION_SQL).toMatch(/AS n/)
  })
})

describe('notInUnionWhere', () => {
  test('substitutes the column placeholder', () => {
    for (const col of ['c.email', 'lower(c.email)', 'x.email', 'email']) {
      const got = notInUnionWhere(col)
      expect(got).not.toContain('{col}')
      expect(got).toContain(col)
    }
  })

  test('emits NOT IN, not IN', () => {
    const got = notInUnionWhere('c.email')
    expect(got).toMatch(/NOT IN/)
  })

  test('normalizes the LHS column with lower(trim(...))', () => {
    const got = notInUnionWhere('c.email')
    expect(got).toMatch(/lower\(trim\(c\.email\)\)/)
  })

  test('returns a parenthesized subquery against both tables', () => {
    const got = notInUnionWhere('c.email')
    expect(got).toMatch(/outreach_suppressions/)
    expect(got).toMatch(/suppression_list/)
    expect(got).toMatch(/UNION/)
  })

  test('different columns produce distinct, non-shared SQL', () => {
    const a = notInUnionWhere('c.email')
    const b = notInUnionWhere('x.email')
    expect(a).not.toBe(b)
    expect(a).toContain('c.email')
    expect(a).not.toContain('x.email')
    expect(b).toContain('x.email')
    expect(b).not.toContain('c.email')
  })
})
