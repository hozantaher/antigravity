package sqlcols

import (
	"fmt"
	"sort"
	"strings"
)

// Violation is a single column reference that does not resolve against
// the migration-derived schema.
type Violation struct {
	// File is the absolute path to the source file containing the
	// offending SQL fragment.
	File string
	// Line is the 1-based source line number where the SQL string
	// literal opens.
	Line int
	// Table is the name of the table parsed out of the SQL fragment.
	Table string
	// Column is the missing-or-misnamed column reference.
	Column string
	// Origin records the SQL shape we matched (e.g. "UPDATE foo SET").
	// Useful when triaging.
	Origin string
	// Kind is one of:
	//   "unknown_table"  — table not declared by any migration
	//   "unknown_column" — table is known but column is missing
	Kind string
}

// String renders the violation in `<file>:<line>: <table>.<col> (origin) — <kind>`
// form. Stable across runs so test logs grep cleanly.
func (v Violation) String() string {
	return fmt.Sprintf("%s:%d: %s.%s (%s) — %s",
		v.File, v.Line, v.Table, v.Column, v.Origin, v.Kind)
}

// ScanConfig narrows the scope of a Scan call. All paths are
// absolute; callers usually derive them from a repo-root walk.
type ScanConfig struct {
	// MigrationsDir holds the .sql files whose DDL forms the schema
	// of record. Required.
	MigrationsDir string
	// GoRoots are directories searched recursively for .go files
	// containing SQL string literals. Optional; nil = no Go scan.
	GoRoots []string
	// JSRoots are directories searched recursively for .js / .mjs /
	// .cjs files. Optional; nil = no JS scan.
	JSRoots []string
	// JSFiles lists individual JS files to scan in addition to
	// JSRoots. Useful for targeting a single file (e.g. server.js).
	JSFiles []string
	// IgnoreUnknownTables, when true, suppresses unknown_table
	// violations. Set on the first run while the migration corpus
	// is incomplete or while the scanner is being rolled out.
	IgnoreUnknownTables bool
	// IgnoreTables suppresses unknown_table AND unknown_column
	// violations for these specific table names. Use when a table is
	// declared by a migration the scanner doesn't yet recognise (e.g.
	// CREATE TABLE inside a DO $$ ... $$ block). Case-insensitive.
	IgnoreTables []string
}

// Scan walks the configured roots, extracts SQL string literals,
// pulls out (table, column) references, and returns a deterministic,
// sorted slice of violations. Sites covered by a `migration-allowed`
// annotation are excluded.
func Scan(cfg ScanConfig) ([]Violation, error) {
	schema, err := LoadSchemaFromMigrations(cfg.MigrationsDir)
	if err != nil {
		return nil, fmt.Errorf("load migrations: %w", err)
	}
	ignored := map[string]bool{}
	for _, t := range cfg.IgnoreTables {
		ignored[strings.ToLower(t)] = true
	}

	var violations []Violation

	for _, root := range cfg.GoRoots {
		sites, err := extractGoSQLLiterals(root)
		if err != nil {
			return nil, fmt.Errorf("extract Go SQL in %s: %w", root, err)
		}
		for _, site := range sites {
			if site.Allowed {
				continue
			}
			violations = append(violations, checkSQL(site.File, site.Line, site.SQL, schema, cfg, ignored)...)
		}
	}

	jsSites, err := scanJSRoots(cfg)
	if err != nil {
		return nil, err
	}
	for _, site := range jsSites {
		if site.Allowed {
			continue
		}
		violations = append(violations, checkSQL(site.File, site.Line, site.SQL, schema, cfg, ignored)...)
	}

	sort.SliceStable(violations, func(i, j int) bool {
		if violations[i].File != violations[j].File {
			return violations[i].File < violations[j].File
		}
		if violations[i].Line != violations[j].Line {
			return violations[i].Line < violations[j].Line
		}
		if violations[i].Table != violations[j].Table {
			return violations[i].Table < violations[j].Table
		}
		return violations[i].Column < violations[j].Column
	})
	return violations, nil
}

// scanJSRoots gathers JS sites from both JSRoots (recursive) and the
// individual JSFiles list. We treat a single-file entry as a one-shot
// walk by handing it to the recursive scanner with the file's parent —
// no, that would over-scan; instead we scan the file directly.
func scanJSRoots(cfg ScanConfig) ([]jsCallSite, error) {
	var out []jsCallSite
	for _, root := range cfg.JSRoots {
		sites, err := extractJSSQLLiterals(root)
		if err != nil {
			return nil, fmt.Errorf("extract JS SQL in %s: %w", root, err)
		}
		out = append(out, sites...)
	}
	for _, file := range cfg.JSFiles {
		sites, err := scanJSFile(file)
		if err != nil {
			return nil, fmt.Errorf("scan JS file %s: %w", file, err)
		}
		out = append(out, sites...)
	}
	return out, nil
}

// checkSQL turns one SQL fragment into zero or more violations against
// the schema. Deduplicates within the fragment so a SELECT that names
// the same column twice (rare but possible) only emits one record.
func checkSQL(file string, line int, sql string, schema *Schema, cfg ScanConfig, ignored map[string]bool) []Violation {
	refs := ExtractColumnRefs(sql)
	if len(refs) == 0 {
		return nil
	}
	seen := map[string]bool{}
	var out []Violation
	for _, ref := range refs {
		key := strings.ToLower(ref.Table) + "." + strings.ToLower(ref.Column) + "|" + ref.Origin
		if seen[key] {
			continue
		}
		seen[key] = true
		tlow := strings.ToLower(ref.Table)
		if ignored[tlow] {
			continue
		}
		if schema.HasView(ref.Table) {
			continue
		}
		if !schema.HasTable(ref.Table) {
			if cfg.IgnoreUnknownTables {
				continue
			}
			out = append(out, Violation{
				File:   file,
				Line:   line,
				Table:  ref.Table,
				Column: ref.Column,
				Origin: ref.Origin,
				Kind:   "unknown_table",
			})
			continue
		}
		if schema.HasColumn(ref.Table, ref.Column) {
			continue
		}
		out = append(out, Violation{
			File:   file,
			Line:   line,
			Table:  ref.Table,
			Column: ref.Column,
			Origin: ref.Origin,
			Kind:   "unknown_column",
		})
	}
	return out
}
