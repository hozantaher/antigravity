// Package sqlcols provides a static-analysis ratchet that cross-checks
// the columns referenced by Go and JavaScript SQL queries against the
// schema declared by the SQL files in scripts/migrations/.
//
// Goal: catch the class of bugs that surfaced repeatedly during the
// 2026-05 campaign 457 launch attempts:
//
//   - services/campaigns/sender/dedup_guard.go SELECTed contacts.parent_ico,
//     but no migration ever added that column. PROD threw
//     `column "parent_ico" does not exist`. Fixed in 091.
//   - apps/outreach-dashboard/src/lib/campaign-send-batch.js UPDATEd
//     campaign_contacts.updated_at on six call sites; no migration ever
//     added that column. PROD threw the same kind of error. Fixed in 092.
//   - 049_dedup_guard.sql was authored in an earlier PR but never
//     applied to PROD (no row in operator_audit_log), so dedup_guard ran
//     against a stale schema for ~12 hours.
//
// Pattern: HARD memory rule feedback_migration_apply_immediately —
// migrations must be applied + verified at author time, not just merged.
// This ratchet enforces the static half (code references match the
// declared schema) so the next regression of this shape is caught at
// `go test`, not at first PROD send.
package sqlcols

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Schema is the set of (table, column) pairs declared by the migration
// files in scripts/migrations/. Lookup is case-insensitive on both
// sides — PostgreSQL folds unquoted identifiers to lower case.
//
// Tables holds the set of CREATE-d table names; UnknownTable lookups can
// be distinguished from UnknownColumn lookups in a known table.
type Schema struct {
	// columns[table][column] = true. Both keys are lowercased.
	columns map[string]map[string]bool
	// tables records every CREATE TABLE / CREATE TABLE IF NOT EXISTS
	// declaration. Entries are lowercased.
	tables map[string]bool
	// views records every CREATE VIEW / CREATE MATERIALIZED VIEW. The
	// audit treats views as opaque (column refs against a view are
	// neither verified nor flagged) because we don't parse SELECT lists.
	views map[string]bool
}

// HasTable returns true when the named table was created by some
// migration. Match is case-insensitive.
func (s *Schema) HasTable(table string) bool {
	if s == nil {
		return false
	}
	return s.tables[strings.ToLower(table)]
}

// HasView returns true when the named view exists in the migrations.
func (s *Schema) HasView(name string) bool {
	if s == nil {
		return false
	}
	return s.views[strings.ToLower(name)]
}

// HasColumn returns true when the (table, column) pair was declared by
// some migration. Match is case-insensitive on both sides.
func (s *Schema) HasColumn(table, column string) bool {
	if s == nil {
		return false
	}
	cols, ok := s.columns[strings.ToLower(table)]
	if !ok {
		return false
	}
	return cols[strings.ToLower(column)]
}

