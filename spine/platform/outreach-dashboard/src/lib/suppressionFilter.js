// Canonical SQL fragments for filtering against the system's two
// suppression tables. Mirrors the Go runner's suppressionFilterFor helper
// (services/campaigns/campaign/runner.go) and the canonical Go fragment
// in services/common/sqlsuppression/sql.go. The shared inner UNION SELECT
// is re-exported from src/lib/suppressionUnionSql.js so JS callsites can
// share one source of truth (campaignPreflight.js, server.js).
//
// Two tables hold suppressions in this system:
//   - outreach_suppressions — written by Go (reply classifier, bounce
//     cascade, manual Go-side ops).
//   - suppression_list      — written by JS/BFF (manual ops UI add,
//     server.js bounce hooks).
//
// Any SELECT that surfaces "is this email suppressed?" or filters
// outbound sends MUST consult both. Querying only one silently drops the
// other half of the suppression vocabulary — see commit e000fb9 for the
// runner-side fix and commit history around this file for the BFF side.

// Matches a single email against both tables. {col} is the column on the
// outer SELECT that holds the candidate email.
const SUPPRESSION_EXISTS_SQL = `EXISTS (
  SELECT 1 FROM outreach_suppressions s
   WHERE s.email IS NOT NULL
     AND lower(trim(s.email)) = lower(trim({col}))
) OR EXISTS (
  SELECT 1 FROM suppression_list sl
   WHERE sl.email IS NOT NULL
     AND lower(trim(sl.email)) = lower(trim({col}))
)`

// Returns the EXISTS-OR-EXISTS subquery with the column placeholder
// substituted. Use as a parenthesized expression — callers wrap with
// `(suppressionExistsFor('c.email'))` if they need it as a boolean term in
// a WHERE clause.
export function suppressionExistsFor(col) {
  return SUPPRESSION_EXISTS_SQL.replaceAll('{col}', col)
}

// Set-form query: SELECT 1 WHERE the parameter is in either suppression
// table. Use for pre-send gates that take a single email parameter.
// Always parameterized — callers pass the email as a bind value. Re-uses
// the canonical inner UNION but applies a local `AS email` alias so the
// outer WHERE can reference `s.email` (the inner SELECT in
// suppressionUnionSql.js intentionally returns a single anonymous column
// because most NOT-IN / COUNT call sites don't need to name it).
export const SUPPRESSION_LOOKUP_SQL = `
  SELECT 1
    FROM (
      SELECT lower(trim(email)) AS email FROM outreach_suppressions WHERE email IS NOT NULL
      UNION
      SELECT lower(trim(email)) AS email FROM suppression_list      WHERE email IS NOT NULL
    ) s
   WHERE s.email = lower(trim($1))
   LIMIT 1`
