// suppressionUnionSql.js — canonical SQL fragments that surface the
// union of the system's two suppression tables. Mirrors
// services/common/sqlsuppression/sql.go on the Go side.
//
// Two suppression tables exist (memory: project_two_suppression_tables.md):
//   - outreach_suppressions — Go-side (reply classifier, bounce cascade,
//     unsubscribe writes) via contacts/enrichment.SuppressEmail.
//   - suppression_list      — JS BFF (manual ops UI add, server.js bounce
//     hooks, /api/suppressions endpoints).
//
// Any SELECT that filters outbound sends or surfaces "is this email
// suppressed?" MUST consult both tables. Querying only one silently
// drops the other half of the suppression vocabulary — see commit
// e000fb9 for the runner-side regression that prompted this consolidation.
//
// Both sides are normalized (lower+trim) so case/whitespace drift between
// writers cannot leak through. Keep this file byte-for-byte aligned with
// the Go canonical — discipline tests rely on the surfaced SQL containing
// both table names + a UNION between them.

/**
 * Canonical inner SELECT producing the normalized email set from both
 * suppression tables. Single-column result: lower(trim(email)).
 *
 * Wrap in a subquery (or use directly inside a NOT IN) — never
 * concatenate user input into the surrounding SQL.
 *
 * @type {string}
 */
export const SUPPRESSION_UNION_SELECT_SQL =
  `SELECT lower(trim(email)) FROM outreach_suppressions WHERE email IS NOT NULL
      UNION
      SELECT lower(trim(email)) FROM suppression_list      WHERE email IS NOT NULL`

/**
 * Canonical NOT-IN suppression filter with the column placeholder
 * substituted. Returns a parenthesized boolean fragment for use inside
 * a WHERE clause.
 *
 *   `SELECT id, email FROM contacts WHERE ${notInUnionWhere('email')}`
 *
 * The returned fragment is parameterless — `col` is interpolated as a
 * literal SQL identifier, never as user input.
 *
 * @param {string} col
 * @returns {string}
 */
export function notInUnionWhere(col) {
  return `lower(trim(${col})) NOT IN (
    ${SUPPRESSION_UNION_SELECT_SQL}
)`
}

/**
 * Canonical COUNT query against the union — used by preflight gates
 * that need to confirm "the union is non-empty" without materializing
 * the full set.
 *
 * @type {string}
 */
export const SUPPRESSION_COUNT_UNION_SQL = `SELECT COUNT(*)::int AS n FROM (
        ${SUPPRESSION_UNION_SELECT_SQL}
      ) s`
