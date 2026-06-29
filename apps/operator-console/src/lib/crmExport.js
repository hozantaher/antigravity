/**
 * crmExport.js — Excel/CSV export helpers for CRM Clients page.
 *
 * Pure functions only — no side effects, no DOM access.
 * The actual download trigger (createObjectURL / click) belongs to the
 * UI layer; these functions produce the data.
 *
 * Usage:
 *   const csv = buildCsvString(rows, headers)
 *   downloadCsv(csv, 'crm-export.csv')
 */

/**
 * CSV column headers for the CRM clients export.
 */
export const CRM_EXPORT_HEADERS = [
  'Jméno',
  'IČO',
  'Email',
  'Stav CRM',
  'Vztah',
  'Vlastník',
  'Firmy',
  'Kontakty',
]

/**
 * Convert a single CRM client row to a CSV field array.
 * Null / undefined fields become empty strings.
 *
 * @param {object} row
 * @returns {string[]} ordered array matching CRM_EXPORT_HEADERS
 */
export function crmRowToCsvFields(row) {
  return [
    row?.name            ?? '',
    row?.ico             ?? '',
    row?.email_primary   ?? '',
    row?.crm_status      ?? '',
    row?.crm_relationship ?? '',
    row?.owner_email     ?? '',
    String(row?.linked_companies ?? 0),
    String(row?.linked_contacts  ?? 0),
  ]
}

/**
 * Escape a single CSV field value.
 * Wraps in double-quotes if the value contains comma, double-quote, or newline.
 * Internal double-quotes are escaped as "".
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function escapeCsvField(value) {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Build a complete CSV string from rows and a header row.
 * Uses CRLF line endings (RFC 4180).
 *
 * @param {object[]} rows
 * @param {string[]} [headers]  defaults to CRM_EXPORT_HEADERS
 * @returns {string}
 */
export function buildCsvString(rows, headers = CRM_EXPORT_HEADERS) {
  const lines = []
  lines.push(headers.map(escapeCsvField).join(','))
  for (const row of rows) {
    lines.push(crmRowToCsvFields(row).map(escapeCsvField).join(','))
  }
  // RFC 4180: CRLF
  return lines.join('\r\n')
}

/**
 * Trigger a browser CSV download.
 * Safe to call: no-ops in non-browser environments.
 *
 * @param {string} csvString
 * @param {string} [filename]
 */
export function downloadCsv(csvString, filename = 'crm-export.csv') {
  if (typeof document === 'undefined') return
  const blob = new Blob(['﻿' + csvString], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Generate an export filename with current date stamp.
 *
 * @param {string} [prefix]
 * @returns {string} e.g. "crm-export-2026-05-05.csv"
 */
export function exportFilename(prefix = 'crm-export') {
  const d = new Date()
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${prefix}-${date}.csv`
}