// Tables returns a sorted slice of every declared table name. Useful
// for diagnostic output when a column reference fails to resolve.
func (s *Schema) Tables() []string {
	if s == nil {
		return nil
	}
	out := make([]string, 0, len(s.tables))
	for t := range s.tables {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// LoadSchemaFromMigrations parses every .sql file under dir (sorted by
// name so re-runs are deterministic) and returns the aggregated Schema.
// Empty dir → empty schema (no error).
func LoadSchemaFromMigrations(dir string) (*Schema, error) {
	s := &Schema{
		columns: map[string]map[string]bool{},
		tables:  map[string]bool{},
		views:   map[string]bool{},
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	files := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		files = append(files, filepath.Join(dir, e.Name()))
	}
	sort.Strings(files)
	for _, f := range files {
		if err := s.absorbFile(f); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// absorbFile reads a single .sql file and merges its DDL into the
// schema. Best-effort: we do not implement a full SQL parser. We
// recognise the DDL shapes that this codebase actually uses.
func (s *Schema) absorbFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	// Read the whole file — migrations are small (< 200 lines typical).
	var buf strings.Builder
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		// Strip line comments — `--` to end-of-line.
		line := scanner.Text()
		if i := strings.Index(line, "--"); i >= 0 {
			line = line[:i]
		}
		buf.WriteString(line)
		buf.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	content := stripBlockComments(buf.String())

	s.absorbCreateTable(content)
	s.absorbCreateView(content)
	s.absorbAlterTableAddColumn(content)
	return nil
}

// stripBlockComments removes /* ... */ comments. SQL block comments do
// not nest in PostgreSQL DDL we care about, so a non-greedy match is
// sufficient.
func stripBlockComments(s string) string {
	for {
		i := strings.Index(s, "/*")
		if i < 0 {
			return s
		}
		j := strings.Index(s[i:], "*/")
		if j < 0 {
			return s[:i]
		}
		s = s[:i] + s[i+j+2:]
	}
}

// reCreateTable matches `CREATE TABLE [IF NOT EXISTS] <name> (` and
// captures the table name. Schema-qualified names (e.g. public.foo) are
// captured whole and split downstream.
var reCreateTable = regexp.MustCompile(
	`(?is)CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*\(`,
)

// reCreateView matches `CREATE [OR REPLACE] [MATERIALIZED] VIEW
// [IF NOT EXISTS] <name>` so view-target column refs aren't flagged.
var reCreateView = regexp.MustCompile(
	`(?is)CREATE(?:\s+OR\s+REPLACE)?(?:\s+MATERIALIZED)?\s+VIEW(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_.]*)\b`,
)

// reAlterTableAddColumn matches the very common
// `ALTER TABLE <name> ADD COLUMN [IF NOT EXISTS] <col> <type>` form.
// It does NOT try to handle the rarer multi-add form (`ADD COLUMN a,
// ADD COLUMN b`) — those are still picked up because each clause
// repeats the keyword.
var reAlterTableAddColumn = regexp.MustCompile(
	`(?is)ALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:ONLY\s+)?` +
		`([a-zA-Z_][a-zA-Z0-9_.]*)` +
		`[\s\S]*?ADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+` +
		`([a-zA-Z_][a-zA-Z0-9_]*)`,
)

func (s *Schema) absorbCreateTable(content string) {
	for _, m := range reCreateTable.FindAllStringSubmatchIndex(content, -1) {
		name := strings.ToLower(unqualify(content[m[2]:m[3]]))
		s.tables[name] = true
		// Find the matching closing paren to slice out the column list.
		open := m[3]
		// Advance past the captured "(".
		// reCreateTable guarantees an "(" at content[m[1]-1]
		bodyStart := m[1] // position right after `(`
		body, ok := sliceBalancedParens(content, bodyStart-1)
		if !ok {
			_ = open
			continue
		}
		s.absorbColumnList(name, body)
	}
}

func (s *Schema) absorbCreateView(content string) {
	for _, m := range reCreateView.FindAllStringSubmatch(content, -1) {
		s.views[strings.ToLower(unqualify(m[1]))] = true
	}
}

func (s *Schema) absorbAlterTableAddColumn(content string) {
	for _, m := range reAlterTableAddColumn.FindAllStringSubmatch(content, -1) {
		table := strings.ToLower(unqualify(m[1]))
		col := strings.ToLower(m[2])
		if s.columns[table] == nil {
			s.columns[table] = map[string]bool{}
		}
		s.columns[table][col] = true
		// ALTER TABLE adds to a (possibly externally-declared) table.
		// Mark it as known so column refs against tables created in
		// some unrecognised dialect aren't dropped on the floor.
		s.tables[table] = true
	}
}

// sliceBalancedParens returns the inner text of a parenthesised group
// starting at start (which must point at the opening "("). The result
// excludes the parentheses themselves. Returns ok=false if no matching
// close paren is found.
func sliceBalancedParens(s string, start int) (string, bool) {
	if start >= len(s) || s[start] != '(' {
		return "", false
	}
	depth := 0
	inSingle := false
	inDouble := false
	for i := start; i < len(s); i++ {
		c := s[i]
		switch {
		case inSingle:
			if c == '\'' {
				// Handle '' escape.
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
				depth--
				if depth == 0 {
					return s[start+1 : i], true
				}
			}
		}
	}
	return "", false
}

// unqualify strips a leading "schema." prefix so "public.contacts"
// becomes "contacts". This matches how the rest of the codebase
// references tables by their unqualified name.
func unqualify(name string) string {
	if i := strings.LastIndexByte(name, '.'); i >= 0 {
		return name[i+1:]
	}
	return name
}

// absorbColumnList parses the body of a CREATE TABLE column list and
// records each top-level column name into the schema. Constraint
// keywords (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK, CONSTRAINT, LIKE,
// EXCLUDE) are skipped.
//
// We split at top-level commas (depth 0 only) so functions and
// expression defaults like `DEFAULT now() + interval '1 day'` don't
// fool the splitter.
func (s *Schema) absorbColumnList(table, body string) {
	if s.columns[table] == nil {
		s.columns[table] = map[string]bool{}
	}
	for _, item := range splitTopLevelCommas(body) {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		// First token decides whether this is a constraint declaration
		// or a column declaration.
		fields := strings.Fields(item)
		if len(fields) == 0 {
			continue
		}
		head := strings.ToUpper(fields[0])
		switch head {
		case "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT", "EXCLUDE", "LIKE":
			continue
		}
		// PostgreSQL allows quoted identifiers; strip the quotes.
		col := strings.Trim(fields[0], `"`)
		if col == "" {
			continue
		}
		// Reject identifiers that look like keywords slipping through.
		if !looksLikeIdentifier(col) {
			continue
		}
		s.columns[table][strings.ToLower(col)] = true
	}
}

// splitTopLevelCommas splits s at commas that are at parentheses depth
// 0 and not inside a single- or double-quoted string. Used to walk
// CREATE TABLE column lists.
func splitTopLevelCommas(s string) []string {
	var out []string
	depth := 0
	inSingle := false
	inDouble := false
	start := 0
	for i := 0; i < len(s); i++ {
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
			case ',':
				if depth == 0 {
					out = append(out, s[start:i])
					start = i + 1
				}
			}
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

// looksLikeIdentifier returns true when s is a plausible bare SQL
// identifier (letter or underscore start, then letters/digits/_).
func looksLikeIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		if i == 0 {
			if !(r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')) {
				return false
			}
			continue
		}
		if !(r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}
