// ═══════════════════════════════════════════════════════════════════════════
//  crmExport.test.js — unit tests for CRM export utilities
//
//  Test IDs: CE-001 .. CE-030
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest'
import {
  CRM_EXPORT_HEADERS,
  crmRowToCsvFields,
  escapeCsvField,
  buildCsvString,
  exportFilename,
} from '../../../src/lib/crmExport.js'

// ── CRM_EXPORT_HEADERS ────────────────────────────────────────────────────────

describe('CE-001..CE-003: CRM_EXPORT_HEADERS', () => {
  it('CE-001: headers is an array with 8 elements', () => {
    expect(CRM_EXPORT_HEADERS).toHaveLength(8)
  })
  it('CE-002: first header is "Jméno"', () => {
    expect(CRM_EXPORT_HEADERS[0]).toBe('Jméno')
  })
  it('CE-003: last header is "Kontakty"', () => {
    expect(CRM_EXPORT_HEADERS[7]).toBe('Kontakty')
  })
})

// ── crmRowToCsvFields ─────────────────────────────────────────────────────────

describe('CE-004..CE-012: crmRowToCsvFields()', () => {
  const fullRow = {
    name: 'TechCorp s.r.o.',
    ico: '12345678',
    email_primary: 'a@b.cz',
    crm_status: 'Aktuální',
    crm_relationship: 'Aktivní',
    owner_email: 'o@f.cz',
    linked_companies: 3,
    linked_contacts: 7,
  }

  it('CE-004: returns 8-element array', () => {
    expect(crmRowToCsvFields(fullRow)).toHaveLength(8)
  })
  it('CE-005: name is first field', () => {
    expect(crmRowToCsvFields(fullRow)[0]).toBe('TechCorp s.r.o.')
  })
  it('CE-006: ico is second field', () => {
    expect(crmRowToCsvFields(fullRow)[1]).toBe('12345678')
  })
  it('CE-007: email_primary is third field', () => {
    expect(crmRowToCsvFields(fullRow)[2]).toBe('a@b.cz')
  })
  it('CE-008: null email_primary → empty string', () => {
    expect(crmRowToCsvFields({ ...fullRow, email_primary: null })[2]).toBe('')
  })
  it('CE-009: linked_companies as string', () => {
    expect(crmRowToCsvFields(fullRow)[6]).toBe('3')
  })
  it('CE-010: linked_contacts as string', () => {
    expect(crmRowToCsvFields(fullRow)[7]).toBe('7')
  })
  it('CE-011: undefined linked_companies → "0"', () => {
    const row = { ...fullRow, linked_companies: undefined }
    expect(crmRowToCsvFields(row)[6]).toBe('0')
  })
  it('CE-012: null owner_email → empty string', () => {
    expect(crmRowToCsvFields({ ...fullRow, owner_email: null })[5]).toBe('')
  })
})

// ── escapeCsvField ────────────────────────────────────────────────────────────

describe('CE-013..CE-020: escapeCsvField()', () => {
  it('CE-013: plain string unchanged', () => {
    expect(escapeCsvField('hello')).toBe('hello')
  })
  it('CE-014: null → empty string', () => {
    expect(escapeCsvField(null)).toBe('')
  })
  it('CE-015: undefined → empty string', () => {
    expect(escapeCsvField(undefined)).toBe('')
  })
  it('CE-016: comma → wrapped in quotes', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
  })
  it('CE-017: double quote → escaped as ""', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
  })
  it('CE-018: newline → wrapped in quotes', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
  })
  it('CE-019: carriage return → wrapped in quotes', () => {
    expect(escapeCsvField('a\rb')).toBe('"a\rb"')
  })
  it('CE-020: empty string → empty string', () => {
    expect(escapeCsvField('')).toBe('')
  })
})

// ── buildCsvString ────────────────────────────────────────────────────────────

describe('CE-021..CE-026: buildCsvString()', () => {
  const rows = [
    { name: 'Firma A', ico: '111', email_primary: 'a@a.cz', crm_status: 'Aktuální', crm_relationship: 'Aktivní', owner_email: null, linked_companies: 1, linked_contacts: 2 },
    { name: 'Firma B', ico: '222', email_primary: null, crm_status: 'Potenciální', crm_relationship: 'Nový', owner_email: 'x@y.cz', linked_companies: 0, linked_contacts: 0 },
  ]

  it('CE-021: first line is the header row', () => {
    const csv = buildCsvString(rows)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(CRM_EXPORT_HEADERS.map(h => escapeCsvField(h)).join(','))
  })

  it('CE-022: has header + 2 data lines = 3 lines total', () => {
    const csv = buildCsvString(rows)
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(3)
  })

  it('CE-023: second line contains first row data', () => {
    const csv = buildCsvString(rows)
    const lines = csv.split('\r\n')
    expect(lines[1]).toContain('Firma A')
    expect(lines[1]).toContain('111')
  })

  it('CE-024: empty row list → only header line', () => {
    const csv = buildCsvString([])
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(1)
  })

  it('CE-025: uses CRLF line endings', () => {
    const csv = buildCsvString(rows)
    expect(csv).toContain('\r\n')
  })

  it('CE-026: custom headers override default', () => {
    const csv = buildCsvString(rows, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
    expect(csv.split('\r\n')[0]).toBe('A,B,C,D,E,F,G,H')
  })
})

// ── exportFilename ────────────────────────────────────────────────────────────

describe('CE-027..CE-030: exportFilename()', () => {
  it('CE-027: ends in .csv', () => {
    expect(exportFilename()).toMatch(/\.csv$/)
  })
  it('CE-028: contains date in YYYY-MM-DD format', () => {
    expect(exportFilename()).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
  it('CE-029: custom prefix is used', () => {
    expect(exportFilename('my-data')).toMatch(/^my-data-/)
  })
  it('CE-030: default prefix is "crm-export"', () => {
    expect(exportFilename()).toMatch(/^crm-export-/)
  })
})
