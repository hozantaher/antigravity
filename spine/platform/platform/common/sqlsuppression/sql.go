// Package sqlsuppression holds the canonical SQL fragment that surfaces
// the union of the system's two suppression tables. It exists to stop
// drift between callers — every send-time / pre-send / preflight gate
// that asks "is this email suppressed?" must consult both tables
// (memory: project_two_suppression_tables.md), and copy-pasted SQL has
// historically dropped one side or the other (commit e000fb9 fixed the
// runner-side variant of that bug).
//
// Two suppression tables exist because the system grew two parallel
// surfaces:
//
//   - outreach_suppressions — written by Go (reply classifier,
//     unsubscribe, bounce cascade) via contacts/enrichment.SuppressEmail.
//   - suppression_list      — written by JS/BFF (manual ops UI add,
//     server.js bounce hooks) under apps/outreach-dashboard/server.js.
//
// Filtering only one would silently drop the other half of the
// suppression vocabulary. Until the two tables are consolidated, every
// read-side call site shares this fragment as a last-line compliance
// gate. Both sides are normalized (lower+trim) so case/whitespace drift
// between writers cannot leak through.
//
// JS callers mirror this contract via
// apps/outreach-dashboard/src/lib/suppressionUnionSql.js — keep the two
// files in lock-step.
package sqlsuppression

import "strings"

// UnionSelect is the canonical inner SELECT that produces the
// normalized email set from both suppression tables. The result row
// shape is a single column: lower(trim(email)).
//
// Wrap in a subquery (or use it directly inside NOT IN) — never
// concatenate user input into the surrounding SQL.
const UnionSelect = `SELECT lower(trim(email)) FROM outreach_suppressions WHERE email IS NOT NULL
    UNION
    SELECT lower(trim(email)) FROM suppression_list WHERE email IS NOT NULL`

// NotInUnionWhere returns the canonical NOT-IN suppression filter with
// the column placeholder substituted. Use as a parenthesized boolean
// term in a WHERE clause.
//
// Example:
//
//	`SELECT id, email FROM contacts WHERE ` + sqlsuppression.NotInUnionWhere("email")
//
// The returned fragment is parameterless — `col` is interpolated as a
// literal SQL identifier, never as user input.
func NotInUnionWhere(col string) string {
	return `lower(trim(` + col + `)) NOT IN (
    ` + UnionSelect + `
)`
}

// CountUnionSQL is the canonical COUNT query against the union — used
// by preflight gates that need to confirm "the union is non-empty"
// without materializing the full set.
const CountUnionSQL = `SELECT COUNT(*)::int FROM (
    ` + UnionSelect + `
) AS u`

// EnsureContainsBothTables is a discipline helper for tests: returns
// true iff `sql` references both suppression tables and contains a
// UNION between them. The runner / preflight discipline tests use this
// to keep accidental refactors from dropping one side.
//
// Not used in production — tests only.
func EnsureContainsBothTables(sql string) bool {
	if !strings.Contains(sql, "outreach_suppressions") {
		return false
	}
	if !strings.Contains(sql, "suppression_list") {
		return false
	}
	if !strings.Contains(sql, "UNION") {
		return false
	}
	return true
}
