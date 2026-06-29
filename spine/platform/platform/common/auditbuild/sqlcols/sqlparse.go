package sqlcols

import (
	"regexp"
	"strings"
)

// ColumnRef is a single (table, column) reference extracted from a SQL
// fragment. The audit verifies each ref against the migration-derived
// schema.
//
// Origin records the syntactic shape we matched — kept for diagnostic
// output ("UPDATE campaign_contacts SET updated_at=...") and so the
// caller can decide whether to soften the rule for ambiguous shapes.
type ColumnRef struct {
	Table  string
	Column string
	Origin string
}

// ExtractColumnRefs walks a SQL fragment (one or more statements
// concatenated, semicolons optional) and returns every (table, column)
// pair it can identify with high confidence.
//
// We deliberately under-match: false negatives are tolerable (the
// scanner only enforces what it understands), false positives are not
// (they break developer trust + force reckless whitelisting).
//
// Recognised shapes:
//
//  1. INSERT INTO <table> ( <col>, <col>, ... )
//     Columns are unambiguous — the table is right there.
//
//  2. UPDATE <table> SET <col> = ..., <col> = ...
//     SET clause runs until the first WHERE / RETURNING / FROM.
//     Comma-separated assignments at depth 0.
//
//  3. SELECT <list> FROM <table>
//     Only when the column list contains NO function calls and NO
//     aliases that we cannot resolve. Plus, the FROM clause must name
//     a SINGLE table (no joins). When joins are present we bail out —
//     resolving aliases without a real parser is brittle.
//
// Anything else (WHERE clauses, JOIN ON, sub-SELECTs, CTEs) is
// intentionally skipped.
func ExtractColumnRefs(sql string) []ColumnRef {
	sql = stripBlockComments(sql)
	sql = stripLineComments(sql)
	var refs []ColumnRef
	refs = append(refs, extractInsertColumns(sql)...)
	refs = append(refs, extractUpdateColumns(sql)...)
	refs = append(refs, extractSelectFromColumns(sql)...)
	return refs
}

// stripLineComments removes `-- to end of line` comments. Block
// comments are handled separately by stripBlockComments in
// migrations.go.
func stripLineComments(s string) string {
	var out strings.Builder
	out.Grow(len(s))
	i := 0
	for i < len(s) {
		if i+1 < len(s) && s[i] == '-' && s[i+1] == '-' {
			// Skip until newline.
			for i < len(s) && s[i] != '\n' {
				i++
			}
			continue
		}
		out.WriteByte(s[i])
		i++
	}
	return out.String()
}

// reInsertInto captures `INSERT INTO <table> (<col-list>)`.
// The trailing `(...)` body is sliced via balanced-paren walk to be
// robust to parenthesised expressions inside the list.
var reInsertInto = regexp.MustCompile(
	`(?is)INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*\(`,
)

func extractInsertColumns(sql string) []ColumnRef {
	var out []ColumnRef
	for _, m := range reInsertInto.FindAllStringSubmatchIndex(sql, -1) {
		table := unqualify(sql[m[2]:m[3]])
		// m[1] points at the byte after the captured group plus the
		// trailing `(`. To find the open paren we step back.
		openIdx := -1
		for i := m[1] - 1; i >= m[3]; i-- {
			if sql[i] == '(' {
				openIdx = i
				break
			}
		}
		if openIdx < 0 {
			continue
		}
		body, ok := sliceBalancedParens(sql, openIdx)
		if !ok {
			continue
		}
		// Reject INSERT INTO foo SELECT ... — that is an INSERT without
		// an explicit column list and our regex would match a leading
		// "(" coming from the SELECT instead. The body of a real
		// column list contains only identifiers + commas + whitespace.
		if !isPlainColumnList(body) {
			continue
		}
		for _, raw := range splitTopLevelCommas(body) {
			col := strings.Trim(strings.TrimSpace(raw), `"`)
			if !looksLikeIdentifier(col) {
				continue
			}
			out = append(out, ColumnRef{
				Table:  table,
				Column: col,
				Origin: "INSERT INTO " + table + " (...)",
			})
		}
	}
	return out
}

