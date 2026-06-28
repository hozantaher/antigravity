import { describe, test, expect } from 'vitest'
import {
  suppressionExistsFor,
  SUPPRESSION_LOOKUP_SQL,
} from '../../../src/lib/suppressionFilter.js'

describe('suppressionExistsFor', () => {
  // Discipline test: the BFF helper must reference BOTH tables, mirroring
  // the Go runner's UNION filter (features/outreach/campaigns/campaign/runner.go
  // suppressionFilterSQL). Removing either side silently leaks
  // suppressed addresses through pre-send / display gates.
  test('emits EXISTS subqueries for both suppression tables', () => {
    const got = suppressionExistsFor('c.email')
    expect(got).toMatch(/outreach_suppressions/)
    expect(got).toMatch(/suppression_list/)
    // Must be an OR-of-EXISTS, not a single AND — otherwise an entry in
    // only one table is invisible to this gate.
    expect(got).toMatch(/EXISTS\s*\(/)
    expect(got.match(/EXISTS\s*\(/g)?.length).toBe(2)
    expect(got).toMatch(/\bOR\b/)
  })

  test('normalizes case and whitespace on both sides', () => {
    const got = suppressionExistsFor('c.email')
    // LHS (the contact email) and RHS (each suppression table) must use
    // lower(trim(...)) — writers don't agree on case, and a missing
    // normalization on either side leaks suppressed entries.
    expect(got).toMatch(/lower\(trim\(c\.email\)\)/)
    expect(got).toMatch(/lower\(trim\(s\.email\)\)/)
    expect(got).toMatch(/lower\(trim\(sl\.email\)\)/)
  })

  test('substitutes the column placeholder', () => {
    for (const col of ['c.email', 'lower(c.email)', 'x.email']) {
      const got = suppressionExistsFor(col)
      expect(got).not.toContain('{col}')
      expect(got).toContain(col)
    }
  })

  test('replaces every {col} occurrence', () => {
    const got = suppressionExistsFor('c.email')
    // The fragment uses {col} 3 times (twice on the LHS in two EXISTS
    // subqueries, plus the canonical declaration). Make sure none leak
    // through.
    expect(got).not.toContain('{')
    expect(got).not.toContain('}')
  })
})

describe('SUPPRESSION_LOOKUP_SQL', () => {
  test('unions both suppression tables', () => {
    expect(SUPPRESSION_LOOKUP_SQL).toMatch(/outreach_suppressions/)
    expect(SUPPRESSION_LOOKUP_SQL).toMatch(/suppression_list/)
    expect(SUPPRESSION_LOOKUP_SQL).toMatch(/UNION/)
  })

  test('uses parameterized $1 — never string concatenation', () => {
    // The lookup must be parameterized to prevent SQL injection. The
    // canonical fragment uses $1 as the only bind site.
    expect(SUPPRESSION_LOOKUP_SQL).toMatch(/\$1/)
    expect(SUPPRESSION_LOOKUP_SQL).not.toMatch(/\$\{/)
  })

  test('normalizes the parameter via lower(trim($1))', () => {
    // Otherwise " Foo@Bar.cz " would miss "foo@bar.cz" stored after
    // SuppressEmail's normalization.
    expect(SUPPRESSION_LOOKUP_SQL).toMatch(/lower\(trim\(\$1\)\)/)
  })

  test('caps result with LIMIT 1 — pre-send gate is existence check', () => {
    expect(SUPPRESSION_LOOKUP_SQL).toMatch(/LIMIT 1/)
  })
})
