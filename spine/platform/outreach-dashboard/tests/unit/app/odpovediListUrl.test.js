/**
 * Odpovedi listUrlFor — the view-mode → query-string mapping that drives the
 * hot-lead triage lane. The 'hot' lane is the business-critical one: it must
 * fetch unhandled "zájem" replies OLDEST-FIRST so the coldest-going hot lead
 * (prod 2026-06-01: oldest unhandled positive ~18 days) sits at the top.
 */

import { describe, it, expect } from 'vitest'
import { listUrlFor } from '../../../src/app/pages/Odpovedi'

describe('listUrlFor', () => {
  it('hot mode → unhandled positive, oldest-first', () => {
    const u = listUrlFor('hot')
    expect(u).toContain('handled=false')
    expect(u).toContain('classification=positive')
    expect(u).toContain('sort=received')
    expect(u).toContain('dir=asc')
  })

  it('unhandled (default) → open replies, no classification filter', () => {
    const u = listUrlFor('unhandled')
    expect(u).toContain('handled=false')
    expect(u).not.toContain('classification=')
    expect(u).not.toContain('dir=asc')
  })

  it('phone mode → unhandled with-phone, oldest-first call queue (#1578 M1)', () => {
    const u = listUrlFor('phone')
    expect(u).toContain('handled=false')
    expect(u).toContain('has_phone=true')
    expect(u).toContain('sort=received')
    expect(u).toContain('dir=asc')
  })

  it('flagged mode → flagged=true', () => {
    expect(listUrlFor('flagged')).toContain('flagged=true')
  })

  it('all mode → no handled filter (full archive)', () => {
    const u = listUrlFor('all')
    expect(u).not.toContain('handled=')
    expect(u).not.toContain('classification=')
  })

  it('unknown mode falls back to the unhandled view', () => {
    expect(listUrlFor('garbage')).toBe(listUrlFor('unhandled'))
  })
})