// isPlainColumnList returns true when body is a comma-separated list
// of bare identifiers (allowing whitespace and quoted identifiers). If
// any other token appears (parenthesis, function, expression, asterisk,
// keyword like SELECT), we bail out so we don't fabricate references.
func isPlainColumnList(body string) bool {
	for _, raw := range splitTopLevelCommas(body) {
		col := strings.TrimSpace(raw)
		if col == "" {
			return false
		}
		col = strings.Trim(col, `"`)
		if !looksLikeIdentifier(col) {
			return false
		}
	}
	return strings.TrimSpace(body) != ""
}

// reUpdateTable captures `UPDATE <table> SET`.
var reUpdateTable = regexp.MustCompile(
	`(?is)\bUPDATE\s+(?:ONLY\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?\s+SET\b`,
)

// reUpdateBoundary identifies the keywords at depth 0 that terminate
// the SET clause.
var reUpdateBoundary = regexp.MustCompile(
	`(?is)\b(WHERE|RETURNING|FROM)\b`,
)

func extractUpdateColumns(sql string) []ColumnRef {
	var out []ColumnRef
	for _, m := range reUpdateTable.FindAllStringSubmatchIndex(sql, -1) {
		table := unqualify(sql[m[2]:m[3]])
		alias := ""
		if m[4] >= 0 && m[5] >= 0 {
			alias = sql[m[4]:m[5]]
			// Common false positive: `UPDATE contacts SET ...` —
			// the regex thinks "SET" is the alias when followed by
			// whitespace, but the word boundary + literal `\s+SET\b`
			// at the tail of the regex prevents that. Defensive check
			// in case of unforeseen shapes:
			if strings.EqualFold(alias, "set") {
				alias = ""
			}
		}
		setStart := m[1] // first byte after `SET`
		// Find the boundary keyword at depth 0.
		setEnd := findUpdateSetEnd(sql, setStart)
		setBody := sql[setStart:setEnd]
		for _, assign := range splitTopLevelCommas(setBody) {
			col, ok := firstAssignmentTarget(assign, alias, table)
			if !ok {
				continue
			}
			if !looksLikeIdentifier(col) {
				continue
			}
			out = append(out, ColumnRef{
				Table:  table,
				Column: col,
				Origin: "UPDATE " + table + " SET ...",
			})
		}
	}
	return out
}

// findUpdateSetEnd walks the bytes after `UPDATE foo SET` and returns
// the index of the first WHERE/RETURNING/FROM at depth 0, or end of
// string when none is found.
func findUpdateSetEnd(sql string, start int) int {
	if start >= len(sql) {
		return start
	}
	rest := sql[start:]
	idx := 0
	for idx < len(rest) {
		// Find the next candidate boundary keyword.
		loc := reUpdateBoundary.FindStringIndex(rest[idx:])
		if loc == nil {
			return len(sql)
		}
		absStart := start + idx + loc[0]
		// Verify depth 0 at absStart.
		if depthAt(sql, start, absStart) == 0 {
			return absStart
		}
		idx += loc[1]
	}
	return len(sql)
}

// depthAt computes the parenthesis depth at index target counted from
// origin (skipping single- and double-quoted strings). Used to confirm
// boundary keywords like WHERE are not nested inside a function call.
func depthAt(s string, origin, target int) int {
	depth := 0
	inSingle := false
	inDouble := false
	for i := origin; i < target; i++ {
		c := s[i]
		switch {
		case inSingle:
			if c == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
					continue
				}
				inSingle = false
			}
		case inDouble:
			if c == '"' {
				inDouble = false
			}
		default:
			switch c {
			case '\'':
				inSingle = true
			case '"':
				inDouble = true
			case '(':
				depth++
			case ')':
				if depth > 0 {
					depth--
				}
			}
		}
	}
	return depth
}

// firstAssignmentTarget pulls the column name out of a single SET
// assignment. Accepts:
//
//	col = expr
//	"col" = expr
//	alias.col = expr   (only when alias matches the UPDATE alias / table)
//	(col_a, col_b) = (expr_a, expr_b)   — not yet handled, returns false
//
// The lhs is taken to be everything before the first top-level `=`.
func firstAssignmentTarget(assign, alias, table string) (string, bool) {
	eq := indexTopLevel(assign, '=')
	if eq < 0 {
		return "", false
	}
	lhs := strings.TrimSpace(assign[:eq])
	// Multi-column assignment — bail.
	if strings.HasPrefix(lhs, "(") {
		return "", false
	}
	lhs = strings.Trim(lhs, `"`)
	// Strip an optional alias / table prefix.
	if i := strings.IndexByte(lhs, '.'); i >= 0 {
		prefix := lhs[:i]
		col := lhs[i+1:]
		// Only accept the prefix when it matches the alias OR the table
		// name. Anything else (e.g. UPDATE … SET other_table.col=…) is
		// ambiguous and intentionally skipped.
		if alias != "" && strings.EqualFold(prefix, alias) {
			return strings.Trim(col, `"`), true
		}
		if strings.EqualFold(prefix, table) {
			return strings.Trim(col, `"`), true
		}
		return "", false
	}
	return lhs, lhs != ""
}

// indexTopLevel returns the byte index of the first occurrence of c at
// parenthesis depth 0, ignoring single- and double-quoted strings. -1
// when no such occurrence exists.
func indexTopLevel(s string, c byte) int {
	depth := 0
	inSingle := false
	inDouble := false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case inSingle:
			if ch == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
					continue
				}
				inSingle = false
			}
		case inDouble:
			if ch == '"' {
				inDouble = false
			}
		default:
			switch ch {
			case '\'':
				inSingle = true
			case '"':
				inDouble = true
			case '(':
				depth++
			case ')':
				if depth > 0 {
					depth--
				}
			default:
				if ch == c && depth == 0 {
					return i
				}
			}
		}
	}
	return -1
}

// reSelectFrom captures `SELECT <list> FROM <table>`. We only handle
// the plain shape where the list contains no function calls and the
// FROM clause contains a single table (no JOINs, no sub-SELECT).
var reSelectFrom = regexp.MustCompile(
	`(?is)\bSELECT\s+([\s\S]+?)\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_.]*)\b([\s\S]*)`,
)

func extractSelectFromColumns(sql string) []ColumnRef {
	// FindAllStringSubmatchIndex with the non-greedy SELECT + FROM
	// regex above is awkward — multiple SELECTs inside the same Go
	// string literal need separate matches. Walk by index instead.
	var out []ColumnRef
	rest := sql
	for {
		m := reSelectFrom.FindStringSubmatchIndex(rest)
		if m == nil {
			break
		}
		list := rest[m[2]:m[3]]
		table := unqualify(rest[m[4]:m[5]])
		tail := rest[m[6]:m[7]]
		// Reject when the FROM clause is followed by JOIN or a comma
		// (multi-table FROM list). Without alias resolution the
		// (table, column) attribution would be wrong.
		trimmedTail := strings.TrimLeft(tail, " \t\n\r")
		if hasJoinOrCommaImmediate(trimmedTail) {
			rest = rest[m[1]:]
			continue
		}
		if cols, ok := parsePlainSelectList(list); ok {
			for _, c := range cols {
				out = append(out, ColumnRef{
					Table:  table,
					Column: c,
					Origin: "SELECT ... FROM " + table,
				})
			}
		}
		rest = rest[m[1]:]
	}
	return out
}

// hasJoinOrCommaImmediate reports whether s starts with (or, after a
// single optional alias word, contains) a JOIN keyword or a comma at
// the FROM clause's first non-whitespace token. Such shapes mean the
// FROM clause references more than one table; we cannot attribute
// columns to a single table without alias resolution.
//
// Examples that return true:
//
//	"JOIN bar ON ..."          → immediate JOIN
//	"c JOIN bar ON ..."        → alias `c`, then JOIN
//	"AS c JOIN bar ON ..."     → AS-alias, then JOIN
//	", bar"                    → comma-list FROM
func hasJoinOrCommaImmediate(s string) bool {
	upper := strings.ToUpper(strings.TrimLeft(s, " \t\n\r"))
	if upper == "" {
		return false
	}
	if upper[0] == ',' {
		return true
	}
	tokens := strings.Fields(upper)
	if len(tokens) == 0 {
		return false
	}
	// Walk the leading non-keyword identifiers (the optional alias)
	// and then look at what comes after.
	idx := 0
	if tokens[idx] == "AS" && len(tokens) > idx+1 {
		idx += 2 // skip "AS <alias>"
	} else if isJoinKeyword(tokens[idx]) || tokens[idx] == "," {
		// Already a JOIN/comma — handled below.
	} else if !isFromTrailerKeyword(tokens[idx]) {
		// Treat as a bare alias word; skip it.
		idx++
	}
	if idx >= len(tokens) {
		return false
	}
	if tokens[idx] == "," {
		return true
	}
	if isJoinKeyword(tokens[idx]) {
		return true
	}
	return false
}

// isJoinKeyword reports whether tok (already uppercased) opens a JOIN
// clause.
func isJoinKeyword(tok string) bool {
	switch tok {
	case "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL":
		return true
	}
	return false
}

// isFromTrailerKeyword identifies tokens that follow the FROM table
// without introducing a join: WHERE, GROUP, ORDER, LIMIT, etc. When
// the token is a trailer keyword we know the FROM clause has only one
// table and the SELECT list is safe to attribute.
func isFromTrailerKeyword(tok string) bool {
	switch tok {
	case "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET",
		"FOR", "UNION", "INTERSECT", "EXCEPT", "RETURNING", "WINDOW", ";":
		return true
	}
	return false
}

// parsePlainSelectList tries to parse a SELECT projection list as a
// flat list of bare column references. Returns ok=false when any
// element looks like a function call, expression, alias-rename,
// asterisk, or DISTINCT marker — the audit only flags what it can
// resolve unambiguously.
func parsePlainSelectList(list string) ([]string, bool) {
	list = strings.TrimSpace(list)
	if list == "" {
		return nil, false
	}
	// DISTINCT / DISTINCT ON (..) — bail.
	upper := strings.ToUpper(list)
	if strings.HasPrefix(upper, "DISTINCT") {
		return nil, false
	}
	if strings.Contains(list, "*") {
		return nil, false
	}
	var cols []string
	for _, raw := range splitTopLevelCommas(list) {
		item := strings.TrimSpace(raw)
		if item == "" {
			return nil, false
		}
		// AS / alias — keep only the LHS column reference.
		// `c.col AS x` → "c.col"; `expr AS x` → reject expr because
		// expressions aren't bare column refs.
		if i := indexAliasKeyword(item); i >= 0 {
			item = strings.TrimSpace(item[:i])
		}
		// Reject parenthesised expressions, function calls, casts.
		if strings.ContainsAny(item, "()+-*/'\"") {
			// Allow trailing/leading double quotes around an
			// identifier — already handled by Trim later.
			if strings.Trim(item, `"`) == item {
				return nil, false
			}
		}
		// Strip an optional alias / table prefix — we do not record
		// table.col here because the FROM clause names exactly one
		// table and we tag every column with that table.
		if dot := strings.IndexByte(item, '.'); dot >= 0 {
			item = item[dot+1:]
		}
		item = strings.Trim(item, `"`)
		if !looksLikeIdentifier(item) {
			return nil, false
		}
		cols = append(cols, item)
	}
	if len(cols) == 0 {
		return nil, false
	}
	return cols, true
}

// indexAliasKeyword returns the byte index of the standalone "AS"
// keyword (case-insensitive) within s, or -1 when none. Naive
// whitespace-bounded scan is sufficient for SELECT projection items.
func indexAliasKeyword(s string) int {
	upper := strings.ToUpper(s)
	for i := 0; i+2 < len(upper); i++ {
		if upper[i:i+2] == "AS" {
			// Word-boundary on both sides.
			if i > 0 && !isSpaceByte(upper[i-1]) {
				continue
			}
			if i+2 < len(upper) && !isSpaceByte(upper[i+2]) {
				continue
			}
			return i
		}
	}
	return -1
}

func isSpaceByte(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r':
		return true
	}
	return false
}
